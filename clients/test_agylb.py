"""Behaviour tests: private fake homes/accounts, never the operator's login."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import stat
import subprocess
import sys
import termios
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("agylb.py")
spec = importlib.util.spec_from_file_location("agylb", SCRIPT)
agylb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agylb)


class Pool:
    def __init__(self):
        self.requests = []
        self.spent = set()
        self.status = 200
        pool = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.reply()

            def do_POST(self):
                self.reply(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))

            def reply(self, body=None):
                pool.requests.append((self.path, self.headers.get("x-api-key"), body))
                if self.headers.get("x-api-key") != "station-secret":
                    self.send_error(403)
                    return
                if pool.status != 200:
                    self.send_error(pool.status)
                    return
                if body:
                    pool.spent.add(body["accountId"])
                current = self.path.partition("current=")[2]
                names = [name for name in ("account-a", "account-b") if name not in pool.spent]
                name = current if current in names else next(iter(names), None)
                if name is None:
                    self.send_error(404)
                    return
                reply = {"account": {"id": name}, "token": {"token": {"refresh_token": "secret-" + name}}}
                raw = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agylb-test-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "real-home"
        self.home.mkdir()
        self.work = self.root / "project"
        self.work.mkdir()
        self.pool = Pool()
        self.stub = self.root / "agy"
        self.stub.write_text(f"""#!{sys.executable}
import json, os, signal, sys, time
from pathlib import Path
home = Path.home()
token = home / '.gemini/antigravity-cli/antigravity-oauth-token'
secret = json.loads(token.read_text())['token']['refresh_token']
log = Path(sys.argv[sys.argv.index('--log-file') + 1])
mode = os.environ.get('STUB_MODE', 'ok')
if os.environ.get('TRACE_FILE'):
    with open(os.environ['TRACE_FILE'], 'a') as trace:
        trace.write(json.dumps(sys.argv[1:]) + '\\n')
if mode == 'quota' and secret.endswith('account-a'):
    log.write_text('failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h2m3s.), retrying\\n')
    time.sleep(30)
elif mode == 'large':
    log.write_text('x' * 300000 + '\\nRESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h.\\n')
elif mode == 'rate':
    log.write_text('RESOURCE_EXHAUSTED (code 429): Too many requests\\n')
    sys.exit(7)
elif mode == 'hang':
    Path(os.environ['PID_FILE']).write_text(str(os.getpid()))
    time.sleep(30)
elif mode == 'tty':
    print('TTY_READY', flush=True)
    print('ANSWER:' + input(), flush=True)
else:
    history = home / 'history-test'
    if '--continue' in sys.argv:
        assert history.read_text() == 'saved conversation'
    else:
        history.write_text('saved conversation')
    assert 'AGENT_LB_API_KEY' not in os.environ
    assert 'CODEX_LB_API_KEY' not in os.environ
    if mode == 'refresh':
        token.write_text(json.dumps({{'token': {{'refresh_token': 'refreshed-account-a'}}}}))
    print('OK:' + secret.removeprefix('secret-'), flush=True)
