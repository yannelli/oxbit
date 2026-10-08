use super::*;

pub(super) struct Fixture {
    pub(super) root: Root,
    pub(super) credentials: Credentials,
}

impl Fixture {
    pub(super) fn new(seed: bool) -> Self {
        let path = std::env::temp_dir().join(format!("oxbit-native-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let mut roots = fs_core::Roots::default();
        let opened = roots.open(&path).unwrap();
        let root = roots.get(&opened.id).unwrap().clone();
        let fixture = Self {
            root,
            credentials: Credentials {
                login: None,
                token: None,
                name: Some("Saved User".into()),
                email: Some("saved@example.test".into()),
                gitea: None,
                signer: None,
            },
        };
        fixture.run("init", json!({})).unwrap();
        let repo = fixture.repo();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Repository User").unwrap();
        config.set_str("user.email", "repo@example.test").unwrap();
        if seed {
            fixture.write("file.txt", "first\n");
            fixture.commit("Initial commit\n\nDetailed body.");
        }
        fixture
    }

    pub(super) fn run(&self, method: &str, params: Value) -> Result<Value> {
        dispatch(
            &self.root,
            method,
            &params,
            &self.credentials,
            &AtomicBool::new(false),
            &|_| {},
        )
    }

    pub(super) fn repo(&self) -> Repository {
        Repository::open(&self.root.path).unwrap()
    }

    pub(super) fn write(&self, path: &str, content: &str) {
        let full = self.root.path.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }

    pub(super) fn commit(&self, message: &str) -> String {
        self.run("stageAll", json!({})).unwrap();
        self.run("commit", json!({"message": message})).unwrap()["commit"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    pub(super) fn content(&self, path: &str) -> String {
        fs::read_to_string(self.root.path.join(path)).unwrap()
    }

    pub(super) fn index_content(&self, path: &str) -> String {
        let repo = self.repo();
        let entry = repo.index().unwrap().get_path(Path::new(path), 0).unwrap();
        let blob = repo.find_blob(entry.id).unwrap();
        String::from_utf8(blob.content().to_vec()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root.path);
    }
}

#[test]
fn handles_unborn_and_missing_repositories_and_unstages_without_changing_disk() {
    let fixture = Fixture::new(false);
    assert_eq!(
        fixture.run("log", json!({})).unwrap(),
        json!({"commits": [], "hasMore": false})
    );
    let status = fixture.run("status", json!({})).unwrap();
    assert_eq!(status["branch"], "main");
    assert!(status.get("head").is_none());
    fixture.write("a.txt", "a");
    fixture.write("b.txt", "b");
    fixture.run("stageAll", json!({})).unwrap();
    fixture.write("a.txt", "newer");
    fixture.run("unstageAll", json!({})).unwrap();
    let status = fixture.run("status", json!({})).unwrap();
    assert!(status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|change| change["index"] == "?"));
    assert_eq!(fixture.content("a.txt"), "newer");
    fs::remove_dir_all(fixture.root.path.join(".git")).unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["repository"],
        false
    );
}

#[test]
fn stages_literal_paths_and_unstages_both_sides_of_a_rename() {
    let fixture = Fixture::new(true);
    fixture.write("*.txt", "literal");
    fixture.write("other.txt", "other");
    fixture.run("stage", json!({"path": "*.txt"})).unwrap();
    assert!(fixture
        .repo()
        .index()
        .unwrap()
        .get_path(Path::new("other.txt"), 0)
        .is_none());
    fs::rename(
        fixture.root.path.join("file.txt"),
        fixture.root.path.join("renamed.txt"),
    )
    .unwrap();
    fixture.run("stage", json!({"path": "file.txt"})).unwrap();
    fixture
        .run("stage", json!({"path": "renamed.txt"}))
        .unwrap();
    let status = fixture.run("status", json!({})).unwrap();
    let rename = status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["path"] == "renamed.txt")
        .unwrap();
    assert_eq!(rename["originalPath"], "file.txt");
    assert_eq!(
        fixture
            .run("diff", json!({"path": "renamed.txt", "staged": true}))
            .unwrap()["before"],
        "first\n"
    );
    fixture
        .run("unstage", json!({"path": "renamed.txt"}))
        .unwrap();
    let index = fixture.repo().index().unwrap();
    assert!(index.get_path(Path::new("renamed.txt"), 0).is_none());
    assert!(index.get_path(Path::new("file.txt"), 0).is_some());
    assert!(index.get_path(Path::new("*.txt"), 0).is_some());
    assert_eq!(
        fixture
            .run("stage", json!({"path": "../outside"}))
            .unwrap_err()
            .code,
        "PATH_DENIED"
    );
}

#[test]
fn stages_and_unstages_one_hunk_and_rejects_stale_snapshots() {
    let fixture = Fixture::new(true);
    let mut lines = (0..30)
        .map(|index| format!("line {index}"))
        .collect::<Vec<_>>();
    fixture.write("file.txt", &(lines.join("\n") + "\n"));
    fixture.commit("Lines");
    lines[1] = "first edit".into();
    lines[25] = "second edit".into();
    fixture.write("file.txt", &(lines.join("\n") + "\n"));
    let diff = fixture.run("diff", json!({"path": "file.txt"})).unwrap();
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 2);
    fixture
        .run(
            "hunk",
            json!({"path": "file.txt", "hunk": 0, "fingerprint": diff["fingerprint"]}),
        )
        .unwrap();
    assert!(fixture.index_content("file.txt").contains("first edit"));
    assert!(!fixture.index_content("file.txt").contains("second edit"));
    assert_eq!(
        fixture
            .run(
                "hunk",
                json!({"path": "file.txt", "hunk": 1, "fingerprint": diff["fingerprint"]})
            )
            .unwrap_err()
            .code,
        "STALE_STATE"
    );
    let staged = fixture
        .run("diff", json!({"path": "file.txt", "staged": true}))
        .unwrap();
    fixture.run("hunk", json!({"path": "file.txt", "staged": true, "hunk": 0, "fingerprint": staged["fingerprint"]})).unwrap();
    assert_eq!(
        fixture
            .run("diff", json!({"path": "file.txt", "staged": true}))
            .unwrap()["diff"],
        ""
    );
    assert!(fixture.content("file.txt").contains("second edit"));
}

