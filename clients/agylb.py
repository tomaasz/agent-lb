#!/usr/bin/env python3
"""Interactive AGY launcher using the shared AgentLB account pool (POSIX)."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import termios
import time
import tty
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "0.1.0"
QUOTA = re.compile(r"RESOURCE_EXHAUSTED \(code 429\):\s*([^()\r\n]*quota[^()\r\n]*)", re.I)
TOKEN_REL = Path(".gemini/antigravity-cli/antigravity-oauth-token")


class LauncherError(Exception):
    pass


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise LauncherError("Niebezpieczny katalog profilu.")
    path.chmod(0o700)


def save_json(path: Path, value: dict) -> None:
    private_dir(path.parent)
    temporary = path.with_name(f".{path.name}-{uuid.uuid4().hex}")
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path: Path) -> dict:
    try:
        with path.open() as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise LauncherError("Niepoprawna konfiguracja agylb.")
    return value


def configuration(real_home: Path) -> tuple[str, str]:
    values = {}
    for path in (real_home / ".config/agent-lb.env", real_home / ".config/agybridge/agybridge.env"):
        try:
            for line in path.read_text().splitlines():
                match = re.match(r"\s*(?:export\s+)?(AGENT_LB_URL|AGENT_LB_API_KEY)=(.*)$", line)
                if match:
                    values[match[1]] = match[2].strip().strip("\"'")
        except FileNotFoundError:
            pass
    config = load_json(real_home / ".config/agylb/config.json")
    # A dedicated station key must take precedence over the generic API-only
    # key exported by existing shell integrations on this host.
    url = config.get("url") or os.environ.get("AGENT_LB_URL") or values.get("AGENT_LB_URL") or "https://agentlb.gotova.pl"
    key = config.get("key") or os.environ.get("AGENT_LB_API_KEY") or values.get("AGENT_LB_API_KEY")
    if not isinstance(url, str) or not isinstance(key, str) or not key or any(c in key for c in "\r\n"):
        raise LauncherError("Brak poprawnego klucza stacji w konfiguracji agylb.")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1"))) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise LauncherError("Adres AgentLB wymaga HTTPS (HTTP dozwolone tylko lokalnie).")
    return url.rstrip("/"), key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def pool_request(url: str, key: str, endpoint: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url + endpoint, data=data, headers={"x-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise LauncherError("Odpowiedź AgentLB jest zbyt duża.")
        reply = json.loads(raw)
    except urllib.error.HTTPError as exc:
        messages = {401: "Klucz stacji został odrzucony.", 403: "Klucz stacji nie ma zgody na pobieranie kont Google.", 404: "W puli nie ma konta z wolnym limitem."}
        raise LauncherError(messages.get(exc.code, f"AgentLB zwrócił HTTP {exc.code}.")) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise LauncherError("Nie udało się pobrać konta z AgentLB.") from None
    if not isinstance(reply, dict):
        raise LauncherError("Niepoprawna odpowiedź AgentLB.")
    account, token = reply.get("account"), reply.get("token")
    if not isinstance(account, dict) or not isinstance(account.get("id"), str) or not account["id"] or not isinstance(token, dict) or not isinstance(token.get("token"), dict) or not token["token"].get("refresh_token"):
        raise LauncherError("AgentLB nie zwrócił poprawnego konta Google.")
    return reply


def reset_seconds(message: str) -> float | None:
    match = re.search(r"Resets in\s+((?:\d+(?:\.\d+)?[dhms])+)", message, re.I)
    if not match:
        return None
    return sum(float(n) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit.lower()] for n, unit in re.findall(r"(\d+(?:\.\d+)?)([dhms])", match[1], re.I)) or None


class LogWatcher:
    def __init__(self, path: Path):
        self.path = path
        self.position = 0
        self.pending = b""

    def check(self, drain: bool = False) -> str | None:
        while True:
            message, more = self._read()
            if message or not drain or not more:
                return message

    def _read(self) -> tuple[str | None, bool]:
        with self.path.open("rb") as stream:
            stream.seek(self.position)
            chunk = stream.read(65536)
            self.position = stream.tell()
        lines = (self.pending + chunk).split(b"\n")
        self.pending = lines.pop()[-65536:]
        for line in lines:
            match = QUOTA.search(line.decode("utf8", errors="replace"))
            if match:
                return match[1].strip(), bool(chunk)
        return None, bool(chunk)


def child_environment(profile_home: Path) -> dict:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("AGENT_LB_", "AGENTLB_", "CODEX_LB_", "AGYLB_", "HERMES_AGY_"))}
    env["HOME"] = str(profile_home)
    # Keep AGY updates under the normal installation process.
    env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "1"
    return env


def run_agy(command: str, args: list[str], profile_home: Path, log: Path, lock_fd: int) -> tuple[int, str | None]:
    env = child_environment(profile_home)
    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    master = None
    old_terminal = termios.tcgetattr(0) if interactive else None
    proc = None
    if interactive:
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.set_inheritable(lock_fd, True)
                os.execve(command, [command, "--log-file", str(log), *args], env)
            except OSError:
                os._exit(127)
    else:
        proc = subprocess.Popen([command, "--log-file", str(log), *args], env=env, start_new_session=True, pass_fds=(lock_fd,))
        pid = proc.pid
    watcher = LogWatcher(log)
    stop_at = None
    cancelled = None
    quota = None
    previous_handlers = {}

    def send(sig):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, sig)

    def interrupted(sig, frame):
        nonlocal cancelled, stop_at
        cancelled = sig
        send(sig)
        stop_at = time.monotonic() + 3

    def resize(sig=None, frame=None):
        if master is not None:
            with contextlib.suppress(OSError):
                fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))

    try:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGWINCH):
            previous_handlers[sig] = signal.signal(sig, resize if sig == signal.SIGWINCH else interrupted)
        if interactive:
            resize()
            tty.setraw(0)
        while True:
            found = watcher.check()
            if found and not quota and not cancelled:
                quota = found
                send(signal.SIGTERM)
                stop_at = time.monotonic() + 3
            if stop_at and time.monotonic() >= stop_at:
                send(signal.SIGKILL)
            if proc:
                status = proc.poll()
                if status is not None:
                    break
            else:
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
                    break
            if interactive:
                ready, _, _ = select.select([0, master], [], [], 0.1)
                for fd in ready:
                    try:
                        chunk = os.read(fd, 65536)
                        if chunk:
                            os.write(master if fd == 0 else 1, chunk)
                    except OSError:
                        pass  # PTY returns EIO when its last slave closes.
            else:
                time.sleep(0.1)
        quota = quota or (None if cancelled else watcher.check(drain=True))
        send(signal.SIGTERM)
        if master is not None:
            # Drain the final screen/output before restoring the terminal.
            remaining = 1_048_576
            while remaining > 0 and select.select([master], [], [], 0)[0]:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    os.write(1, chunk)
                    remaining -= len(chunk)
                except OSError:
                    break
        return (128 + cancelled if cancelled else status if status >= 0 else 128 - status), quota
    finally:
        if old_terminal is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, old_terminal)
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
        send(signal.SIGTERM)
        if proc:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                send(signal.SIGKILL)
                proc.wait()
        else:
            deadline = time.monotonic() + 3
            while True:
                try:
                    waited, _ = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if waited:
                    break
                if time.monotonic() >= deadline:
                    send(signal.SIGKILL)
                    with contextlib.suppress(ChildProcessError):
                        os.waitpid(pid, 0)
                    break
                time.sleep(0.05)
        if master is not None:
            os.close(master)


HELP = """agylb — AGY ze wspólną pulą kont AgentLB

  agylb                    nowa rozmowa
  agylb --continue         ostatnia rozmowa w tym katalogu
  agylb models             dostępne modele
  agylb doctor             sprawdzenie programu i dostępu do puli
  agylb --version          wersja nakładki