""")
        self.stub.chmod(0o700)
        self.env = {**os.environ, "HOME": str(self.home), "AGENT_LB_URL": self.pool.url,
                    "AGENT_LB_API_KEY": "station-secret", "CODEX_LB_API_KEY": "other-secret",
                    "AGYLB_HOME": str(self.root / "state"), "AGYLB_COMMAND": str(self.stub)}

    def tearDown(self):
        self.pool.close()
        self.temporary.cleanup()

    def run_cli(self, *args, mode="ok"):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.work,
                              env={**self.env, "STUB_MODE": mode}, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)

    def profile(self):
        return next((self.root / "state/workspaces").iterdir())

    def account_home(self, account='account-a'):
        return self.profile() / 'accounts' / hashlib.sha256(account.encode()).hexdigest()[:24] / 'home'

    def test_history_survives_success_and_continue_and_local_login_untouched(self):
        local = self.home / agylb.TOKEN_REL
        local.parent.mkdir(parents=True)
        local.write_text('original login')
        first = self.run_cli()
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.run_cli('--continue')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(local.read_text(), 'original login')
        token = self.account_home() / agylb.TOKEN_REL
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.profile().stat().st_mode), 0o700)
        self.assertNotIn('secret-', first.stdout + first.stderr)

    def test_refreshed_token_is_not_overwritten_on_next_run(self):
        self.assertEqual(self.run_cli(mode='refresh').returncode, 0)
        resumed = self.run_cli('--continue')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn('refreshed-account-a', resumed.stdout)

    def test_quota_reports_reset_and_never_replays_prompt(self):
        self.assertEqual(self.run_cli().returncode, 0)
        started = time.monotonic()
        result = self.run_cli('--print', 'DO NOT REPLAY', mode='quota')
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertLess(time.monotonic() - started, 5)
        reports = [body for path, key, body in self.pool.requests if path == '/agy/quota']
        self.assertEqual(reports, [{'accountId': 'account-a', 'resetSeconds': 3723.0, 'message': 'AGY quota exhausted'}])
        self.assertNotIn('OK:account-b', result.stdout)
        self.assertEqual((self.account_home() / 'history-test').read_text(), 'saved conversation')
        resumed = self.run_cli('--continue')
        self.assertEqual(resumed.returncode, 1)
        self.assertIn('Konto się zmieniło', resumed.stderr)
        fresh = self.run_cli()
        self.assertEqual(fresh.returncode, 0, fresh.stderr)
        self.assertIn('OK:account-b', fresh.stdout)
        self.assertEqual((self.account_home() / 'history-test').read_text(), 'saved conversation')
        self.assertNotEqual(self.account_home(), self.account_home('account-b'))

    def test_models_does_not_allow_resume_on_another_account(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.run_cli(mode='quota').returncode, 75)
        self.assertEqual(self.run_cli('models').returncode, 0)
        resumed = self.run_cli('--continue')
        self.assertEqual(resumed.returncode, 1)
        self.assertIn('Konto się zmieniło', resumed.stderr)
        self.assertEqual((self.account_home() / 'history-test').read_text(), 'saved conversation')

    def test_quota_at_end_of_large_log_is_detected_after_fast_exit(self):
        result = self.run_cli(mode='large')
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn('account-a', self.pool.spent)

    def test_plain_rate_limit_does_not_rotate(self):
        result = self.run_cli(mode='rate')
        self.assertEqual(result.returncode, 7)
        self.assertFalse(any(body for path, key, body in self.pool.requests))

    def test_denied_station_fails_closed_and_does_not_launch_agy(self):
        self.pool.status = 403
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('nie ma zgody', result.stderr)
        self.assertFalse((self.profile() / 'home').exists())

    def test_doctor_does_not_install_token(self):
        result = self.run_cli('doctor')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('dostępna', result.stdout)
        self.assertFalse((self.profile() / 'home').exists())

    def test_doctor_finds_local_agy_even_when_user_bin_is_not_on_path(self):
        backend = self.home / '.local/bin/agy'
        backend.parent.mkdir(parents=True)
        backend.write_text(self.stub.read_text())
        backend.chmod(0o700)
        env = {**self.env, 'PATH': '/usr/bin:/bin'}
        env.pop('AGYLB_COMMAND')
        result = subprocess.run([sys.executable, str(SCRIPT), 'doctor'], cwd=self.work,
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(backend), result.stdout)

    def test_other_workspace_has_independent_profile(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.work = self.root / 'other-project'
        self.work.mkdir()
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(list((self.root / 'state/workspaces').iterdir())), 2)

    def test_signal_stops_child_and_releases_lock(self):
        pid_file = self.root / 'child.pid'
        proc = subprocess.Popen([sys.executable, str(SCRIPT)], cwd=self.work,
                                env={**self.env, 'STUB_MODE': 'hang', 'PID_FILE': str(pid_file)},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pid_file.exists())
            duplicate = self.run_cli()
            self.assertEqual(duplicate.returncode, 1)
            self.assertIn('już działa', duplicate.stderr)
            child_pid = int(pid_file.read_text())
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 143)
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
            self.assertEqual(self.run_cli().returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_killed_launcher_keeps_profile_locked_while_child_lives(self):
        pid_file = self.root / 'child.pid'
        proc = subprocess.Popen([sys.executable, str(SCRIPT)], cwd=self.work,
                                env={**self.env, 'STUB_MODE': 'hang', 'PID_FILE': str(pid_file)},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child_pid = None
        try:
            deadline = time.monotonic() + 5
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pid_file.exists())
            child_pid = int(pid_file.read_text())
            proc.kill()
            proc.wait(timeout=5)
            duplicate = self.run_cli()
            self.assertEqual(duplicate.returncode, 1)
            self.assertIn('już działa', duplicate.stderr)
        finally:
            if child_pid:
                os.killpg(child_pid, signal.SIGTERM)
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=5)

    def run_terminal(self, mode, until, answer):
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        proc = subprocess.Popen([sys.executable, str(SCRIPT)], cwd=self.work,
                                env={**self.env, 'STUB_MODE': mode}, stdin=slave, stdout=slave, stderr=slave)
        output = b''
        sent = False
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
                if until in output and not sent:
                    os.write(master, answer)
                    sent = True
                if proc.poll() is not None:
                    while select.select([master], [], [], 0)[0]:
                        output += os.read(master, 65536)
                    break
            self.assertIsNotNone(proc.poll(), output.decode(errors='replace'))
            self.assertTrue(sent, output.decode(errors='replace'))
            self.assertEqual(termios.tcgetattr(slave), original)
            return proc.returncode, output.decode(errors='replace')
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)
            os.close(master)
            os.close(slave)

    def test_interactive_terminal_relays_input_and_restores_settings(self):
        code, output = self.run_terminal('tty', b'TTY_READY', b'hello\n')
        self.assertEqual(code, 0, output)
        self.assertIn('ANSWER:hello', output)

    def test_interactive_rotation_asks_then_starts_a_fresh_conversation(self):
        code, output = self.run_terminal('quota', b'[t/N]', b't\n')
        self.assertEqual(code, 0, output)
        self.assertIn('OK:account-b', output)
        self.assertIn('account-a', self.pool.spent)

    def test_interactive_default_declines_rotation(self):
        code, output = self.run_terminal('quota', b'[t/N]', b'\n')
        self.assertEqual(code, 75, output)
        self.assertNotIn('OK:account-b', output)


class SmallTests(unittest.TestCase):
    def test_reset_parsing(self):
        self.assertEqual(agylb.reset_seconds('Resets in 2d1h3m4s'), 176584)
        self.assertIsNone(agylb.reset_seconds('Too many requests'))

    def test_config_rejects_cleartext_remote_url(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'AGENT_LB_URL': 'http://example.com', 'AGENT_LB_API_KEY': 'fake'}):
            with self.assertRaises(agylb.LauncherError):
                agylb.configuration(Path(directory))

    def test_help_requires_no_account(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('agylb --continue', result.stdout)

    def test_dedicated_station_configuration_wins_over_shell_api_key(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / '.config/agylb/config.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'url': 'https://station.invalid', 'key': 'dedicated'}))
            with patch.dict(os.environ, {'AGENT_LB_URL': 'https://generic.invalid', 'AGENT_LB_API_KEY': 'generic'}):
                self.assertEqual(agylb.configuration(home), ('https://station.invalid', 'dedicated'))

    def test_installer_is_atomic_private_and_keeps_existing_version(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            payload = {'source': SCRIPT.read_text(), 'settings': {'url': 'https://station.invalid', 'key': 'test-station-secret'}}
            command = [sys.executable, '-B', str(SCRIPT.with_name('install_agylb.py'))]
            first = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, env={**os.environ, 'HOME': str(home)})
            self.assertEqual(first.returncode, 0, first.stderr)
            executable = home / '.local/bin/agylb'
            config = home / '.config/agylb/config.json'
            self.assertEqual(executable.read_text(), SCRIPT.read_text())
            self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
            self.assertNotIn('test-station-secret', first.stdout + first.stderr)
            payload['source'] += '\n# next revision\n'
            second = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, env={**os.environ, 'HOME': str(home)})
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(next(executable.parent.glob('agylb.bak-*')).read_text(), SCRIPT.read_text())


if __name__ == '__main__':
    unittest.main()
