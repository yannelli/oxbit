//! One remote runtime: launches `desktop.js` on the server, waits for `ready`, and relaunches it
//! after the process or the SSH connection ends, within a budget so reconnects cannot loop.
use super::{
    runtime_frames::{self as frames, Frame, FrameReader},
    runtime_install::{self, exec, lost, Installed, Source},
    runtime_process::{
        heartbeat, Budget, Event, Events, Options, Process, Ready, Stdout, TaskForwards, Writer,
    },
    runtime_protocol as protocol,
    runtime_tunnel::{health, Tunnel},
    session::Pool,
};
use crate::fs_core::{Error, Result};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex};

pub const GAVE_UP: &str =
    "Oxbit stopped reconnecting to the server after repeated failures. Reconnect to retry.";

#[derive(Default)]
struct Launch {
    process: Option<Process>,
    ready: Option<Ready>,
    pid: Option<u32>,
    budget: Budget,
}

pub struct RemoteRuntime {
    pool: Arc<Pool>,
    source: Source,
    events: Events,
    options: Options,
    target: watch::Sender<Option<(String, u16)>>,
    pub tunnel: Tunnel,
    forwards: TaskForwards,
    launch: Mutex<Launch>,
    stopped: AtomicBool,
    myself: Weak<RemoteRuntime>,
}

impl RemoteRuntime {
    pub async fn open(
        pool: Arc<Pool>,
        source: Source,
        events: Events,
        options: Options,
    ) -> Result<Arc<Self>> {
        let (target, receiver) = watch::channel(None);
        let tunnel = Tunnel::open(pool.clone(), options.host_id.clone(), receiver).await?;
        Ok(Arc::new_cyclic(|myself| Self {
            pool,
            source,
            events,
            options,
            target,
            tunnel,
            forwards: TaskForwards::default(),
            launch: Mutex::default(),
            stopped: AtomicBool::new(false),
            myself: myself.clone(),
        }))
    }

