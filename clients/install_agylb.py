#!/usr/bin/env python3
"""Install a JSON bundle read on stdin; never print its station key."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

POSIX_YOLO_SHIM = (
    '#!/bin/sh\n'
    'AGYLB_SKIP_PERMISSIONS=1 exec "$(dirname "$0")/agylb" "$@"\n'
)
POSIX_PATH_MARKER = '# agylb-path'
POSIX_PATH_LINE = (
    'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; '
    '*) export PATH="$HOME/.local/bin:$PATH" ;; esac  # agylb-path'
)


def install_file(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        if path.is_symlink():
            raise RuntimeError('Refusing to replace symlink')
        previous = path.read_bytes()
        if previous == content:
            if os.name != 'nt':
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
            if hasattr(os, 'fchmod'):
                os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def windows_oem_encoding():
    if os.name == 'nt':
        try:
            import ctypes
            cp = ctypes.windll.kernel32.GetOEMCP()
            if cp:
                return f'cp{cp}'
        except Exception:
            pass
        return 'mbcs'
    return 'utf-8'


def windows_shims(python_executable, encoding=None):
    exe = python_executable or 'python'
    if any(ch in exe for ch in '"\r\n'):
        exe = 'python'
    escaped_exe = exe.replace('%', '%%')
    enc = encoding or windows_oem_encoding()
    agylb_cmd = (
        '@echo off\r\n'
        'setlocal\r\n'
        f'"{escaped_exe}" "%~dp0agylb.py" %*\r\n'
        'exit /b %ERRORLEVEL%\r\n'
    )
    yolo_cmd = (
        '@echo off\r\n'
        'setlocal\r\n'
        'set "AGYLB_SKIP_PERMISSIONS=1"\r\n'
        f'"{escaped_exe}" "%~dp0agylb.py" %*\r\n'
        'exit /b %ERRORLEVEL%\r\n'
    )
    return agylb_cmd.encode(enc), yolo_cmd.encode(enc)


def ensure_posix_path(home):
    updated = []
    for rc_name in ('.bashrc', '.zshrc', '.profile'):
        rc = home / rc_name
        if not rc.is_file() or rc.is_symlink():
            continue
        try:
            content = rc.read_text(encoding='utf-8')
        except OSError:
            continue
        if POSIX_PATH_MARKER in content or '.local/bin' in content:
            continue
        try:
            sep = '' if (not content or content.endswith('\n')) else '\n'
            with rc.open('a', encoding='utf-8') as stream:
                stream.write(sep + POSIX_PATH_LINE + '\n')
            updated.append(rc_name)
        except OSError:
            continue
    return updated


def ensure_windows_user_path(bin_dir):
    if os.name != 'nt':
        return False
    try:
        import winreg
        target = str(bin_dir)
        norm_target = os.path.normcase(os.path.normpath(target))
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
            try:
                current, reg_type = winreg.QueryValueEx(key, 'Path')
            except FileNotFoundError:
                current, reg_type = '', winreg.REG_EXPAND_SZ
            entries = [p for p in str(current).split(';') if p]
            if any(os.path.normcase(os.path.normpath(p)) == norm_target for p in entries):
                return False
            updated = ';'.join([*entries, target]) if entries else target
            winreg.SetValueEx(key, 'Path', 0, reg_type if reg_type in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) else winreg.REG_EXPAND_SZ, updated)
        try:
            import ctypes
            # Notify Explorer and new shells about the updated HKCU Environment.
            ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001A, 0, 'Environment', 0x0002, 5000, ctypes.byref(ctypes.c_ulong()))
        except Exception:
            pass
        return True
    except OSError:
        return False


def main():
    payload = json.load(sys.stdin)
    source = payload['source']
    compile(source, 'agylb', 'exec')
    settings = payload['settings']
    if not isinstance(settings.get('url'), str) or not isinstance(settings.get('key'), str) or not settings['key']:
        raise RuntimeError('Invalid station configuration')
    home = Path.home()
    config_dir = home / '.config/agylb'
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        config_dir.chmod(0o700)
    bin_dir = home / '.local/bin'
    source_bytes = source.encode('utf-8')
    if os.name == 'nt':
        agylb_cmd, yolo_cmd = windows_shims(sys.executable)
        install_file(bin_dir / 'agylb.py', source_bytes, 0o700)
        install_file(bin_dir / 'agylb.cmd', agylb_cmd, 0o700)
        install_file(bin_dir / 'agylb-yolo.cmd', yolo_cmd, 0o700)
        ensure_windows_user_path(bin_dir)
    else:
        install_file(bin_dir / 'agylb', source_bytes, 0o700)
        install_file(bin_dir / 'agylb-yolo', POSIX_YOLO_SHIM.encode('utf-8'), 0o700)
        ensure_posix_path(home)
    install_file(config_dir / 'config.json', json.dumps(settings).encode('utf-8'), 0o600)
    print('Installed agylb and agylb-yolo; source sha256=' + hashlib.sha256(source_bytes).hexdigest())


if __name__ == '__main__':
    main()
