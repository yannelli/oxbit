//! Content search and file listing for a local root. Content search follows the runtime's
//! ripgrep call (`search.query` in `apps/runtime/src/runtime.ts`); rules in docs/ios-runtime-parity.md.
use crate::fs_core::{self, Error, Result, Root, MAX_READ_BYTES, TEMP_PREFIX};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use ignore::{
    overrides::{Override, OverrideBuilder},
    DirEntry, WalkBuilder, WalkState,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

pub const MATCHED_LINES_PER_FILE: usize = 1000;
pub const RESULT_LIMIT: usize = 10_000;
pub const FILE_LIMIT: usize = 1000;
const MAX_QUERY_LENGTH: usize = 8192;
const MAX_GLOB_LENGTH: usize = 1024;
const EXCLUDED: [&str; 2] = [".git", "node_modules"];

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include: Option<String>,
    pub exclude: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub from: usize,
    pub to: usize,
    pub text: String,
    pub revision: String,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

fn matcher(options: &SearchOptions) -> Result<RegexMatcher> {
    RegexMatcherBuilder::new()
        .line_terminator(Some(b'\n'))
        .multi_line(true)
        .fixed_strings(!options.regex)
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .build(&options.query)
        .map_err(|error| Error::invalid(error.to_string()))
}

fn walker(root: &Root, include_hidden: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(&root.path);
    builder
        .hidden(!include_hidden)
        .follow_links(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !EXCLUDED.contains(&name.as_ref()) && !name.starts_with(TEMP_PREFIX)
        });
    builder
}

/// Workspace path of a walked regular file; `None` for symlinks, directories, and non-UTF-8 names.
fn workspace_path(root: &Path, entry: &DirEntry) -> Option<String> {
    if entry.path_is_symlink() || !entry.file_type().is_some_and(|kind| kind.is_file()) {
        return None;
    }
    let parts: Option<Vec<&str>> = entry
        .path()
        .strip_prefix(root)
        .ok()?
        .iter()
        .map(|part| part.to_str())
        .collect();
    fs_core::normalize(&parts?.join("/"), false).ok()
}

/// Same rules as `decodeText` in `@oxbit/host-browser`: BOM detection, strict UTF-8 or UTF-16LE,
/// no NUL characters, CRLF folded to LF. Files it rejects cannot open as text, so search skips them.
pub fn decode(bytes: &[u8]) -> Option<String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if rest.len() % 2 != 0 {
            return None;
        }
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).ok()?
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        return None;
    } else {
        let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        std::str::from_utf8(content).ok()?.to_owned()
    };
    if text.contains('\0') {
        return None;
    }
    Some(text.replace("\r\n", "\n"))
}

/// Converts ascending byte offsets in `text` to UTF-16 code-unit offsets in one forward pass.
struct Utf16Cursor<'a> {
    text: &'a str,
    byte: usize,
    unit: usize,
}

impl Utf16Cursor<'_> {
    fn at(&mut self, byte: usize) -> usize {
        self.unit += self.text[self.byte..byte]
            .chars()
            .map(char::len_utf16)
            .sum::<usize>();
        self.byte = byte;
        self.unit
    }
}

/// Matches in one decoded file: at most `MATCHED_LINES_PER_FILE` lines and `limit` rows.
pub fn search_text(
    matcher: &RegexMatcher,
    path: &str,
    text: &str,
    revision: impl Fn() -> String,
    limit: usize,
) -> Vec<SearchMatch> {
    let mut rows: Vec<SearchMatch> = Vec::new();
    let mut cursor = Utf16Cursor {
        text,
        byte: 0,
        unit: 0,
    };
    let (mut line, mut line_start, mut line_unit, mut lines) = (1, 0, 0, 0);
    let mut line_text = "";
    let _ = matcher.find_iter(text.as_bytes(), |found| {
        let before = &text[line_start..found.start()];
        if lines == 0 || before.contains('\n') {
            if lines == MATCHED_LINES_PER_FILE {
                return false;
            }
            lines += 1;
            line += before.matches('\n').count();
            line_start += before.rfind('\n').map_or(0, |index| index + 1);
            line_unit = cursor.at(line_start);
            let rest = &text[line_start..];
            line_text = &rest[..rest.find('\n').unwrap_or(rest.len())];
        }
        let from = cursor.at(found.start());
        let to = cursor.at(found.end());
        rows.push(SearchMatch {
            path: path.to_owned(),
            line,
            column: from - line_unit + 1,
            from,
            to,
            text: line_text.to_owned(),
            revision: String::new(),
        });
        rows.len() < limit
    });
    if !rows.is_empty() {
        let revision = revision();
        for row in &mut rows {
            row.revision.clone_from(&revision);
        }
    }
    rows
}

