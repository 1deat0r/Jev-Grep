#!/usr/bin/env python3
"""Linux feasibility prototype only: O_PATH/openat2 -> regular-file check -> read.

No production API, traversal, ignore policy, or index. Operates on disposable fixtures.
Requires a trusted mounted /proc. Syscall number is verified for x86_64/aarch64 only.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import stat
import tempfile
import threading
import time
import unittest


class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.syscall.restype = ctypes.c_long


def capture(root_fd, relative, limit=1024, cancelled=None, deadline=None, after_inspect=None):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise RuntimeError('Unsupported prototype platform')
    if not relative or any(c in ('', '.', '..') for c in relative.split('/')) or '\0' in relative:
        raise ValueError('Invalid relative path')
    def budget():
        if cancelled is not None and cancelled.is_set():
            raise InterruptedError('Cancelled')
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('Deadline')
    budget()
    # RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS.
    how = OpenHow(os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW, 0, 0x08 | 0x04 | 0x02)
    anchor = LIBC.syscall(ctypes.c_long(437), ctypes.c_int(root_fd),
                          ctypes.c_char_p(os.fsencode(relative)), ctypes.byref(how), ctypes.c_size_t(ctypes.sizeof(how)))
    if anchor < 0:
        raise OSError(ctypes.get_errno(), 'Confined open rejected')
    try:
        before = os.fstat(anchor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('Only regular files are eligible')
        if before.st_size > limit:
            raise ValueError('File too large')
        if after_inspect:
            after_inspect()
        budget()
        # Reopen the pinned object, not the path that may now identify another file.
        fd = os.open(f'/proc/self/fd/{anchor}', os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError('Descriptor identity changed')
            chunks = bytearray()
            while True:
                budget()
                chunk = os.read(fd, min(65536, limit + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
                if len(chunks) > limit:
                    raise ValueError('File grew beyond limit')
            after = os.fstat(fd)
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('Source mutated')
            return bytes(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(anchor)


class ConfinementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jev-confine-')
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        self.root.mkdir()
        (self.root / 'ok').write_bytes(b'captured\r\n')
        (self.base / 'outside').write_bytes(b'MUST-NOT-READ')
        self.fd = os.open(self.root, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)

    def tearDown(self):
        os.close(self.fd)
        self.tmp.cleanup()

    def test_regular_bytes_and_hash(self):
        result = capture(self.fd, 'ok')
        self.assertEqual(result, b'captured\r\n')
        self.assertEqual(hashlib.sha256(result).digest(), hashlib.sha256(b'captured\r\n').digest())

    def test_traversal_absolute_and_ambiguous_paths(self):
        for path in ['../outside', '/etc/passwd', 'a/../ok', './ok', 'a//ok']:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                capture(self.fd, path)

    def test_symlink_and_directory_escape(self):
        (self.root / 'link').symlink_to(self.base / 'outside')
        (self.root / 'dir').symlink_to(self.base, target_is_directory=True)
        for path in ['link', 'dir/outside']:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                capture(self.fd, path)

    def test_fifo_and_socket_do_not_block(self):
        os.mkfifo(self.root / 'pipe')
        with socket.socket(socket.AF_UNIX) as sock:
            sock.bind(str(self.root / 'socket'))
            begin = time.monotonic()
            for path in ['pipe', 'socket']:
                with self.assertRaises(ValueError):
                    capture(self.fd, path, deadline=begin + 1)
            self.assertLess(time.monotonic() - begin, 1)

    def test_device_object_rejected_before_read(self):
        dev = os.open('/dev', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            with self.assertRaises(ValueError):
                capture(dev, 'null')
        finally:
            os.close(dev)

    def test_substitution_after_inspection_never_reads_new_target(self):
        def substitute():
            (self.root / 'ok').rename(self.root / 'old')
            (self.root / 'ok').symlink_to(self.base / 'outside')
        try:
            self.assertEqual(capture(self.fd, 'ok', after_inspect=substitute), b'captured\r\n')
        except ValueError as error:
            self.assertEqual(str(error), 'Source mutated')

    def test_root_replacement_keeps_registered_directory(self):
        self.root.rename(self.base / 'old-root')
        self.root.symlink_to(self.base, target_is_directory=True)
        self.assertEqual(capture(self.fd, 'ok'), b'captured\r\n')

    def test_growth_is_bounded(self):
        def grow():
            with (self.root / 'ok').open('ab') as f:
                f.write(b'x' * 2048)
        with self.assertRaisesRegex(ValueError, 'grew beyond limit'):
            capture(self.fd, 'ok', limit=64, after_inspect=grow)

    def test_deadline_and_cancellation(self):
        with self.assertRaises(TimeoutError):
            capture(self.fd, 'ok', deadline=time.monotonic() - 1)
        event = threading.Event()
        with self.assertRaises(InterruptedError):
            capture(self.fd, 'ok', cancelled=event, after_inspect=event.set)

    def test_concurrent_parent_symlink_swap(self):
        directory = self.root / 'dir'
        directory.mkdir()
        (directory / 'outside').write_bytes(b'inside')
        parked = self.root / 'parked'
        stop = threading.Event()
        def swap():
            while not stop.is_set():
                directory.rename(parked)
                directory.symlink_to(self.base, target_is_directory=True)
                directory.unlink()
                parked.rename(directory)
        worker = threading.Thread(target=swap)
        worker.start()
        try:
            for _ in range(500):
                try:
                    self.assertEqual(capture(self.fd, 'dir/outside'), b'inside')
                except OSError as error:
                    self.assertIn(error.errno, [errno.ENOENT, errno.ELOOP, errno.EXDEV, errno.EAGAIN])
        finally:
            stop.set()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())


if __name__ == '__main__':
    begin = time.monotonic()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ConfinementTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {
        'kind': 'feasibility-not-release-acceptance', 'system': platform.platform(),
        'python': platform.python_version(), 'tests': result.testsRun,
        'failures': len(result.failures), 'errors': len(result.errors),
        'elapsedMs': round((time.monotonic() - begin) * 1000, 3),
        'limitations': ['Python prototype; production helper unimplemented',
                        'Cannot bound kernel I/O stalls with userspace deadline checks alone',
                        'Mutation detection is observational, not an atomic snapshot'],
    }
    output = Path('spikes/results/confinement.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