    /// The running runtime, or a reconnect and relaunch. Automatic attempts share a budget of
    /// three per minute; a `user` attempt bypasses it and starts a new one.
    pub async fn ensure(&self, user: bool) -> Result<Ready> {
        let mut launch = self.launch.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return Err(Error::new(
                "REMOTE_RUNTIME",
                "This remote workspace is closed.",
            ));
        }
        if let (Some(process), Some(ready)) = (&launch.process, &launch.ready) {
            if process.alive.load(Ordering::SeqCst) {
                return Ok(ready.clone());
            }
        }
        if !launch.budget.admit(user, Instant::now()) {
            return Err(Error::new("REMOTE_RUNTIME", GAVE_UP));
        }
        let _ = self.target.send(None);
        if let Some(process) = launch.process.take() {
            process.close();
        }
        let result = self.relaunch(&mut launch).await;
        if let Err(error) = &result {
            (self.events)(Event::Failed {
                message: error.message.clone(),
            });
        }
        result
    }

    async fn relaunch(&self, launch: &mut Launch) -> Result<Ready> {
        let options = &self.options;
        let connection = self.pool.connection(&options.host_id).await?;
        if let Some(pid) = launch.pid.take() {
            let stop = protocol::stop_stale_command(pid);
            let _ = exec(&connection.handle, &stop, None, Duration::from_secs(10)).await;
        }
        let progress = |message: &str| {
            (self.events)(Event::Progress {
                message: message.into(),
            })
        };
        let Installed { digest, method } =
            runtime_install::install(&connection.handle, &self.source, &progress).await?;
        progress(runtime_install::STARTING);
        let channel = connection
            .handle
            .channel_open_session()
            .await
            .map_err(lost)?;
        channel
            .exec(true, protocol::launch_command(&digest))
            .await
            .map_err(lost)?;
        let (reader, writer) = channel.split();
        let writer: Writer = Arc::new(writer);
        let frame = frames::launch_frame(&options.root, &options.workspace_key, &options.token);
        writer.data(frame.as_bytes()).await.map_err(lost)?;
        let mut stdout = Stdout {
            reader,
            frames: FrameReader::default(),
            stderr: Vec::new(),
        };
        let waited = tokio::time::timeout(options.ready_timeout, async {
            loop {
                for frame in stdout.next(&options.workspace_key).await? {
                    match frame {
                        Frame::Ready { port, root, open_file } => return Ok((port, root, open_file)),
                        Frame::Error { message } => return Err(Error::new("REMOTE_RUNTIME", message)),
                        other => self.observe(other, &writer),
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| Err(Error::new(
            "REMOTE_RUNTIME",
            "Remote runtime startup timed out. Check the remote folder and operating system compatibility.",
        )));
        let (port, root, open_file) = match waited {
            Ok(ready) => ready,
            Err(error) => {
                let _ = writer.close().await;
                return Err(error);
            }
        };
        launch.pid = stdout.pid();
        health(&self.pool, &options.host_id, port).await?;
        let alive = Arc::new(AtomicBool::new(true));
        let tasks = vec![
            tokio::spawn(heartbeat(writer.clone(), alive.clone())),
            tokio::spawn(watch_process(
                self.myself.clone(),
                stdout,
                writer.clone(),
                alive.clone(),
            )),
        ];
        launch.process = Some(Process {
            writer,
            alive,
            tasks,
        });
        let ready = Ready {
            root,
            open_file,
            installed: Some(method),
        };
        launch.ready = Some(ready.clone());
        let _ = self.target.send(Some(("127.0.0.1".into(), port)));
        (self.events)(Event::Running);
        Ok(ready)
    }

    fn observe(&self, frame: Frame, writer: &Writer) {
        match frame {
            Frame::Progress { message } => (self.events)(Event::Progress { message }),
            Frame::TaskForward {
                request,
                host,
                port,
            } => {
                let (runtime, writer) = (self.myself.clone(), writer.clone());
                tokio::spawn(async move {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    let local = runtime
                        .forwards
                        .port(&runtime.pool, &runtime.options.host_id, &host, port)
                        .await
                        .ok();
                    let reply = frames::task_forwarded_frame(&request, local);
                    let _ = writer.data(reply.as_bytes()).await;
                });
            }
            _ => {}
        }
    }

    /// Relaunches with backoff after the process or connection ended, until the budget runs out.
    /// Boxed because it re-enters `ensure`, which spawns the task that calls it.
    fn revive(self: Arc<Self>) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            for delay in [1, 4, 10] {
                tokio::time::sleep(Duration::from_secs(delay)).await;
                if self.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let message = "Reconnecting to the remote workspace…".to_string();
                (self.events)(Event::Reconnecting { message });
                match self.ensure(false).await {
                    Ok(_) => return,
                    Err(error) if error.message == GAVE_UP => break,
                    Err(_) => {}
                }
            }
            if !self.stopped.load(Ordering::SeqCst) {
                let message = GAVE_UP.to_string();
                (self.events)(Event::Failed { message });
            }
        })
    }

    /// Asks the runtime to shut down, then closes its channel and every loopback listener.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.target.send(None);
        self.forwards.clear().await;
        let process = self.launch.lock().await.process.take();
        if let Some(process) = process {
            let _ = process.writer.data(frames::SHUTDOWN_FRAME.as_bytes()).await;
            let deadline = Instant::now() + Duration::from_millis(4500);
            while process.alive.load(Ordering::SeqCst) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            process.close();
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.tunnel.port)
    }

    pub fn token(&self) -> &str {
        &self.options.token
    }

    pub fn workspace_key(&self) -> &str {
        &self.options.workspace_key
    }

    #[cfg(test)]
    pub async fn pid(&self) -> Option<u32> {
        self.launch.lock().await.pid
    }
}

async fn watch_process(
    runtime: Weak<RemoteRuntime>,
    mut stdout: Stdout,
    writer: Writer,
    alive: Arc<AtomicBool>,
) {
    loop {
        let Some(current) = runtime.upgrade() else {
            return;
        };
        match stdout.next(&current.options.workspace_key).await {
            Ok(frames) => frames
                .into_iter()
                .for_each(|frame| current.observe(frame, &writer)),
            Err(_) => break,
        }
    }
    alive.store(false, Ordering::SeqCst);
    let _ = writer.close().await;
    let runtime = runtime
        .upgrade()
        .filter(|runtime| !runtime.stopped.load(Ordering::SeqCst));
    if let Some(runtime) = runtime {
        tokio::spawn(runtime.revive());
    }
}
