#!/usr/bin/env python3
"""Retry installation on an explicit private queue of temporarily offline hosts."""

import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys


def main():
    directory = Path(sys.argv[1]).resolve()
    lock_fd = os.open(directory / 'rollout.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        installer = Path(__file__).with_name('install_agylb.py').read_text()
        for payload_file in sorted(directory.glob('*.pending.json')):
            host = payload_file.name.removesuffix('.pending.json')
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', host):
                print('Invalid host in queue', flush=True)
                continue
            ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', host]
            # Check dependencies before touching remote files. The installer
            # never runs if this machine has no AGY backend yet.
            try:
                probe = subprocess.run(ssh + ["python3 -c 'import sys; sys.exit(sys.version_info < (3,8))' && command -v agy >/dev/null"],
                                       capture_output=True, timeout=10)
                if probe.returncode:
                    print(host + ': waiting for SSH and AGY', flush=True)
                    continue
                installed = subprocess.run(ssh + ['python3 -c ' + shlex.quote(installer)],
                                           input=payload_file.read_bytes(), capture_output=True, timeout=25)
                if installed.returncode:
                    print(host + ': install pending', flush=True)
                    continue
                verified = subprocess.run(ssh + ['"$HOME/.local/bin/agylb" doctor'], capture_output=True, timeout=20)
                if verified.returncode:
                    print(host + ': installed; station access pending', flush=True)
                    continue
                # Keep only the successful audit marker; credentials remain in
                # the remote private config, not in an extra local bundle.
                payload_file.with_suffix('.done').write_text('Installed and doctor passed\n')
                payload_file.unlink()
                print(host + ': installed and verified', flush=True)
            except (subprocess.TimeoutExpired, OSError):
                print(host + ': waiting for SSH', flush=True)
        if not list(directory.glob('*.pending.json')):
            subprocess.run(['systemctl', '--user', 'disable', '--now', 'agylb-rollout.timer'], capture_output=True)
            print('All queued hosts complete', flush=True)


if __name__ == '__main__':
    main()
