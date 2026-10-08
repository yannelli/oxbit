//! Live checks against the Docker sshd fixture. Run with `node scripts/ios/ssh-live.mjs`,
//! which starts the container and sets the `OXBIT_SSH_TEST_*` variables.
use super::{
    connect::{Credential, Outcome, Target},
    keys,
    known_hosts::KnownHosts,
    session::Pool,
    sftp, transfer,
};
use crate::fs_core::revision;
use std::{
    process::Command,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

fn env(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is required; run scripts/ios/ssh-live.mjs"))
}

fn docker(args: &[&str]) -> String {
    let output = Command::new("docker").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "docker {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn exec(container: &str, script: &str) -> String {
    docker(&["exec", container, "sh", "-c", script])
}

fn host_fingerprint(container: &str) -> String {
    exec(
        container,
        "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
    )
    .split_whitespace()
    .nth(1)
    .unwrap()
    .to_string()
}

async fn restart(container: &str, port: u16) {
    docker(&["restart", container]);
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(500)).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("sshd did not come back after restart");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Docker sshd fixture"]
async fn live_ssh_workspace() {
    let container = env("OXBIT_SSH_TEST_CONTAINER");
    let port: u16 = env("OXBIT_SSH_TEST_PORT").parse().unwrap();
    let password_port: u16 = env("OXBIT_SSH_TEST_PASSWORD_PORT").parse().unwrap();
    let key_text = std::fs::read_to_string(env("OXBIT_SSH_TEST_KEY")).unwrap();
    let imported =
        keys::import("Live", &key_text, Some(&env("OXBIT_SSH_TEST_PASSPHRASE"))).unwrap();
    let key = Arc::new(keys::decode(&imported.private_key).unwrap());
    let directory = std::env::temp_dir().join(format!("oxbit-ssh-live-{}", uuid::Uuid::new_v4()));
    let known = Arc::new(KnownHosts::new(directory.join("known_hosts.json")));
    let pool = Pool::new(known.clone());
    let target = Target {
        host_id: uuid::Uuid::new_v4().to_string(),
        hostname: "127.0.0.1".into(),
        port,
        username: "root".into(),
    };
    let credential = Credential::Key(key);

    let Outcome::HostUnknown { host_key } = pool
        .connect(target.clone(), credential.clone())
        .await
        .unwrap()
    else {
        panic!("an unknown host must ask for trust");
    };
    let original = host_fingerprint(&container);
    assert_eq!(host_key.fingerprint, original);
    assert_eq!(host_key.algorithm, "ssh-ed25519");
    println!(
        "PASS TOFU prompt {} {}",
        host_key.algorithm, host_key.fingerprint
    );
    known
        .trust(
            "127.0.0.1",
            port,
            &host_key.algorithm,
            &host_key.fingerprint,
        )
        .unwrap();
    let Outcome::Connected { home } = pool
        .connect(target.clone(), credential.clone())
        .await
        .unwrap()
    else {
        panic!("a trusted host must connect");
    };
    assert_eq!(home, "/root");
    println!("PASS key auth ({}) home {home}", imported.info.algorithm);

    let host = &target.host_id;
    let root = "/root/project".to_string();
    let c = pool.connection(host).await.unwrap();
    let listed = sftp::list(&c.sftp, &root, "").await.unwrap();
    assert!(listed
        .iter()
        .any(|entry| entry.path == "hello.ts" && entry.kind == "file"));
    let hello = sftp::read(&c.sftp, &root, "hello.ts").await.unwrap();
    assert_eq!(hello, b"export const message = \"hello\";\n");
    assert_eq!(
        sftp::read(&c.sftp, &root, "missing.ts")
            .await
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    let created = sftp::write(&c.sftp, &root, "notes.txt", b"one", None)
        .await
        .unwrap();
    assert_eq!(
        sftp::write(&c.sftp, &root, "notes.txt", b"two", None)
            .await
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        sftp::write(&c.sftp, &root, "notes.txt", b"two", Some("bad"))
            .await
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    exec(&container, "chmod 640 /root/project/notes.txt");
    sftp::write(&c.sftp, &root, "notes.txt", b"two", Some(&created.revision))
        .await
        .unwrap();
    assert_eq!(
        exec(
            &container,
            "cat /root/project/notes.txt; stat -c %a /root/project/notes.txt"
        ),
        "two640"
    );
    assert_eq!(
        exec(
            &container,
            "ls -a /root/project | grep -c oxbit-tmp || true"
        ),
        "0"
    );
    assert_eq!(
        sftp::write(&c.sftp, &root, "none/x.txt", b"x", None)
            .await
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    sftp::mkdir(&c.sftp, &root, "a/b").await.unwrap();
    sftp::rename(&c.sftp, &root, "notes.txt", "a/b/moved.txt")
        .await
        .unwrap();
    sftp::write(&c.sftp, &root, "other.txt", b"o", None)
        .await
        .unwrap();
    assert_eq!(
        sftp::rename(&c.sftp, &root, "other.txt", "a/b/moved.txt")
            .await
            .unwrap_err()
            .code,
        "EXISTS"
    );
    assert_eq!(
        sftp::read(&c.sftp, &root, "a/b/moved.txt").await.unwrap(),
        b"two"
    );
    sftp::delete(&c.sftp, &root, "a").await.unwrap();
    sftp::delete(&c.sftp, &root, "other.txt").await.unwrap();
    assert_eq!(
        exec(&container, "test -e /root/project/a && echo yes || echo no"),
        "no"
    );
    println!("PASS SFTP list/read/write/conflict/mkdir/rename/delete");

    let local = directory.join("device");
    std::fs::create_dir_all(&local).unwrap();
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(local.join("big.bin"), &big).unwrap();
    std::fs::write(local.join("small.txt"), b"small").unwrap();
    sftp::mkdir(&c.sftp, &root, "uploads").await.unwrap();
    let files = vec![local.join("big.bin"), local.join("small.txt")];
    let events = std::sync::Mutex::new(Vec::new());
    let never = AtomicBool::new(false);
    let summary = transfer::upload(&c.sftp, &root, "uploads", &files, &never, |p| {
        events.lock().unwrap().push(p)
    })
    .await
    .unwrap();
    assert_eq!((summary.files, summary.bytes), (2, 3_000_005));
    assert_eq!(
        events.lock().unwrap().last().unwrap().transferred,
        3_000_005
    );
    assert_eq!(
        exec(&container, "stat -c %s /root/project/uploads/big.bin"),
        "3000000"
    );
    assert_eq!(
        transfer::upload(&c.sftp, &root, "uploads", &files[1..], &never, |_| {})
            .await
            .unwrap_err()
            .code,
        "EXISTS"
    );
    let cancel = AtomicBool::new(false);
    std::fs::write(local.join("cancel.bin"), &big).unwrap();
    let cancelled = transfer::upload(
        &c.sftp,
        &root,
        "uploads",
        &[local.join("cancel.bin")],
        &cancel,
        |_| cancel.store(true, std::sync::atomic::Ordering::SeqCst),
    )
    .await;
    assert_eq!(cancelled.unwrap_err().code, "CANCELLED");
    assert_eq!(
        exec(&container, "ls -a /root/project/uploads | tr '\\n' ' '"),
        ". .. big.bin small.txt"
    );
    println!(
        "PASS upload 2 files {} bytes with progress, EXISTS refusal, cancel cleanup",
        summary.bytes
    );

    let received = directory.join("received");
    std::fs::create_dir_all(&received).unwrap();
    let folder = transfer::download(&c.sftp, &root, "uploads", &received, &never, |_| {})
        .await
        .unwrap();
    assert_eq!(folder.files, 2);
    assert_eq!(
        revision(&std::fs::read(received.join("uploads/big.bin")).unwrap()),
        revision(&big)
    );
    transfer::download(&c.sftp, &root, "hello.ts", &received, &never, |_| {})
        .await
        .unwrap();
    assert_eq!(std::fs::read(received.join("hello.ts")).unwrap(), hello);
    let stop = AtomicBool::new(true);
    std::fs::remove_dir_all(received.join("uploads")).unwrap();
    let stopped = transfer::download(&c.sftp, &root, "uploads", &received, &stop, |_| {}).await;
    assert_eq!(stopped.unwrap_err().code, "CANCELLED");
    let leftover: Vec<_> = std::fs::read_dir(&received)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftover, vec![std::ffi::OsString::from("hello.ts")]);
    sftp::delete(&c.sftp, &root, "uploads").await.unwrap();
    println!("PASS download folder and file, cancel cleanup");

    let password_target = Target {
        host_id: uuid::Uuid::new_v4().to_string(),
        port: password_port,
        ..target.clone()
    };
    let password = Credential::Password(env("OXBIT_SSH_TEST_PASSWORD"));
    let Outcome::HostUnknown {
        host_key: password_key,
    } = pool
        .connect(password_target.clone(), password.clone())
        .await
        .unwrap()
    else {
        panic!("the password port is a separate known-hosts entry");
    };
    known
        .trust(
            "127.0.0.1",
            password_port,
            &password_key.algorithm,
            &password_key.fingerprint,
        )
        .unwrap();
    assert!(matches!(
        pool.connect(password_target.clone(), password)
            .await
            .unwrap(),
        Outcome::Connected { .. }
    ));
    let wrong = Credential::Password("wrong".into());
    pool.disconnect(&password_target.host_id).await;
    assert_eq!(
        pool.connect(password_target, wrong)
            .await
            .err()
            .unwrap()
            .code,
        "AUTH_FAILED"
    );
    println!("PASS password auth and rejection");

    drop(c);
    let before = pool.connection(host).await.unwrap();
    restart(&container, port).await;
    let relisted = pool
        .run(host, |c| {
            let root = root.clone();
            async move { sftp::list(&c.sftp, &root, "").await }
        })
        .await
        .unwrap();
    let after = pool.connection(host).await.unwrap();
    assert!(relisted.iter().any(|entry| entry.path == "hello.ts"));
    assert!(!Arc::ptr_eq(&before, &after));
    println!("PASS reconnect after container restart");

    exec(
        &container,
        "rm /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null",
    );
    restart(&container, port).await;
    let refused = pool
        .run(
            host,
            |c| async move { sftp::list(&c.sftp, "/root", "").await },
        )
        .await;
    assert_eq!(refused.unwrap_err().code, "HOST_KEY_CHANGED");
    let Outcome::HostChanged {
        host_key: changed,
        known: saved,
    } = pool
        .connect(target.clone(), credential.clone())
        .await
        .unwrap()
    else {
        panic!("a changed host key must be refused");
    };
    let replaced = host_fingerprint(&container);
    assert_eq!(changed.fingerprint, replaced);
    assert_ne!(replaced, original);
    assert_eq!(saved[0].fingerprint, original);
    println!("PASS mismatch refused: saved {original} presented {replaced}");
    known.forget("127.0.0.1", port).unwrap();
    let Outcome::HostUnknown { host_key: fresh } =
        pool.connect(target.clone(), credential).await.unwrap()
    else {
        panic!("a forgotten host asks for trust again");
    };
    assert_eq!(fresh.fingerprint, replaced);
    println!("PASS forget saved host key returns to first-use prompt");
    std::fs::remove_dir_all(directory).unwrap();
}