#[test]
fn creates_renames_switches_and_deletes_merged_branches() {
    let fixture = Fixture::new(true);
    fixture
        .run("branchCreate", json!({"name": "feature/work"}))
        .unwrap();
    fixture
        .run(
            "branchRename",
            json!({"branch": "feature/work", "name": "feature/renamed"}),
        )
        .unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["branch"],
        "feature/renamed"
    );
    fixture.write("feature.txt", "feature");
    fixture.commit("Feature");
    fixture.run("checkout", json!({"branch": "main"})).unwrap();
    assert_eq!(
        fixture
            .run(
                "branchDelete",
                json!({"branch": "feature/renamed", "confirm": true})
            )
            .unwrap_err()
            .code,
        "GIT_FAILED"
    );
    fixture
        .run("merge", json!({"ref": "feature/renamed"}))
        .unwrap();
    fixture
        .run(
            "branchDelete",
            json!({"branch": "feature/renamed", "confirm": true}),
        )
        .unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["branches"],
        json!(["main"])
    );
    for name in ["--force", "@{-1}", "a..b", "refs/heads/surprise"] {
        assert_eq!(
            fixture
                .run("branchCreate", json!({"name": name}))
                .unwrap_err()
                .code,
            "INVALID_PARAMS"
        );
    }
}

#[test]
fn preserves_disk_changes_when_switching_would_overwrite_them() {
    let fixture = Fixture::new(true);
    fixture
        .run("branchCreate", json!({"name": "other"}))
        .unwrap();
    fixture.write("file.txt", "other\n");
    fixture.commit("Other");
    fixture.run("checkout", json!({"branch": "main"})).unwrap();
    fixture.write("file.txt", "disk changes\n");
    assert!(fixture.run("checkout", json!({"branch": "other"})).is_err());
    assert_eq!(fixture.content("file.txt"), "disk changes\n");
    assert_eq!(fixture.run("status", json!({})).unwrap()["branch"], "main");
}

