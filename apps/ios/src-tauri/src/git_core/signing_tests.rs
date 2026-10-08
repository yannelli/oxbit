use super::tests::Fixture;
use super::*;
use std::process::Command;
use tauri_plugin_oxbit_files::CommitSigner;

fn signed_fixture(seed: bool) -> Fixture {
    let mut fixture = Fixture::new(seed);
    fixture.credentials.signer =
        Some(CommitSigner::generate("Repository User", "repo@example.test").unwrap());
    fixture
}

fn verify(fixture: &Fixture, commit: &str) {
    let repo = fixture.repo();
    let (signature, data) = repo
        .extract_signature(&Oid::from_str(commit).unwrap(), None)
        .unwrap();
    let signer = fixture.credentials.signer.as_ref().unwrap();
    signer.verify(&data, signature.as_str().unwrap()).unwrap();
}

#[test]
fn creates_signed_commits_that_verify_and_advance_the_branch() {
    let fixture = signed_fixture(false);
    fixture.write("file.txt", "first\n");
    let first = fixture.commit("First signed commit");
    let repo = fixture.repo();
    assert_eq!(
        repo.find_reference("refs/heads/main").unwrap().target(),
        Some(Oid::from_str(&first).unwrap())
    );
    verify(&fixture, &first);

    fixture.write("file.txt", "second\n");
    let second = fixture.commit("Second signed commit");
    verify(&fixture, &second);
    let head = repo.head().unwrap();
    assert_eq!(head.name().ok(), Some("refs/heads/main"));
    let commit = head.peel_to_commit().unwrap();
    assert_eq!(commit.id().to_string(), second);
    assert_eq!(commit.parent_id(0).unwrap().to_string(), first);
    assert_eq!(commit.author().email().ok(), Some("repo@example.test"));
    let reflog = repo.reflog("refs/heads/main").unwrap();
    assert_eq!(
        reflog.get(0).unwrap().message().unwrap(),
        Some("commit: Second signed commit")
    );
    assert_eq!(
        reflog.get(1).unwrap().message().unwrap(),
        Some("commit (initial): First signed commit")
    );
}

#[test]
fn signs_commits_on_a_detached_head_and_cherry_picks() {
    let fixture = signed_fixture(true);
    let repo = fixture.repo();
    let base = repo.head().unwrap().target().unwrap();
    fixture
        .run("branchCreate", json!({"name": "other"}))
        .unwrap();
    fixture.write("new.txt", "new\n");
    let picked = fixture.commit("Add new");
    fixture.run("checkout", json!({"branch": "main"})).unwrap();
    fixture
        .run("cherryPick", json!({"ref": picked, "confirm": true}))
        .unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_id(0).unwrap(), base);
    verify(&fixture, &head.id().to_string());

    repo.set_head_detached(base).unwrap();
    fixture.write("file.txt", "detached\n");
    let detached = fixture.commit("Detached commit");
    verify(&fixture, &detached);
    assert!(repo.head_detached().unwrap());
    assert_eq!(repo.head().unwrap().target().unwrap().to_string(), detached);
    assert_eq!(
        repo.find_reference("refs/heads/main").unwrap().target(),
        Some(head.id())
    );
}

#[test]
fn loads_the_signing_key_only_for_commit_methods() {
    for method in [
        "commit",
        "git.commit",
        "merge",
        "cherryPick",
        "revert",
        "continue",
    ] {
        assert!(creates_commit(method), "{method}");
    }
    for method in ["status", "abort", "stashSave", "push", "log"] {
        assert!(!creates_commit(method), "{method}");
    }
}

fn gpg(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new("gpg")
        .env("GNUPGHOME", home)
        .args([
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "fixture passphrase",
        ])
        .args(args)
        .output()
        .unwrap()
}

/// Imports `public` into a fresh GnuPG home and runs `git verify-commit --raw`.
fn git_verify_commit(fixture: &Fixture, public: &str, commit: &str) {
    let home = std::env::temp_dir().join(format!(
        "oxbit-gpg-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    fs::create_dir(&home).unwrap();
    let key = home.join("public.asc");
    fs::write(&key, public).unwrap();
    assert!(gpg(&home, &["--import", key.to_str().unwrap()])
        .status
        .success());
    let output = Command::new("git")
        .env("GNUPGHOME", &home)
        .arg("-C")
        .arg(&fixture.root.path)
        .args(["verify-commit", "--raw", commit])
        .output()
        .unwrap();
    let _ = Command::new("gpgconf")
        .env("GNUPGHOME", &home)
        .args(["--kill", "gpg-agent"])
        .status();
    let _ = fs::remove_dir_all(&home);
    let status = String::from_utf8_lossy(&output.stderr);
    println!("git verify-commit {commit}: exit {}", output.status);
    for line in status.lines().filter(|line| line.contains("SIG ")) {
        println!("  {line}");
    }
    assert!(output.status.success() && status.contains("[GNUPG:] GOODSIG"));
}

#[test]
fn signed_commits_pass_git_verify_commit() {
    if Command::new("gpg").arg("--version").output().is_err() {
        println!("skipped: gpg is not on PATH");
        return;
    }
    let fixture = signed_fixture(true);
    fixture.write("file.txt", "verified\n");
    let commit = fixture.commit("Verified by GnuPG");
    let metadata = fixture
        .credentials
        .signer
        .as_ref()
        .unwrap()
        .metadata()
        .unwrap();
    git_verify_commit(&fixture, metadata["publicKey"].as_str().unwrap(), &commit);

    let home = std::env::temp_dir().join(format!(
        "oxbit-gpg-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    fs::create_dir(&home).unwrap();
    let user = "Subkey Author <subkey@example.test>";
    assert!(gpg(
        &home,
        &["--quick-gen-key", user, "ed25519", "cert", "never"]
    )
    .status
    .success());
    let listing =
        String::from_utf8(gpg(&home, &["--with-colons", "--list-keys", user]).stdout).unwrap();
    let fingerprint = listing
        .lines()
        .find_map(|line| line.strip_prefix("fpr:").map(|rest| rest.trim_matches(':')))
        .unwrap()
        .to_owned();
    assert!(gpg(
        &home,
        &["--quick-add-key", &fingerprint, "ed25519", "sign", "never"]
    )
    .status
    .success());
    let secret =
        String::from_utf8(gpg(&home, &["--armor", "--export-secret-keys", user]).stdout).unwrap();
    let _ = Command::new("gpgconf")
        .env("GNUPGHOME", &home)
        .args(["--kill", "gpg-agent"])
        .status();
    let _ = fs::remove_dir_all(&home);

    let mut fixture = Fixture::new(true);
    assert!(CommitSigner::import(&secret, None).is_err());
    let signer = CommitSigner::import(&secret, Some("fixture passphrase")).unwrap();
    let public = signer.metadata().unwrap()["publicKey"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.credentials.signer = Some(signer);
    fixture.write("file.txt", "subkey\n");
    let commit = fixture.commit("Signed by a GnuPG subkey");
    verify(&fixture, &commit);
    git_verify_commit(&fixture, &public, &commit);
}
