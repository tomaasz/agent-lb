#!/usr/bin/env python3
"""Install a JSON bundle read on stdin; never print its station key."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def install_file(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        if path.is_symlink():
            raise RuntimeError('Refusing to replace symlink')
        previous = path.read_bytes()
        if previous == content:
            path.chmod(mode)
            return
        backup = path.with_name(path.name + '.bak-' + hashlib.sha256(previous).hexdigest()[:12])
        if not backup.exists():
            fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(previous)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    payload = json.load(sys.stdin)
    source = payload['source']
    compile(source, 'agylb', 'exec')
    settings = payload['settings']
    if not isinstance(settings.get('url'), str) or not isinstance(settings.get('key'), str) or not settings['key']:
        raise RuntimeError('Invalid station configuration')
    config_dir = Path.home() / '.config/agylb'
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config_dir.chmod(0o700)
    install_file(Path.home() / '.local/bin/agylb', source.encode(), 0o700)
    install_file(config_dir / 'config.json', json.dumps(settings).encode(), 0o600)
    print('Installed agylb; source sha256=' + hashlib.sha256(source.encode()).hexdigest())


if __name__ == '__main__':
    main()