#[test]
fn paginates_searches_and_previews_initial_renamed_deleted_history() {
    let fixture = Fixture::new(true);
    let initial = fixture.run("log", json!({})).unwrap()["commits"][0].clone();
    assert_eq!(initial["body"], "Detailed body.");
    assert_eq!(initial["parents"], json!([]));
    let preview = fixture
        .run(
            "commitDiff",
            json!({"ref": initial["id"], "path": "file.txt"}),
        )
        .unwrap();
    assert_eq!(preview["before"], "");
    assert_eq!(preview["after"], "first\n");
    fs::rename(
        fixture.root.path.join("file.txt"),
        fixture.root.path.join("new name.txt"),
    )
    .unwrap();
    let renamed = fixture.commit("Rename file");
    let show = fixture.run("show", json!({"ref": renamed})).unwrap();
    assert_eq!(show["files"][0]["originalPath"], "file.txt");
    assert!(show["files"][0]["status"]
        .as_str()
        .unwrap()
        .starts_with('R'));
    assert_eq!(
        fixture
            .run(
                "commitDiff",
                json!({"ref": renamed, "path": "new name.txt"})
            )
            .unwrap()["before"],
        "first\n"
    );
    fixture.write("next.txt", "next");
    fixture.commit("Next commit");
    assert_eq!(
        fixture.run("log", json!({"limit": 2})).unwrap()["hasMore"],
        true
    );
    assert_eq!(
        fixture.run("log", json!({"skip": 2})).unwrap()["commits"][0]["id"],
        initial["id"]
    );
    assert_eq!(
        fixture.run("log", json!({"search": "RENAME"})).unwrap()["commits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture.run("log", json!({"path": "next.txt"})).unwrap()["commits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::remove_file(fixture.root.path.join("new name.txt")).unwrap();
    fixture.commit("Delete");
    let preview = fixture
        .run("commitDiff", json!({"ref": "HEAD", "path": "new name.txt"}))
        .unwrap();
    assert_eq!(preview["before"], "first\n");
    assert_eq!(preview["after"], "");
    assert_eq!(
        fixture.run("log", json!({"limit": 0})).unwrap_err().code,
        "INVALID_PARAMS"
    );
}

#[test]
fn restores_missing_files_with_the_filesystem_revision_contract() {
    let fixture = Fixture::new(true);
    fs::remove_file(fixture.root.path.join("file.txt")).unwrap();
    let restored = fixture.run("restore", json!({"path": "file.txt"})).unwrap();
    assert_eq!(restored["revision"], fs_core::revision(b"first\n"));
    assert_eq!(restored["size"], 6);
    assert_eq!(fixture.content("file.txt"), "first\n");
    assert_eq!(
        fixture
            .run("restore", json!({"path": "file.txt"}))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
}

#[test]
fn uses_repository_identity_before_saved_identity() {
    let fixture = Fixture::new(true);
    let repo = fixture.repo();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit.author().name().unwrap(), "Repository User");
    assert_eq!(commit.author().email().unwrap(), "repo@example.test");
    assert_eq!(commit.committer().name().unwrap(), "Repository User");
}

#[test]
fn handles_binary_and_large_files_through_whole_file_actions() {
    let fixture = Fixture::new(true);
    fixture.write("binary.dat", "before\0binary");
    fixture.commit("Binary");
    fixture.write("binary.dat", "after\0binary");
    let diff = fixture.run("diff", json!({"path": "binary.dat"})).unwrap();
    assert_eq!(diff["binary"], true);
    assert_eq!(diff["before"], "");
    assert_eq!(diff["after"], "");
    assert_eq!(diff["hunks"], json!([]));
    fixture.write("large.txt", &"x".repeat(MAX_BYTES / 2 + 1));
    assert_eq!(
        fixture
            .run("diff", json!({"path": "large.txt"}))
            .unwrap_err()
            .code,
        "OUTPUT_LIMIT"
    );
    fixture.run("stage", json!({"path": "large.txt"})).unwrap();
    assert!(fixture
        .repo()
        .index()
        .unwrap()
        .get_path(Path::new("large.txt"), 0)
        .is_some());
}

#[test]
fn requires_confirmation_and_obeys_preflight_cancellation() {
    let fixture = Fixture::new(true);
    fixture.write("file.txt", "changed\n");
    assert_eq!(
        fixture
            .run("discard", json!({"path": "file.txt"}))
            .unwrap_err()
            .code,
        "CONFIRM_REQUIRED"
    );
    fixture
        .run("discard", json!({"path": "file.txt", "confirm": true}))
        .unwrap();
    assert_eq!(fixture.content("file.txt"), "first\n");
    fixture.write("untracked.txt", "new");
    fixture
        .run("discard", json!({"path": "untracked.txt", "confirm": true}))
        .unwrap();
    assert!(!fixture.root.path.join("untracked.txt").exists());
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        dispatch(
            &fixture.root,
            "git.stageAll",
            &json!({}),
            &fixture.credentials,
            &cancelled,
            &|_| {}
        )
        .unwrap_err()
        .code,
        "CANCELLED"
    );
}

#[test]
fn formats_git_author_time_with_its_timezone() {
    assert_eq!(
        history::date(git2::Time::new(0, 0)),
        "1970-01-01T00:00:00+00:00"
    );
    assert_eq!(
        history::date(git2::Time::new(0, -330)),
        "1969-12-31T18:30:00-05:30"
    );
}
