//! Polling watcher per open root. iOS offers no cheap recursive change notifications for
//! security-scoped folders, so the thread compares modification times and sizes every 2 s.
use crate::fs_core::{Result, Root, Snapshot};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime};

pub const INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Watchers {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Watchers {
    pub fn start<R: Runtime>(&self, app: AppHandle<R>, root: Root) -> Result<()> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(&root.id) {
            return Ok(());
        }
        let stop = Arc::new(AtomicBool::new(false));
        active.insert(root.id.clone(), stop.clone());
        thread::spawn(move || {
            let event = format!("ios-fs-change:{}", root.id);
            let error_event = format!("ios-fs-watch-error:{}", root.id);
            let mut previous: Option<Snapshot> = root.snapshot().ok();
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(INTERVAL);
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match root.snapshot() {
                    Ok(next) => {
                        if let Some(before) = &previous {
                            for change in before.changes(&next) {
                                let _ = app.emit(&event, change);
                            }
                        }
                        previous = Some(next);
                    }
                    Err(error) => {
                        let _ = app.emit(&error_event, error.message);
                        previous = None;
                    }
                }
            }
        });
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        if let Some(stop) = self.active.lock().unwrap().remove(id) {
            stop.store(true, Ordering::Relaxed);
        }
    }
}
