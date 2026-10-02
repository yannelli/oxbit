use super::tests::Fixture;
use super::*;
use std::os::unix::fs::symlink;

#[test]
fn rejects_file_paths_and_git_metadata_that_escape_the_workspace() {
    let fixture = Fixture::new(true);
    let outside = Fixture::new(true);
    symlink(&outside.root.path, fixture.root.path.join("escape")).unwrap();
    for method in ["stage", "unstage", "diff", "discard", "restore"] {
        assert_eq!(
            fixture
                .run(method, json!({"path": "escape/file.txt", "confirm": true}))
                .unwrap_err()
                .code,
            "PATH_DENIED"
        );
    }
    assert_eq!(
        fixture
            .run("stage", json!({"path": ".git/config"}))
            .unwrap_err()
            .code,
        "PATH_DENIED"
    );
    assert_eq!(
        fixture
            .run("diff", json!({"path": "/etc/passwd"}))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
    fs::remove_dir_all(fixture.root.path.join(".git/objects/pack")).unwrap();
    symlink(
        outside.root.path.join(".git/objects/pack"),
        fixture.root.path.join(".git/objects/pack"),
    )
    .unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap_err().code,
        "PATH_DENIED"
    );
}

#[test]
fn rejects_external_gitdirs_parent_discovery_and_nested_ref_symlinks() {
    let fixture = Fixture::new(true);
    let outside = Fixture::new(true);
    fs::remove_dir_all(fixture.root.path.join(".git")).unwrap();
    fs::write(
        fixture.root.path.join(".git"),
        format!("gitdir: {}\n", outside.root.path.join(".git").display()),
    )
    .unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap_err().code,
        "PATH_DENIED"
    );
    fs::remove_file(fixture.root.path.join(".git")).unwrap();
    fixture.run("init", json!({})).unwrap();
    let nested = fixture.root.path.join("nested");
    fs::create_dir(&nested).unwrap();
    let nested_root = Root {
        id: "nested".into(),
        name: "nested".into(),
        path: nested,
    };
    assert_eq!(
        dispatch(
            &nested_root,
            "git.status",
            &json!({}),
            &Credentials::default(),
            &AtomicBool::new(false),
            &|_| {}
        )
        .unwrap()["repository"],
        false
    );
    symlink(
        outside.root.path.join(".git/refs/heads"),
        fixture.root.path.join(".git/refs/heads/escape"),
    )
    .unwrap();
    assert_eq!(
        fixture
            .run("branchCreate", json!({"name": "escape/new"}))
            .unwrap_err()
            .code,
        "PATH_DENIED"
    );
}

#[test]
fn checks_all_staged_paths_before_staging_and_target_paths_before_checkout() {
    let fixture = Fixture::new(true);
    let outside = Fixture::new(true);
    fixture.write("folder/file.txt", "inside");
    fixture.commit("Folder");
    fs::remove_dir_all(fixture.root.path.join("folder")).unwrap();
    symlink(&outside.root.path, fixture.root.path.join("folder")).unwrap();
    assert_eq!(
        fixture.run("stageAll", json!({})).unwrap_err().code,
        "PATH_DENIED"
    );
    assert_eq!(
        fixture
            .run("checkout", json!({"branch": "main"}))
            .unwrap_err()
            .code,
        "PATH_DENIED"
    );
    assert_eq!(outside.content("file.txt"), "first\n");
}
