use super::tests::Fixture;
use super::*;

fn conflict_fixture() -> Fixture {
    let fixture = Fixture::new(true);
    fixture
        .run("branchCreate", json!({"name": "other"}))
        .unwrap();
    fixture.write("file.txt", "other\n");
    fixture.commit("Other");
    fixture.run("checkout", json!({"branch": "main"})).unwrap();
    fixture.write("file.txt", "main\n");
    fixture.commit("Main");
    fixture
}

#[test]
fn exposes_merge_conflicts_aborts_and_continues_after_staged_resolution() {
    let fixture = conflict_fixture();
    assert_eq!(
        fixture
            .run("merge", json!({"ref": "other"}))
            .unwrap_err()
            .code,
        "GIT_FAILED"
    );
    let status = fixture.run("status", json!({})).unwrap();
    assert_eq!(status["operation"], "merge");
    assert!(status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|change| change["conflict"] == true));
    assert_eq!(
        fixture
            .run("continue", json!({"operation": "merge"}))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        fixture.run("stageAll", json!({})).unwrap_err().code,
        "CONFLICT"
    );
    fixture
        .run("abort", json!({"operation": "merge", "confirm": true}))
        .unwrap();
    assert_eq!(fixture.content("file.txt"), "main\n");
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["changes"],
        json!([])
    );
    assert!(fixture.run("merge", json!({"ref": "other"})).is_err());
    fixture.write("file.txt", "resolved\n");
    fixture.run("stage", json!({"path": "file.txt"})).unwrap();
    fixture
        .run("continue", json!({"operation": "merge"}))
        .unwrap();
    assert!(fixture
        .run("status", json!({}))
        .unwrap()
        .get("operation")
        .is_none());
    let commit = fixture.run("log", json!({"limit": 1})).unwrap()["commits"][0].clone();
    assert_eq!(commit["parents"].as_array().unwrap().len(), 2);
}

#[test]
fn cherry_picks_and_reverts_without_rewriting_earlier_commits() {
    let fixture = Fixture::new(true);
    fixture
        .run("branchCreate", json!({"name": "other"}))
        .unwrap();
    fixture.write("new.txt", "new\n");
    let reference = fixture.commit("Add new");
    fixture.run("checkout", json!({"branch": "main"})).unwrap();
    fixture
        .run("cherryPick", json!({"ref": reference, "confirm": true}))
        .unwrap();
    assert_eq!(fixture.content("new.txt"), "new\n");
    let picked = fixture.run("status", json!({})).unwrap()["head"].clone();
    fixture
        .run("revert", json!({"ref": picked, "confirm": true}))
        .unwrap();
    assert!(!fixture.root.path.join("new.txt").exists());
    let log = fixture.run("log", json!({})).unwrap();
    let subjects = log["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| commit["subject"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        subjects,
        vec!["Revert \"Add new\"", "Add new", "Initial commit"]
    );
}

#[test]
fn recovers_cherry_pick_and_revert_conflicts() {
    for method in ["cherryPick", "revert"] {
        let fixture = conflict_fixture();
        let reference = if method == "cherryPick" {
            json!("other")
        } else {
            fixture.write("file.txt", "intervening\n");
            let previous = fixture.run("status", json!({})).unwrap()["head"].clone();
            fixture.commit("Intervening");
            previous
        };
        assert!(fixture
            .run(method, json!({"ref": reference, "confirm": true}))
            .is_err());
        let operation = if method == "cherryPick" {
            "cherry-pick"
        } else {
            "revert"
        };
        assert_eq!(
            fixture.run("status", json!({})).unwrap()["operation"],
            operation
        );
        fixture.write("file.txt", "resolved\n");
        fixture.run("stage", json!({"path": "file.txt"})).unwrap();
        fixture
            .run("continue", json!({"operation": operation}))
            .unwrap();
        assert!(fixture
            .run("status", json!({}))
            .unwrap()
            .get("operation")
            .is_none());
    }
}

