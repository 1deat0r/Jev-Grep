#![cfg(target_os = "linux")]

mod scope;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use rustix::fd::{AsRawFd, OwnedFd};
use rustix::fs::{self, Dir, FileType, Mode, OFlags, ResolveFlags, Stat};
use scope::{Scope, ScopeInput};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

const FRAME_CAP: usize = 1_048_576;
const MATCHER: &str = "grep-regex-0.1.14";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Code {
    InvalidRequest,
    RegexInvalid,
    MatchEncoding,
    ReadFailed,
    SourceMutated,
    Deadline,
    LimitReached,
    ByteLimit,
    EntryLimit,
    DepthLimit,
    PolicyChanged,
    OutOfScope,
    RevisionMismatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    v: u8,
    id: String,
    pattern: String,
    kind: QueryKind,
    case_sensitive: bool,
    max_matches: usize,
    max_file_bytes: usize,
    response_bytes: usize,
    deadline_ms: u64,
    max_entries: usize,
    max_depth: usize,
    #[serde(default)]
    scope: ScopeInput,
    #[serde(default)]
    validate_scope_only: bool,
    #[serde(default)]
    read: Option<ReadRequest>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum QueryKind {
    Literal,
    Regex,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    path: String,
    range: Range,
    expected_file_sha256: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    start: usize,
    end: usize,
}
#[derive(Serialize)]
struct Excerpt {
    range: Range,
    text: String,
    truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    path: String,
    file_sha256: String,
    range: Range,
    excerpt: Excerpt,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    visited: usize,
    searched: usize,
    excluded: usize,
    failed: usize,
    bytes_read: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Success {
    v: u8,
    id: String,
    status: &'static str,
    coverage: &'static str,
    reasons: Vec<Code>,
    matches: Vec<Hit>,
    counts: Counts,
    elapsed_ms: f64,
    policy_snapshot_hash: String,
    matcher_version: &'static str,
}
#[derive(Serialize)]
struct Failure {
    v: u8,
    id: String,
    status: &'static str,
    code: Code,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    v: u8,
    status: &'static str,
    pid: u32,
    matcher: &'static str,
    root_dev: String,
    root_ino: String,
}

fn expired(deadline: Instant) -> Result<(), Code> {
    if Instant::now() >= deadline {
        Err(Code::Deadline)
    } else {
        Ok(())
    }
}
fn same_revision(a: &Stat, b: &Stat) -> bool {
    (
        a.st_dev,
        a.st_ino,
        a.st_size,
        a.st_mtime,
        a.st_mtime_nsec,
        a.st_ctime,
        a.st_ctime_nsec,
    ) == (
        b.st_dev,
        b.st_ino,
        b.st_size,
        b.st_mtime,
        b.st_mtime_nsec,
        b.st_ctime,
        b.st_ctime_nsec,
    )
}
fn anchor(root: &OwnedFd, path: &str) -> Result<OwnedFd, Code> {
    fs::openat2(
        root,
        path,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )
    .map_err(|_| Code::ReadFailed)
}
fn reopen(fd: &OwnedFd, directory: bool) -> Result<OwnedFd, Code> {
    let mut flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NONBLOCK;
    if directory {
        flags |= OFlags::DIRECTORY;
    }
    fs::open(
        format!("/proc/self/fd/{}", fd.as_raw_fd()),
        flags,
        Mode::empty(),
    )
    .map_err(|_| Code::ReadFailed)
}
// The O_PATH handle is type-checked before opening a readable stream. This never
// follows the original path again, even if another process swaps it for a device.
fn capture<F: FnOnce()>(
    fd: &OwnedFd,
    limit: usize,
    deadline: Instant,
    after_inspect: F,
) -> Result<Option<Vec<u8>>, Code> {
    expired(deadline)?;
    let before = fs::fstat(fd).map_err(|_| Code::ReadFailed)?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile
        || before.st_size < 0
        || before.st_size as u64 > limit as u64
    {
        return Ok(None);
    }
    after_inspect();
    expired(deadline)?;
    let readable = reopen(fd, false)?;
    let opened = fs::fstat(&readable).map_err(|_| Code::ReadFailed)?;
    if FileType::from_raw_mode(opened.st_mode) != FileType::RegularFile
        || !same_revision(&before, &opened)
    {
        return Err(Code::SourceMutated);
    }
    let mut file = File::from(readable);
    let mut bytes = Vec::with_capacity((before.st_size as usize).min(limit));
    let mut chunk = [0_u8; 65_536];
    loop {
        expired(deadline)?;
        let wanted = chunk.len().min(limit + 1 - bytes.len());
        let n = file
            .read(&mut chunk[..wanted])
            .map_err(|_| Code::ReadFailed)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > limit {
            return Err(Code::SourceMutated);
        }
    }
    let after = fs::fstat(&file).map_err(|_| Code::ReadFailed)?;
    if !same_revision(&before, &after) {
        return Err(Code::SourceMutated);
    }
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Ok(None);
    }
    Ok(Some(bytes))
}
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\0', '\r', '\n', '\\'])
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn validate(r: &Request) -> Result<(), Code> {
    if r.v != 1
        || r.id.is_empty()
        || r.id.len() > 128
        || !r
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || r.pattern.is_empty()
        || r.pattern.len() > 8192
        || r.pattern.contains(['\0', '\r', '\n'])
        || !(1..=1000).contains(&r.max_matches)
        || !(1..=16_777_216).contains(&r.max_file_bytes)
        || !(2048..=FRAME_CAP).contains(&r.response_bytes)
        || !(1..=30_000).contains(&r.deadline_ms)
        || !(1..=100_000).contains(&r.max_entries)
        || !(1..=64).contains(&r.max_depth)
    {
        return Err(Code::InvalidRequest);
    }
    if let Some(read) = &r.read {
        if !valid_path(&read.path)
            || read.range.start > read.range.end
            || read.range.end > r.max_file_bytes
        {
            return Err(Code::InvalidRequest);
        }
        if read.range.end - read.range.start > 4096 {
            return Err(Code::ByteLimit);
        }
    }
    // Prototype rejects whole-buffer anchors/inline flag changes whose rg printer
    // occurrence semantics need a separate compatibility implementation.
    if r.kind == QueryKind::Regex
        && (r.pattern.contains("\\A")
            || r.pattern.contains("\\z")
            || r.pattern.contains("\\Z")
            || r.pattern.contains("(?-"))
    {
        return Err(Code::RegexInvalid);
    }
    Ok(())
}
struct Search<'a> {
    root: &'a OwnedFd,
    request: &'a Request,
    matcher: RegexMatcher,
    deadline: Instant,
    result: Success,
    used_bytes: usize,
    scope: Scope,
}
impl Search<'_> {
    fn issue(&mut self, code: Code) {
        if !self.result.reasons.contains(&code) {
            self.result.reasons.push(code);
        }
        self.result.coverage = "partial";
    }
    fn walk(&mut self, fd: &OwnedFd, prefix: &str, depth: usize) -> Result<(), Code> {
        expired(self.deadline)?;
        if depth > self.request.max_depth {
            self.issue(Code::DepthLimit);
            return Ok(());
        }
        self.scope.enter(self.root, prefix, self.deadline)?;
        let mut dir = Dir::new(reopen(fd, true)?).map_err(|_| Code::ReadFailed)?;
        for entry in &mut dir {
            expired(self.deadline)?;
            let entry = entry.map_err(|_| Code::ReadFailed)?;
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            if self.result.counts.visited == self.request.max_entries {
                return Err(Code::EntryLimit);
            }
            self.result.counts.visited += 1;
            let Ok(name) = std::str::from_utf8(bytes) else {
                self.result.counts.excluded += 1;
                continue;
            };
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if !valid_path(&path) || self.scope.excluded_path(&path) {
                self.result.counts.excluded += 1;
                continue;
            }
            if let Some(read) = &self.request.read
                && path != read.path
                && !read.path.starts_with(&format!("{path}/"))
            {
                continue;
            }
            let node = match anchor(self.root, &path) {
                Ok(n) => n,
                Err(c) => {
                    self.result.counts.failed += 1;
                    self.issue(c);
                    continue;
                }
            };
            let metadata = match fs::fstat(&node) {
                Ok(m) => m,
                Err(_) => {
                    self.result.counts.failed += 1;
                    self.issue(Code::ReadFailed);
                    continue;
                }
            };
            let is_dir = FileType::from_raw_mode(metadata.st_mode) == FileType::Directory;
            if !self.scope.allows(&path, is_dir) {
                self.result.counts.excluded += 1;
                continue;
            }
            match FileType::from_raw_mode(metadata.st_mode) {
                FileType::Directory => match self.walk(&node, &path, depth + 1) {
                    Err(Code::ReadFailed) => {
                        self.result.counts.failed += 1;
                        self.issue(Code::ReadFailed);
                    }
                    other => other?,
                },
                FileType::RegularFile => self.search_file(&node, &path)?,
                _ => self.result.counts.excluded += 1,
            }
        }
        Ok(())
    }
    fn search_file(&mut self, fd: &OwnedFd, path: &str) -> Result<(), Code> {
        if self.request.read.as_ref().is_some_and(|r| r.path != path) {
            return Ok(());
        }
        let first = capture(fd, self.request.max_file_bytes, self.deadline, || {});
        // Retry by resolving the path again; never call a later revision the old one.
        let read = if matches!(first, Err(Code::SourceMutated)) {
            anchor(self.root, path).and_then(|fresh| {
                capture(&fresh, self.request.max_file_bytes, self.deadline, || {})
            })
        } else {
            first
        };
        let bytes = match read {
            Ok(Some(b)) => b,
            Ok(None) => {
                self.result.counts.excluded += 1;
                return Ok(());
            }
            Err(Code::Deadline) => return Err(Code::Deadline),
            Err(c) => {
                self.result.counts.failed += 1;
                self.issue(c);
                return Ok(());
            }
        };
        expired(self.deadline)?;
        self.result.counts.searched += 1;
        self.result.counts.bytes_read += bytes.len();
        let mut digest = String::with_capacity(64);
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in Sha256::digest(&bytes) {
            digest.push(HEX[usize::from(byte >> 4)] as char);
            digest.push(HEX[usize::from(byte & 15)] as char);
        }
        if let Some(read) = &self.request.read {
            if read
                .expected_file_sha256
                .as_ref()
                .is_some_and(|expected| expected != &digest)
            {
                return Err(Code::RevisionMismatch);
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| Code::MatchEncoding)?;
            let (start, end) = (read.range.start, read.range.end);
            if end > bytes.len() || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                return Err(Code::InvalidRequest);
            }
            let hit = Hit {
                path: path.to_owned(),
                file_sha256: digest,
                range: Range { start, end },
                excerpt: Excerpt {
                    range: Range { start, end },
                    text: text[start..end].to_owned(),
                    truncated: false,
                },
            };
            if self.used_bytes + serde_json::to_vec(&hit).map_or(FRAME_CAP, |b| b.len() + 1)
                > self.request.response_bytes
            {
                return Err(Code::ByteLimit);
            }
            self.result.matches.push(hit);
            return Ok(());
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| Code::MatchEncoding)?;
        let mut stopped = None;
        self.matcher
            .find_iter(&bytes, |matched| {
                if expired(self.deadline).is_err() {
                    stopped = Some(Code::Deadline);
                    return false;
                }
                let (start, end) = (matched.start(), matched.end());
                // No phantom line after the final LF.
                if start == bytes.len() && bytes.last() == Some(&b'\n') {
                    return true;
                }
                if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                    stopped = Some(Code::MatchEncoding);
                    return false;
                }
                if self.result.matches.len() == self.request.max_matches {
                    stopped = Some(Code::LimitReached);
                    return false;
                }
                let mut excerpt_end = end.min(start + 4096);
                while !text.is_char_boundary(excerpt_end) {
                    excerpt_end -= 1;
                }
                let hit = Hit {
                    path: path.to_owned(),
                    file_sha256: digest.clone(),
                    range: Range { start, end },
                    excerpt: Excerpt {
                        range: Range {
                            start,
                            end: excerpt_end,
                        },
                        text: text[start..excerpt_end].to_owned(),
                        truncated: excerpt_end != end,
                    },
                };
                let size = serde_json::to_vec(&hit).map_or(FRAME_CAP, |b| b.len() + 1);
                if self.used_bytes + size > self.request.response_bytes {
                    stopped = Some(Code::ByteLimit);
                    return false;
                }
                self.used_bytes += size;
                self.result.matches.push(hit);
                true
            })
            .map_err(|_| Code::RegexInvalid)?;
        if let Some(code) = stopped {
            return Err(code);
        }
        Ok(())
    }
}
fn search(root: &OwnedFd, r: &Request) -> Result<Success, Code> {
    validate(r)?;
    let begin = Instant::now();
    let deadline = begin + Duration::from_millis(r.deadline_ms);
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!r.case_sensitive)
        .fixed_strings(r.kind == QueryKind::Literal)
        .multi_line(true)
        .line_terminator(Some(b'\n'))
        .ban_byte(Some(0))
        .size_limit(10 * 1024 * 1024)
        .dfa_size_limit(4 * 1024 * 1024)
        .build(&r.pattern)
        .map_err(|_| Code::RegexInvalid)?;
    let mut state = Search {
        root,
        request: r,
        matcher,
        deadline,
        used_bytes: 2048,
        scope: Scope::new(&r.scope)?,
        result: Success {
            v: 1,
            id: r.id.clone(),
            status: "ok",
            coverage: "complete",
            reasons: vec![],
            matches: vec![],
            counts: Counts::default(),
            elapsed_ms: 0.0,
            policy_snapshot_hash: String::new(),
            matcher_version: MATCHER,
        },
    };
    if let Err(code) = if r.validate_scope_only {
        Ok(())
    } else {
        state.walk(root, "", 0)
    } {
        if r.read.is_some()
            || matches!(code, Code::RegexInvalid | Code::MatchEncoding)
            || (code == Code::Deadline && state.result.matches.is_empty())
        {
            return Err(code);
        }
        if matches!(code, Code::ReadFailed | Code::SourceMutated) {
            state.result.counts.failed += 1;
        }
        state.issue(code);
    }
    if let Err(code) = state.scope.verify(root, deadline) {
        state.issue(code);
    }
    if r.read.is_some() {
        if let Some(code) = state.result.reasons.first() {
            return Err(*code);
        }
        if state.result.matches.is_empty() {
            return Err(Code::OutOfScope);
        }
    }
    state.result.policy_snapshot_hash = state.scope.snapshot_hash();
    state.result.elapsed_ms = begin.elapsed().as_secs_f64() * 1000.0;
    Ok(state.result)
}
fn write_frame(out: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > FRAME_CAP {
        return Err(io::Error::other("response frame cap"));
    }
    out.write_all(&(bytes.len() as u32).to_be_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 || !args[1].starts_with('/') {
        return Err("expected absolute root".into());
    }
    let root = fs::openat2(
        fs::CWD,
        args[1].as_str(),
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )?;
    let mut input = io::stdin().lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    let root_stat = fs::fstat(&root)?;
    write_frame(
        &mut output,
        &Ready {
            v: 1,
            status: "ready",
            pid: std::process::id(),
            matcher: MATCHER,
            root_dev: root_stat.st_dev.to_string(),
            root_ino: root_stat.st_ino.to_string(),
        },
    )?;
    loop {
        let mut header = [0_u8; 4];
        // Clean EOF is allowed only before the first byte of a new frame.
        if input.read(&mut header[..1])? == 0 {
            return Ok(());
        }
        input.read_exact(&mut header[1..])?;
        let size = u32::from_be_bytes(header) as usize;
        if size == 0 || size > FRAME_CAP {
            return Err("request frame cap".into());
        }
        let mut bytes = vec![0; size];
        input.read_exact(&mut bytes)?;
        let r: Request = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => {
                write_frame(
                    &mut output,
                    &Failure {
                        v: 1,
                        id: "invalid".into(),
                        status: "error",
                        code: Code::InvalidRequest,
                    },
                )?;
                continue;
            }
        };
        match search(&root, &r) {
            Ok(result) => write_frame(&mut output, &result)?,
            Err(code) => write_frame(
                &mut output,
                &Failure {
                    v: 1,
                    id: r.id.chars().take(128).collect(),
                    status: "error",
                    code,
                },
            )?,
        }
    }
}
fn main() {
    if run().is_err() {
        eprintln!("worker stopped: startup or protocol failure");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "jev-rust-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn root(&self) -> OwnedFd {
            fs::open(&self.0, OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn pinned_handle_does_not_follow_replacement() {
        let f = Fixture::new();
        std::fs::write(f.0.join("a"), b"inside").unwrap();
        let fd = anchor(&f.root(), "a").unwrap();
        let got = capture(&fd, 1024, Instant::now() + Duration::from_secs(1), || {
            std::fs::rename(f.0.join("a"), f.0.join("old")).unwrap();
            symlink("/etc/passwd", f.0.join("a")).unwrap();
        });
        assert!(matches!(got, Err(Code::SourceMutated)) || got.unwrap().unwrap() == b"inside");
    }
    #[test]
    fn growing_file_fails_without_unbounded_capture() {
        let f = Fixture::new();
        std::fs::write(f.0.join("a"), b"small").unwrap();
        let fd = anchor(&f.root(), "a").unwrap();
        let got = capture(&fd, 64, Instant::now() + Duration::from_secs(1), || {
            std::fs::write(f.0.join("a"), vec![b'x'; 1024]).unwrap();
        });
        assert!(matches!(got, Err(Code::SourceMutated)));
    }
    #[test]
    fn preexisting_special_objects_are_not_read() {
        let f = Fixture::new();
        fs::mknodat(
            fs::CWD,
            f.0.join("fifo"),
            FileType::Fifo,
            Mode::RUSR | Mode::WUSR,
            0,
        )
        .unwrap();
        let fd = anchor(&f.root(), "fifo").unwrap();
        assert_eq!(
            capture(
                &fd,
                1024,
                Instant::now() + Duration::from_secs(1),
                || panic!("special file must not reopen")
            )
            .unwrap(),
            None
        );
    }
    #[test]
    fn deadlines_and_traversal_fail_closed() {
        let f = Fixture::new();
        std::fs::write(f.0.join("a"), b"inside").unwrap();
        assert!(anchor(&f.root(), "../outside").is_err());
        let fd = anchor(&f.root(), "a").unwrap();
        assert_eq!(
            capture(&fd, 1024, Instant::now(), || {}),
            Err(Code::Deadline)
        );
    }
}
