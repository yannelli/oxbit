//! Reattaching to a remote runtime that outlived its exec channel under its keep-alive lease. The
//! PID must still run our `desktop.js` and `/api/health` must report the id recorded at launch.
use super::runtime_protocol::sh;

pub const REATTACHED: &str = "Reconnected to the running runtime.";

/// The server loopback port and health `id` of the runtime's first ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attach {
    pub port: u16,
    pub runtime_id: String,
}

/// Prints the process's command line, or nothing when the PID is gone.
pub fn alive_command(pid: u32) -> String {
    sh(&format!("ps -p {pid} -o args= 2>/dev/null"))
}

/// The same match as `stop_stale_command`: a `desktop.js` under the shared install layout.
pub fn ours(ps_args: &str) -> bool {
    let args = ps_args.trim();
    args.find("/.oxbit/remote/runtimes/")
        .is_some_and(|at| args[at..].contains("desktop.js"))
}

/// A launch is reattachable when it recorded a PID and an attach point.
pub fn candidate(pid: Option<u32>, attach: Option<&Attach>) -> Option<(u32, Attach)> {
    Some((pid?, attach?.clone()))
}

pub fn can_reattach(ps_args: &str, attach: &Attach, health_id: Option<&str>) -> bool {
    ours(ps_args) && health_id == Some(attach.runtime_id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARGS: &str = "/home/me/.oxbit/remote/runtimes/abc/bin/node /home/me/.oxbit/remote/runtimes/abc/desktop.js\n";

    fn attach() -> Attach {
        Attach {
            port: 4100,
            runtime_id: "runtime-0123".into(),
        }
    }

    #[test]
    fn checks_the_pid_without_killing_it() {
        let command = alive_command(42);
        assert!(command.starts_with("sh -c "));
        assert!(command.contains("ps -p 42 -o args="));
        assert!(!command.contains("kill"));
    }

    #[test]
    fn recognizes_only_our_runtime_process() {
        assert!(ours(ARGS));
        assert!(!ours(""));
        assert!(!ours("/usr/bin/node /srv/app/desktop.js"));
        assert!(!ours(
            "desktop.js /home/me/.oxbit/remote/runtimes/abc/bin/node"
        ));
    }

    #[test]
    fn tries_a_reattach_only_with_a_recorded_pid_and_attach_point() {
        assert_eq!(candidate(Some(7), Some(&attach())), Some((7, attach())));
        assert_eq!(candidate(None, Some(&attach())), None);
        assert_eq!(candidate(Some(7), None), None);
    }

    #[test]
    fn reattaches_only_to_the_same_live_runtime() {
        assert!(can_reattach(ARGS, &attach(), Some("runtime-0123")));
        assert!(!can_reattach(ARGS, &attach(), Some("runtime-4567")));
        assert!(!can_reattach(ARGS, &attach(), None));
        assert!(!can_reattach("", &attach(), Some("runtime-0123")));
        assert!(!can_reattach(
            "/usr/bin/python3 server.py",
            &attach(),
            Some("runtime-0123")
        ));
    }
}