Pozostałe argumenty są przekazywane do agy. Rozmowy są zapisywane na stałe
w ~/.local/share/agylb/workspaces/. Profil ma osobny HOME; zwykłe agy ma
osobne ustawienia i historię. Po zmianie konta wznowienie wymaga zatrzymania
i decyzji użytkownika. Ostatnie polecenie nie jest automatycznie ponawiane.
"""


def seed_profile(profile_home: Path, account: dict) -> None:
    token_path = profile_home / TOKEN_REL
    if not token_path.exists():
        # Each account has its own permanent home; never overwrite tokens
        # refreshed by AGY, and never associate another account with this home.
        private_dir(token_path.parent.parent)
        save_json(token_path, account["token"])


def main(args: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if args is None else args)
    if args in (["--help"], ["-h"]):
        print(HELP)
        return 0
    if args == ["--version"]:
        print(f"agylb {VERSION}")
        return 0
    if any(arg == "--log-file" or arg.startswith("--log-file=") for arg in args):
        raise LauncherError("agylb zarządza logiem; usuń --log-file.")
    real_home = Path.home()
    command = shutil.which(os.environ.get("AGYLB_COMMAND", "agy"))
    if not command:
        raise LauncherError("Nie znaleziono programu agy.")
    url, key = configuration(real_home)
    root = Path(os.environ.get("AGYLB_HOME", real_home / ".local/share/agylb")).expanduser().resolve()
    private_dir(root)
    workspace_id = hashlib.sha256(str(Path.cwd().resolve()).encode()).hexdigest()[:24]
    profile = root / "workspaces" / workspace_id
    private_dir(profile)
    lock_fd = os.open(profile / "run.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LauncherError("agylb już działa w tym katalogu. Zakończ poprzednią sesję.") from None
        state_path = profile / "state.json"
        state = load_json(state_path)
        resume = any(arg in ("-c", "--continue", "--conversation") or arg.startswith("--conversation=") for arg in args)
        current = state.get("conversationAccountId") if resume else state.get("accountId")
        endpoint = "/agy/credential" + ("?current=" + urllib.parse.quote(current, safe="") if isinstance(current, str) else "")
        account = pool_request(url, key, endpoint)
        if args == ["doctor"]:
            print(f"AGY: {command}\nPula AgentLB: dostępna\nProfil rozmów: {profile}")
            return 0
        if resume and (state.get("rotationRequired") or (current and current != account["account"]["id"])):
            raise LauncherError("Konto się zmieniło. Rozmowa pozostaje zapisana. Uruchom agylb bez --continue, aby zacząć nową.")
        account_id = account["account"]["id"]
        account_hash = hashlib.sha256(account_id.encode()).hexdigest()[:24]
        profile_home = profile / "accounts" / account_hash / "home"
        private_dir(profile_home)
        seed_profile(profile_home, account)
        conversational = not args or args[0].startswith("-")
        state["accountId"] = account_id
        state["workspace"] = str(Path.cwd())
        if conversational:
            state["conversationAccountId"] = account_id
            state.pop("rotationRequired", None)
        save_json(state_path, state)
        logs = profile / "logs"
        private_dir(logs)
        log = logs / f"run-{time.time_ns()}.log"
        fd = os.open(log, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        for stale in sorted(logs.glob("run-*.log"), reverse=True)[50:]:
            stale.unlink(missing_ok=True)
        print("agylb: konto z puli AgentLB; rozmowy są zapisywane.", file=sys.stderr)
        status, message = run_agy(command, args, profile_home, log, lock.fileno())
        if not message:
            return status
        state["rotationRequired"] = True
        save_json(state_path, state)
        print(f"\nagylb: limit konta wyczerpany. Rozmowa pozostaje w {profile_home}.", file=sys.stderr)
        pool_request(url, key, "/agy/quota", {"accountId": account["account"]["id"], "resetSeconds": reset_seconds(message), "message": "AGY quota exhausted"})
        if sys.stdin.isatty() and sys.stdout.isatty():
            answer = input("Uruchomić nową rozmowę na kolejnym koncie? [t/N] ").strip().lower()
            if answer in ("t", "tak"):
                # Drop prompt/resume arguments: never replay a turn or tool action.
                return 76
        return 75


if __name__ == "__main__":
    try:
        result = main()
        if result == 76:
            os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve())])
        sys.exit(result)
    except (LauncherError, OSError, ValueError) as exc:
        # Do not print raw network/config errors: they may contain credentials.
        print(f"agylb: {exc if isinstance(exc, LauncherError) else 'Błąd lokalnego profilu; sprawdź uprawnienia i konfigurację.'}", file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        sys.exit(130)
