use crate::fs_core::{Error, Result};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

const MAX_TOMBSTONES: usize = 256;
const TOMBSTONE_LIFETIME: Duration = Duration::from_secs(60);
const MAX_PENDING: usize = 256;
type RequestKey = (String, String);

#[derive(Default, Clone)]
pub struct Operations {
    registry: Arc<Registry>,
}

#[derive(Default)]
struct Registry {
    state: Mutex<RegistryState>,
    finished: Condvar,
}

#[derive(Default)]
struct RegistryState {
    roots: HashMap<String, RootQueue>,
    pending: HashMap<RequestKey, Pending>,
    tombstones: VecDeque<(RequestKey, Instant)>,
}

#[derive(Default)]
struct RootQueue {
    serial: Arc<Mutex<()>>,
    closed: bool,
}

struct Pending {
    cancel: Arc<AtomicBool>,
    serial: Arc<Mutex<()>>,
}

pub struct Operation {
    registry: Arc<Registry>,
    key: RequestKey,
    cancel: Arc<AtomicBool>,
    serial: Arc<Mutex<()>>,
}

pub struct Drain {
    registry: Arc<Registry>,
    root: String,
    serial: Arc<Mutex<()>>,
}

impl Registry {
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl RegistryState {
    fn prune_tombstones(&mut self) {
        while self
            .tombstones
            .front()
            .is_some_and(|(_, created)| created.elapsed() >= TOMBSTONE_LIFETIME)
        {
            self.tombstones.pop_front();
        }
    }
}

impl Operations {
    pub fn open_root(&self, root: &str) -> Result<()> {
        let mut state = self.registry.lock();
        if let Some(queue) = state.roots.get(root) {
            if !queue.closed {
                return Ok(());
            }
            if state.pending.keys().any(|(id, _)| id == root) {
                return Err(Error::new("ROOT_CLOSED", "Workspace root is still closing"));
            }
        }
        state.roots.insert(root.to_owned(), RootQueue::default());
        state.tombstones.retain(|((id, _), _)| id != root);
        Ok(())
    }

    pub fn register(&self, root: &str, request: &str) -> Result<Operation> {
        let key = (root.to_owned(), request.to_owned());
        let mut state = self.registry.lock();
        state.prune_tombstones();
        if state.pending.contains_key(&key) {
            return Err(Error::invalid("Git request is already pending"));
        }
        if state.pending.len() >= MAX_PENDING {
            return Err(Error::new("BUSY", "Too many pending Git operations"));
        }
        let queue = state.roots.entry(root.to_owned()).or_default();
        if queue.closed {
            return Err(Error::new("ROOT_CLOSED", "Workspace root is closing"));
        }
        let serial = queue.serial.clone();
        let tombstone = state
            .tombstones
            .iter()
            .position(|(cancelled, _)| cancelled == &key);
        let cancel = Arc::new(AtomicBool::new(tombstone.is_some()));
        if let Some(index) = tombstone {
            state.tombstones.remove(index);
        }
        state.pending.insert(
            key.clone(),
            Pending {
                cancel: cancel.clone(),
                serial: serial.clone(),
            },
        );
        Ok(Operation {
            registry: self.registry.clone(),
            key,
            cancel,
            serial,
        })
    }

    pub fn cancel(&self, root: &str, request: &str) -> Result<()> {
        let key = (root.to_owned(), request.to_owned());
        let mut state = self.registry.lock();
        if let Some(pending) = state.pending.get(&key) {
            pending.cancel.store(true, Ordering::Release);
            return Ok(());
        }
        if state.roots.get(root).is_some_and(|queue| queue.closed) {
            return Ok(());
        }
        state.prune_tombstones();
        state.tombstones.retain(|(cancelled, _)| cancelled != &key);
        if state.tombstones.len() >= MAX_TOMBSTONES {
            state.tombstones.pop_front();
        }
        state.tombstones.push_back((key, Instant::now()));
        Ok(())
    }