#[test]
fn saves_previews_applies_pops_and_drops_stashes_with_index_and_untracked_files() {
    let fixture = Fixture::new(true);
    fixture.write("file.txt", "staged\n");
    fixture.run("stage", json!({"path": "file.txt"})).unwrap();
    fixture.write("untracked.txt", "new\n");
    fixture
        .run(
            "stashSave",
            json!({"message": "My work", "includeUntracked": true}),
        )
        .unwrap();
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["changes"],
        json!([])
    );
    let stash = fixture.run("stashes", json!({})).unwrap()[0].clone();
    assert!(stash["message"].as_str().unwrap().contains("My work"));
    assert!(fixture.run("stashDiff", stash.clone()).unwrap()["diff"]
        .as_str()
        .unwrap()
        .contains("+new"));
    fixture.run("stashApply", stash.clone()).unwrap();
    assert_eq!(fixture.index_content("file.txt"), "staged\n");
    assert_eq!(fixture.content("untracked.txt"), "new\n");
    fixture
        .run(
            "stashSave",
            json!({"message": "Again", "includeUntracked": true}),
        )
        .unwrap();
    let mut stale = stash;
    stale["confirm"] = json!(true);
    assert_eq!(
        fixture.run("stashDrop", stale).unwrap_err().code,
        "STALE_STATE"
    );
    let latest = fixture.run("stashes", json!({})).unwrap()[0].clone();
    fixture.run("stashPop", latest).unwrap();
    assert_eq!(
        fixture
            .run("stashes", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut remaining = fixture.run("stashes", json!({})).unwrap()[0].clone();
    assert_eq!(
        fixture
            .run("stashDrop", remaining.clone())
            .unwrap_err()
            .code,
        "CONFIRM_REQUIRED"
    );
    remaining["confirm"] = json!(true);
    fixture.run("stashDrop", remaining).unwrap();
    assert_eq!(fixture.run("stashes", json!({})).unwrap(), json!([]));
}

#[test]
fn retains_stashes_when_pop_conflicts() {
    let fixture = Fixture::new(true);
    fixture.write("file.txt", "stashed\n");
    fixture
        .run("stashSave", json!({"message": "Retain on conflict"}))
        .unwrap();
    let stash = fixture.run("stashes", json!({})).unwrap()[0].clone();
    fixture.write("file.txt", "committed\n");
    fixture.commit("Intervening change");
    assert!(fixture.run("stashPop", stash.clone()).is_err());
    assert_eq!(
        fixture.run("stashes", json!({})).unwrap()[0]["id"],
        stash["id"]
    );
    assert!(fixture.run("status", json!({})).unwrap()["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|change| change["conflict"] == true));
}

fn start_rebase(fixture: &Fixture) {
    let repo = fixture.repo();
    let branch = repo
        .reference_to_annotated_commit(&repo.head().unwrap())
        .unwrap();
    let upstream_branch = repo.find_branch("other", git2::BranchType::Local).unwrap();
    let upstream = repo
        .reference_to_annotated_commit(upstream_branch.get())
        .unwrap();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    let mut options = git2::RebaseOptions::new();
    options.checkout_options(checkout);
    let mut rebase = repo
        .rebase(Some(&branch), Some(&upstream), None, Some(&mut options))
        .unwrap();
    let _ = rebase.next();
    assert!(repo.index().unwrap().has_conflicts());
}

#[test]
fn recognizes_and_aborts_a_rebase_and_rejects_stale_operation_recovery() {
    let fixture = conflict_fixture();
    let head = fixture.run("status", json!({})).unwrap()["head"].clone();
    start_rebase(&fixture);
    assert_eq!(
        fixture.run("status", json!({})).unwrap()["operation"],
        "rebase"
    );
    assert_eq!(
        fixture
            .run("continue", json!({"operation": "merge"}))
            .unwrap_err()
            .code,
        "STALE_STATE"
    );
    fixture
        .run("abort", json!({"operation": "rebase", "confirm": true}))
        .unwrap();
    let status = fixture.run("status", json!({})).unwrap();
    assert_eq!(status["branch"], "main");
    assert_eq!(status["head"], head);
    assert_eq!(status["changes"], json!([]));
}

#[test]
fn continues_an_ordinary_rebase_after_staging_a_conflict_resolution() {
    let fixture = conflict_fixture();
    let original = fixture.run("status", json!({})).unwrap()["head"].clone();
    start_rebase(&fixture);
    fixture.write("file.txt", "resolved\n");
    fixture.run("stage", json!({"path": "file.txt"})).unwrap();
    fixture
        .run("continue", json!({"operation": "rebase"}))
        .unwrap();
    let status = fixture.run("status", json!({})).unwrap();
    assert_eq!(status["branch"], "main");
    assert_ne!(status["head"], original);
    assert!(status.get("operation").is_none());
    assert_eq!(status["changes"], json!([]));
    assert_eq!(fixture.content("file.txt"), "resolved\n");
    let log = fixture.run("log", json!({})).unwrap();
    let subjects = log["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| commit["subject"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(subjects, vec!["Main", "Other", "Initial commit"]);
}
