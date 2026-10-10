use super::*;
use crate::fs_core::Roots;
use std::{fs, os::unix::fs::symlink, path::PathBuf};

struct Workspace {
    directory: PathBuf,
    root: Root,
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn workspace(files: &[(&str, &[u8])]) -> Workspace {
    let directory = std::env::temp_dir().join(format!("oxbit-ios-search-{}", uuid::Uuid::new_v4()));
    for (path, bytes) in files {
        let path = directory.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fs::create_dir_all(&directory).unwrap();
    let mut roots = Roots::default();
    let id = roots.open(&directory).unwrap().id;
    let root = roots.get(&id).unwrap().clone();
    Workspace {
        directory: root.path.clone(),
        root,
    }
}

fn query(text: &str) -> SearchOptions {
    SearchOptions {
        query: text.into(),
        ..Default::default()
    }
}

fn run(workspace: &Workspace, options: &SearchOptions) -> SearchResult {
    search(&workspace.root, options, &AtomicBool::new(false)).unwrap()
}

fn paths(result: &SearchResult) -> Vec<&str> {
    let mut paths: Vec<&str> = result.matches.iter().map(|row| row.path.as_str()).collect();
    paths.dedup();
    paths
}

fn utf16_slice(text: &str, from: usize, to: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[from..to]).unwrap()
}

#[test]
fn respects_gitignore_in_repositories_and_skips_hidden_and_excluded_directories() {
    let files: &[(&str, &[u8])] = &[
        (".gitignore", b"dist\n"),
        ("dist/out.js", b"needle"),
        ("src/a.ts", b"needle"),
        (".env", b"needle"),
        ("node_modules/x.js", b"needle"),
        ("pkg/node_modules/y.js", b"needle"),
        (".oxbit-tmp-1", b"needle"),
    ];
    let plain = workspace(files);
    assert_eq!(
        paths(&run(&plain, &query("needle"))),
        ["dist/out.js", "src/a.ts"]
    );
    let repository = workspace(files);
    fs::create_dir_all(repository.directory.join(".git")).unwrap();
    fs::write(repository.directory.join(".git/config"), b"needle").unwrap();
    assert_eq!(paths(&run(&repository, &query("needle"))), ["src/a.ts"]);
}

#[test]
fn applies_include_and_exclude_globs_like_ripgrep() {
    let files: &[(&str, &[u8])] = &[
        ("a.ts", b"needle"),
        ("src/b.ts", b"needle"),
        ("src/b.test.ts", b"needle"),
        ("src/c.md", b"needle"),
    ];
    let workspace = workspace(files);
    let mut options = query("needle");
    options.include = Some("*.ts, *.md".into());
    options.exclude = Some("*.test.ts".into());
    assert_eq!(
        paths(&run(&workspace, &options)),
        ["a.ts", "src/b.ts", "src/c.md"]
    );
    options.include = Some("src/**".into());
    options.exclude = None;
    assert_eq!(
        paths(&run(&workspace, &options)),
        ["src/b.test.ts", "src/b.ts", "src/c.md"]
    );
    options.include = Some("x".repeat(MAX_GLOB_LENGTH + 1));
    assert_eq!(
        search(&workspace.root, &options, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
}

#[test]
fn honors_fixed_regex_case_and_word_flags() {
    let workspace = workspace(&[("a.txt", b"a.b axb\nFoo foobar foo\n-2 x-2y\n")]);
    let count = |options: SearchOptions| run(&workspace, &options).matches.len();
    assert_eq!(count(query("a.b")), 1);
    assert_eq!(
        count(SearchOptions {
            regex: true,
            ..query("a.b")
        }),
        2
    );
    assert_eq!(count(query("foo")), 3);
    assert_eq!(
        count(SearchOptions {
            case_sensitive: true,
            ..query("foo")
        }),
        2
    );
    assert_eq!(
        count(SearchOptions {
            whole_word: true,
            ..query("foo")
        }),
        2
    );
    assert_eq!(
        count(SearchOptions {
            whole_word: true,
            ..query("-2")
        }),
        1
    );
    assert_eq!(
        count(SearchOptions {
            regex: true,
            ..query("^Foo")
        }),
        1
    );
    let invalid = SearchOptions {
        regex: true,
        ..query("(")
    };
    assert_eq!(
        search(&workspace.root, &invalid, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
    assert!(run(&workspace, &query("")).matches.is_empty());
}

#[test]
fn caps_matched_lines_per_file_and_total_rows() {
    let lines = "needle needle\n".repeat(1500);
    let workspace = workspace(&[("a.txt", lines.as_bytes())]);
    let result = run(&workspace, &query("needle"));
    assert_eq!(result.matches.len(), 2 * MATCHED_LINES_PER_FILE);
    assert_eq!(result.matches.last().unwrap().line, MATCHED_LINES_PER_FILE);
    assert!(!result.truncated);
    let single = "needle\n".repeat(1000);
    let files: Vec<(String, &[u8])> = (0..11)
        .map(|i| (format!("f{i:02}.txt"), single.as_bytes()))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(path, bytes)| (path.as_str(), *bytes))
        .collect();
    let workspace = super::tests::workspace(&borrowed);
    let result = run(&workspace, &query("needle"));
    assert_eq!(result.matches.len(), RESULT_LIMIT);
    assert!(result.truncated);
}

#[test]
fn reports_utf16_offsets_into_the_decoded_text() {
    let text = "héllo 中\n😀中 needle 𝄞needle\r\nnext";
    let workspace = workspace(&[("a.txt", text.as_bytes())]);
    let decoded = decode(text.as_bytes()).unwrap();
    let rows = run(&workspace, &query("needle")).matches;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (rows[0].line, rows[0].column, rows[0].from, rows[0].to),
        (2, 5, 12, 18)
    );
    assert_eq!(rows[1].column, 14);
    assert_eq!(rows[0].text, "😀中 needle 𝄞needle");
    for row in &rows {
        assert_eq!(utf16_slice(&decoded, row.from, row.to), "needle");
    }
}

#[test]
fn revision_matches_the_write_path_so_replace_succeeds() {
    let text = "😀 needle\r\n";
    let workspace = workspace(&[("a.txt", text.as_bytes())]);
    let row = run(&workspace, &query("needle")).matches.remove(0);
    assert_eq!(row.revision, fs_core::revision(text.as_bytes()));
    let decoded = decode(text.as_bytes()).unwrap();
    let units: Vec<u16> = decoded.encode_utf16().collect();
    let replaced = format!(
        "{}pin{}",
        String::from_utf16(&units[..row.from]).unwrap(),
        String::from_utf16(&units[row.to..]).unwrap()
    );
    assert_eq!(replaced, "😀 pin\n");
    let written = workspace
        .root
        .write("a.txt", replaced.as_bytes(), Some(&row.revision))
        .unwrap();
    assert_eq!(
        written.revision,
        fs_core::revision(b"\xf0\x9f\x98\x80 pin\n")
    );
}

#[test]
fn decodes_like_decode_text_and_skips_binary_and_large_files() {
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend("中 needle".encode_utf16().flat_map(u16::to_le_bytes));
    let files: &[(&str, &[u8])] = &[
        ("bom.txt", b"\xef\xbb\xbfneedle"),
        ("utf16.txt", &utf16),
        ("binary.bin", b"needle\0"),
        ("latin1.txt", b"caf\xe9 needle"),
        ("utf16be.txt", b"\xfe\xff\0n"),
    ];
    let workspace = workspace(files);
    let large = "needle\n".repeat(MAX_READ_BYTES as usize / 7 + 1);
    fs::write(workspace.directory.join("large.txt"), large).unwrap();
    fs::write(workspace.directory.join("small.txt"), b"needle").unwrap();
    let result = run(&workspace, &query("needle"));
    assert_eq!(paths(&result), ["bom.txt", "small.txt", "utf16.txt"]);
    assert_eq!((result.matches[0].from, result.matches[2].from), (0, 2));
}

#[test]
fn cancellation_stops_search_and_listing() {
    let workspace = workspace(&[("a.txt", b"needle")]);
    let cancel = AtomicBool::new(true);
    assert_eq!(
        search(&workspace.root, &query("needle"), &cancel)
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(
        find_files(&workspace.root, "a", &cancel).unwrap_err().code,
        "CANCELLED"
    );
}

#[test]
fn results_stay_inside_the_root() {
    let outside = workspace(&[("secret.txt", b"needle")]);
    let inside = workspace(&[("a.txt", b"needle")]);
    symlink(
        outside.directory.join("secret.txt"),
        inside.directory.join("leak.txt"),
    )
    .unwrap();
    symlink(&outside.directory, inside.directory.join("linked")).unwrap();
    let mut options = query("needle");
    assert_eq!(paths(&run(&inside, &options)), ["a.txt"]);
    options.include = Some("../**".into());
    assert!(run(&inside, &options).matches.is_empty());
    let none = AtomicBool::new(false);
    assert_eq!(find_files(&inside.root, "t", &none).unwrap(), ["a.txt"]);
}

#[test]
fn lists_quick_open_paths_with_hidden_files_and_gitignore() {
    let files: &[(&str, &[u8])] = &[
        (".gitignore", b"dist\n"),
        (".github/workflows/ci.yml", b""),
        ("dist/out.js", b""),
        ("src/Main.ts", b""),
        ("node_modules/x.ts", b""),
    ];
    let workspace = workspace(files);
    fs::create_dir_all(workspace.directory.join(".git")).unwrap();
    let none = AtomicBool::new(false);
    let found = |query: &str| find_files(&workspace.root, query, &none).unwrap();
    assert_eq!(found("ci.yml"), [".github/workflows/ci.yml"]);
    assert_eq!(found(" SMAIN "), ["src/Main.ts"]);
    assert!(found("out").is_empty());
    assert!(found("x.ts").is_empty());
    assert!(found("  ").is_empty());
    let many: Vec<(String, &[u8])> = (0..FILE_LIMIT + 5)
        .map(|i| (format!("f{i}.txt"), &b""[..]))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = many
        .iter()
        .map(|(path, bytes)| (path.as_str(), *bytes))
        .collect();
    let large = super::tests::workspace(&borrowed);
    assert_eq!(
        find_files(&large.root, "f", &none).unwrap().len(),
        FILE_LIMIT
    );
}