fn globs(root: &Root, options: &SearchOptions) -> Result<Override> {
    let mut builder = OverrideBuilder::new(&root.path);
    for (value, prefix) in [(&options.include, ""), (&options.exclude, "!")] {
        let value = value.as_deref().unwrap_or("");
        for glob in value
            .split(',')
            .map(str::trim)
            .filter(|glob| !glob.is_empty())
        {
            if glob.len() > MAX_GLOB_LENGTH {
                return Err(Error::invalid("Path filter is too long"));
            }
            builder
                .add(&format!("{prefix}{glob}"))
                .map_err(|error| Error::invalid(error.to_string()))?;
        }
    }
    builder
        .build()
        .map_err(|error| Error::invalid(error.to_string()))
}

pub fn search(root: &Root, options: &SearchOptions, cancel: &AtomicBool) -> Result<SearchResult> {
    if options.query.len() > MAX_QUERY_LENGTH {
        return Err(Error::invalid("query is too long"));
    }
    if options.query.is_empty() {
        return Ok(SearchResult::default());
    }
    let matcher = matcher(options)?;
    let mut builder = walker(root, false);
    builder
        .max_filesize(Some(MAX_READ_BYTES))
        .overrides(globs(root, options)?);
    let result = Mutex::new(SearchResult::default());
    builder.build_parallel().run(|| {
        Box::new(|entry| {
            if cancel.load(Ordering::Acquire) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(path) = workspace_path(&root.path, &entry) else {
                return WalkState::Continue;
            };
            let Ok(bytes) = fs::read(entry.path()) else {
                return WalkState::Continue;
            };
            let Some(text) = decode(&bytes) else {
                return WalkState::Continue;
            };
            let revision = || fs_core::revision(&bytes);
            let rows = search_text(&matcher, &path, &text, revision, RESULT_LIMIT);
            if rows.is_empty() {
                return WalkState::Continue;
            }
            let mut result = result.lock().unwrap_or_else(|error| error.into_inner());
            let room = RESULT_LIMIT.saturating_sub(result.matches.len());
            result.matches.extend(rows.into_iter().take(room));
            if result.matches.len() < RESULT_LIMIT {
                return WalkState::Continue;
            }
            result.truncated = true;
            WalkState::Quit
        })
    });
    if cancel.load(Ordering::Acquire) {
        return Err(Error::new("CANCELLED", "Search cancelled"));
    }
    let mut result = result
        .into_inner()
        .unwrap_or_else(|error| error.into_inner());
    result
        .matches
        .sort_by(|a, b| a.path.cmp(&b.path).then(a.from.cmp(&b.from)));
    Ok(result)
}

/// Lowercase subsequence test, the same one `findWorkspaceFiles` applies in the workbench.
fn subsequence(path: &str, term: &[char]) -> bool {
    let mut remaining = path.chars();
    term.iter()
        .all(|wanted| remaining.by_ref().any(|actual| actual == *wanted))
}

/// Quick-open paths: gitignore-aware, hidden files included, `.git` and `node_modules` skipped.
pub fn find_files(root: &Root, query: &str, cancel: &AtomicBool) -> Result<Vec<String>> {
    let term: Vec<char> = query.trim().to_lowercase().chars().collect();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder = walker(root, true);
    builder.sort_by_file_name(|a, b| a.cmp(b));
    let mut paths = Vec::new();
    for entry in builder.build() {
        if cancel.load(Ordering::Acquire) {
            return Err(Error::new("CANCELLED", "Search cancelled"));
        }
        let Some(path) = entry
            .ok()
            .and_then(|entry| workspace_path(&root.path, &entry))
        else {
            continue;
        };
        if subsequence(&path.to_lowercase(), &term) {
            paths.push(path);
            if paths.len() >= FILE_LIMIT {
                break;
            }
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests;
