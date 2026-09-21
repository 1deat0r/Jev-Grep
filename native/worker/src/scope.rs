use crate::{Code, capture, expired};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use rustix::fd::OwnedFd;
use rustix::fs::{self, Mode, OFlags, ResolveFlags};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeInput {
    #[serde(default)]
    include_groups: Vec<Vec<String>>,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    respect_ignore: bool,
}

fn globs(patterns: &[String]) -> Result<GlobSet, Code> {
    if patterns.len() > 128 {
        return Err(Code::InvalidRequest);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        if pattern.is_empty()
            || pattern.len() > 1024
            || pattern.starts_with(['/', '!'])
            || pattern.contains(['\0', '\r', '\n', '\\'])
            || pattern
                .split('/')
                .any(|p| p == "." || p == ".." || p.is_empty())
        {
            return Err(Code::InvalidRequest);
        }
        builder.add(
            GlobBuilder::new(pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map_err(|_| Code::InvalidRequest)?,
        );
    }
    builder.build().map_err(|_| Code::InvalidRequest)
}

// Reads only confined, bounded regular files; invalid policy data fails closed.
fn policy_bytes(root: &OwnedFd, path: &str, deadline: Instant) -> Result<Option<Vec<u8>>, Code> {
    expired(deadline)?;
    let fd = match fs::openat2(
        root,
        path,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(Code::ReadFailed),
    };
    capture(&fd, 65_536, deadline, || {})
        .map_err(|code| {
            if code == Code::SourceMutated {
                Code::PolicyChanged
            } else {
                code
            }
        })?
        .map(Some)
        .ok_or(Code::ReadFailed)
}

pub struct Scope {
    groups: Vec<GlobSet>,
    exclude: GlobSet,
    hidden: bool,
    respect_ignore: bool,
    rules: BTreeMap<String, Vec<Gitignore>>,
    observations: BTreeMap<String, Option<Vec<u8>>>,
    policy_bytes: usize,
    policy_lines: usize,
}
impl Scope {
    pub fn new(input: &ScopeInput) -> Result<Self, Code> {
        if input.include_groups.len() > 2 || input.include_groups.iter().any(|g| g.len() > 64) {
            return Err(Code::InvalidRequest);
        }
        Ok(Self {
            groups: input
                .include_groups
                .iter()
                .map(|g| globs(g))
                .collect::<Result<_, _>>()?,
            exclude: globs(&input.exclude)?,
            hidden: input.hidden,
            respect_ignore: input.respect_ignore,
            rules: BTreeMap::new(),
            observations: BTreeMap::new(),
            policy_bytes: 0,
            policy_lines: 0,
        })
    }
    pub fn excluded_path(&self, path: &str) -> bool {
        path.split('/')
            .any(|p| p == ".jev-grep" || p == ".git" || (!self.hidden && p.starts_with('.')))
    }
    pub fn enter(&mut self, root: &OwnedFd, prefix: &str, deadline: Instant) -> Result<(), Code> {
        if !self.respect_ignore {
            return Ok(());
        }
        // Bound both absence records and compiled-policy input across a traversal.
        if self.observations.len() >= 4096 {
            return Err(Code::EntryLimit);
        }
        let mut compiled = Vec::new();
        for name in [".gitignore", ".ignore"] {
            let mut builder = GitignoreBuilder::new(if prefix.is_empty() { "." } else { prefix });
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            let bytes = policy_bytes(root, &path, deadline)?;
            if let Some(bytes) = &bytes {
                self.policy_bytes += bytes.len();
                if self.policy_bytes > 1_048_576 {
                    return Err(Code::EntryLimit);
                }
                for line in std::str::from_utf8(bytes)
                    .map_err(|_| Code::ReadFailed)?
                    .lines()
                {
                    expired(deadline)?;
                    self.policy_lines += 1;
                    if self.policy_lines > 4096 {
                        return Err(Code::EntryLimit);
                    }
                    builder
                        .add_line(Some(path.clone().into()), line)
                        .map_err(|_| Code::ReadFailed)?;
                }
            }
            self.observations.insert(path, bytes);
            compiled.push(builder.build().map_err(|_| Code::ReadFailed)?);
        }
        self.rules.insert(prefix.to_owned(), compiled);
        Ok(())
    }
    pub fn allows(&self, path: &str, directory: bool) -> bool {
        if self.exclude.is_match(path) {
            return false;
        }
        // Positive include rules select files. Never prune ancestors of potential matches.
        if !directory
            && self
                .groups
                .iter()
                .any(|g| !g.is_empty() && !g.is_match(path))
        {
            return false;
        }
        if self.respect_ignore {
            // .ignore precedence applies across depths, then deepest rule wins within a kind.
            for kind in [1, 0] {
                let mut parent = path.rsplit_once('/').map_or("", |(p, _)| p);
                loop {
                    if let Some(rules) = self.rules.get(parent) {
                        let matched = rules[kind].matched(path, directory);
                        if matched.is_ignore() {
                            return false;
                        }
                        if matched.is_whitelist() {
                            return true;
                        }
                    }
                    if parent.is_empty() {
                        break;
                    }
                    parent = parent.rsplit_once('/').map_or("", |(p, _)| p);
                }
            }
        }
        true
    }
    pub fn snapshot_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        // Sorted paths, explicit absence, exact captured bytes; versioned domain.
        let mut hash = Sha256::new();
        hash.update(b"jev-ignore-snapshot-v1\0");
        for (path, bytes) in &self.observations {
            hash.update((path.len() as u64).to_be_bytes());
            hash.update(path.as_bytes());
            match bytes {
                None => hash.update([0]),
                Some(bytes) => {
                    hash.update([1]);
                    hash.update((bytes.len() as u64).to_be_bytes());
                    hash.update(bytes);
                }
            }
        }
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
    pub fn verify(&self, root: &OwnedFd, deadline: Instant) -> Result<(), Code> {
        for (path, captured) in &self.observations {
            if &policy_bytes(root, path, deadline)? != captured {
                return Err(Code::PolicyChanged);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_revalidation_detects_edits_creation_and_removal() {
        let path = std::env::temp_dir().join(format!("jev-policy-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        let root = fs::open(&path, OFlags::PATH | OFlags::DIRECTORY, Mode::empty()).unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let input: ScopeInput = serde_json::from_str(r#"{"respectIgnore":true}"#).unwrap();
        let mut scope = Scope::new(&input).unwrap();
        scope.enter(&root, "", deadline).unwrap();
        std::fs::write(path.join(".gitignore"), "*.log\n").unwrap();
        assert_eq!(scope.verify(&root, deadline), Err(Code::PolicyChanged));
        let mut scope = Scope::new(&input).unwrap();
        scope.enter(&root, "", deadline).unwrap();
        let old_hash = scope.snapshot_hash();
        std::fs::write(path.join(".gitignore"), "*.txt\n").unwrap();
        assert_eq!(scope.verify(&root, deadline), Err(Code::PolicyChanged));
        let mut scope = Scope::new(&input).unwrap();
        scope.enter(&root, "", deadline).unwrap();
        assert_ne!(old_hash, scope.snapshot_hash());
        std::fs::remove_file(path.join(".gitignore")).unwrap();
        assert_eq!(scope.verify(&root, deadline), Err(Code::PolicyChanged));
        std::fs::remove_dir(path).unwrap();
    }
}