    pub fn close_root(&self, root: &str) -> Result<Drain> {
        let mut state = self.registry.lock();
        let queue = state.roots.entry(root.to_owned()).or_default();
        queue.closed = true;
        let serial = queue.serial.clone();
        for ((id, _), pending) in &state.pending {
            if id == root {
                pending.cancel.store(true, Ordering::Release);
            }
        }
        state.tombstones.retain(|((id, _), _)| id != root);
        Ok(Drain {
            registry: self.registry.clone(),
            root: root.to_owned(),
            serial,
        })
    }
}

impl Operation {
    pub fn lock(&self) -> MutexGuard<'_, ()> {
        self.serial
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn cancellation(&self) -> &AtomicBool {
        &self.cancel
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        let mut state = self.registry.lock();
        if state
            .pending
            .get(&self.key)
            .is_some_and(|pending| Arc::ptr_eq(&pending.cancel, &self.cancel))
        {
            state.pending.remove(&self.key);
            self.registry.finished.notify_all();
        }
    }
}

impl Drain {
    pub fn wait(self) -> Result<()> {
        let mut state = self.registry.lock();
        while state.pending.iter().any(|((root, _), pending)| {
            root == &self.root && Arc::ptr_eq(&pending.serial, &self.serial)
        }) {
            state = self
                .registry
                .finished
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Operations, MAX_TOMBSTONES, TOMBSTONE_LIFETIME};
    use std::{
        panic::{catch_unwind, AssertUnwindSafe},
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn cancellation_is_scoped_to_root_and_request() {
        let operations = Operations::default();
        let first = operations.register("first", "same-request").unwrap();
        let second = operations.register("second", "same-request").unwrap();
        operations.cancel("first", "same-request").unwrap();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        operations.cancel("second", "another-request").unwrap();
        assert!(!second.is_cancelled());
    }

    #[test]
    fn duplicate_pending_requests_are_rejected() {
        let operations = Operations::default();
        let pending = operations.register("root", "request").unwrap();
        assert_eq!(
            operations.register("root", "request").err().unwrap().code,
            "INVALID_PARAMS"
        );
        drop(pending);
        assert!(operations.register("root", "request").is_ok());
    }

    #[test]
    fn cancellation_before_registration_is_consumed_once() {
        let operations = Operations::default();
        operations.cancel("first", "request").unwrap();
        let other_root = operations.register("second", "request").unwrap();
        assert!(!other_root.is_cancelled());
        let cancelled = operations.register("first", "request").unwrap();
        assert!(cancelled.is_cancelled());
        drop(cancelled);
        assert!(!operations
            .register("first", "request")
            .unwrap()
            .is_cancelled());
    }

    #[test]
    fn cancellation_tombstones_are_bounded_and_expire() {
        let operations = Operations::default();
        for index in 0..=MAX_TOMBSTONES {
            operations.cancel("root", &index.to_string()).unwrap();
        }
        assert_eq!(operations.registry.lock().tombstones.len(), MAX_TOMBSTONES);
        assert!(!operations.register("root", "0").unwrap().is_cancelled());
        let old = Instant::now() - TOMBSTONE_LIFETIME - Duration::from_secs(1);
        for (_, created) in &mut operations.registry.lock().tombstones {
            *created = old;
        }
        assert!(!operations.register("root", "1").unwrap().is_cancelled());
        assert!(operations.registry.lock().tombstones.is_empty());
    }

    #[test]
    fn panic_cleans_pending_registration() {
        let operations = Operations::default();
        let pending = operations.register("root", "request").unwrap();
        assert!(catch_unwind(AssertUnwindSafe(move || {
            let _lock = pending.lock();
            panic!("operation fixture");
        }))
        .is_err());
        let next = operations.register("root", "request").unwrap();
        let _lock = next.lock();
        assert_eq!(operations.registry.lock().pending.len(), 1);
    }

    #[test]
    fn root_mutexes_serialize_and_other_roots_are_independent() {
        let operations = Operations::default();
        let first = operations.register("root", "first").unwrap();
        let second = operations.register("root", "second").unwrap();
        let other = operations.register("other", "third").unwrap();
        assert!(Arc::ptr_eq(&first.serial, &second.serial));
        assert!(!Arc::ptr_eq(&first.serial, &other.serial));
        let _lock = first.lock();
        assert!(second.serial.try_lock().is_err());
        assert!(other.serial.try_lock().is_ok());
    }

    #[test]
    fn closure_cancels_requests_and_waits_for_cleanup() {
        let operations = Operations::default();
        let pending = operations.register("root", "request").unwrap();
        let other = operations.register("other", "request").unwrap();
        let drain = operations.close_root("root").unwrap();
        assert!(pending.is_cancelled());
        assert!(!other.is_cancelled());
        assert!(operations.register("root", "new").is_err());
        assert!(operations.open_root("root").is_err());
        let (sent, received) = mpsc::channel();
        let waiter = thread::spawn(move || {
            drain.wait().unwrap();
            sent.send(()).unwrap();
        });
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());
        drop(pending);
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        waiter.join().unwrap();
        operations.open_root("root").unwrap();
        assert!(!operations.register("root", "new").unwrap().is_cancelled());
    }

    #[test]
    fn opening_an_open_root_keeps_active_serialization() {
        let operations = Operations::default();
        operations.open_root("root").unwrap();
        let first = operations.register("root", "first").unwrap();
        operations.open_root("root").unwrap();
        let second = operations.register("root", "second").unwrap();
        assert!(Arc::ptr_eq(&first.serial, &second.serial));
    }

    #[test]
    fn old_drain_does_not_wait_for_reopened_root() {
        let operations = Operations::default();
        let pending = operations.register("root", "request").unwrap();
        let drain = operations.close_root("root").unwrap();
        drop(pending);
        operations.open_root("root").unwrap();
        let reopened = operations.register("root", "request").unwrap();
        drain.wait().unwrap();
        assert!(!reopened.is_cancelled());
    }
}
