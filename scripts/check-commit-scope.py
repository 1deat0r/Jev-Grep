#!/usr/bin/env python3
"""Scan indexed bytes, not unstaged working files. Never print secret contents."""
import argparse
import re
import subprocess
import sys

PATTERNS = [
    r'sk-(?:live|test|proj|ant)-', r'github[_]pat[_]', r'gh[ous]_', r'glpat[-]',
    r'xox[oabps]-', r'AKIA[A-Z0-9]{16}', r'[sr]k_live_[A-Za-z0-9]',
    r'-----BEGIN (?:OPENSSH |[A-Z0-9 ]+ )?PRIVATE KEY-----',
    r'bearer\s+[A-Za-z0-9]', r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}',
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tracked', action='store_true', help='scan all tracked files for CI')
    args = parser.parse_args()
    command = ['git', 'ls-files', '-z'] if args.tracked else ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    paths = subprocess.check_output(command).split(b'\0')
    paths = [p for p in paths if p]
    if not paths:
        print('Commit scope: no files to scan.')
        return 0
    ignored = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin', '-z'], input=b'\0'.join(paths)+b'\0', capture_output=True)
    if ignored.returncode not in (0, 1):
        raise RuntimeError('Cannot verify ignore rules')
    failures = [(p, 'ignored path') for p in ignored.stdout.split(b'\0') if p]
    detectors = [re.compile(p.encode(), re.IGNORECASE) for p in PATTERNS]
    for path in paths:
        data = subprocess.check_output(['git', 'show', b':' + path])
        if any(p.search(data) for p in detectors):
            failures.append((path, 'credential-shaped content'))
    for path, reason in failures:
        print(f'BLOCKED: {path.decode(errors="backslashreplace")!r}: {reason}', file=sys.stderr)
    if failures:
        return 1
    print(f'Commit scope: {len(paths)} indexed files checked.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
