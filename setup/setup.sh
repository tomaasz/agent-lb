#!/usr/bin/env bash
# agent-lb client setup script (Debian/Ubuntu/WSL/macOS).
#
# Jeśli w systemie jest Node.js, deleguje zadanie do uniwersalnego setup.js,
# który kompleksowo konfiguruje CLI, VS Code oraz zapobiega konfliktom OAuth.
#
# Użycie:
#   ./setup.sh
#   ./setup.sh --url https://your-server.com
# agent-lb client setup script (Debian/Ubuntu/WSL/macOS).
#
# Idempotentny skrypt konfiguracji środowiska pod proxy Agent-LB.

set -eu

# Jeśli dostępny jest Node.js, przekaż wykonanie do pełnego instalatora setup.js
if [ -z "${SETUP_FORCE_BASH:-}" ] && [ -n "${BASH_SOURCE[0]:-}" ]; then
	if [ -f "${BASH_SOURCE[0]:-}" ]; then
		SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
		if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/setup.js" ]; then
			exec node "$SCRIPT_DIR/setup.js" "$@"
		fi
	fi
fi

# Fallback w czystym bashu, gdy brak node
URL="${AGENT_LB_URL:-${AGENTLB_URL:-${CLAUDE_LB_URL:-http://localhost:3456}}}"
ENV_FILE="${AGENT_LB_ENV_FILE:-${CLAUDE_LB_ENV_FILE:-$HOME/.config/agent-lb.env}}"
BIN_DIR="${HOME}/bin"
RUN_TEST=0
SETUP_CODEX=0
UNINSTALL=0
WITH_AGY=0
WITH_AGYLB=0
NO_INSTALL=0
INSTALL_NODE=0
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${CLAUDE_LB_API_KEY:-${CODEX_LB_API_KEY:-${ANTHROPIC_API_KEY:-}}}}}"
LANG_VAL="${AGENT_LB_LANG:-}"

while [ $# -gt 0 ]; do
	case "$1" in
		--test) RUN_TEST=1 ;;
		--codex) SETUP_CODEX=1 ;;
		--uninstall) UNINSTALL=1 ;;
		--with-agy|--agy) WITH_AGY=1 ;;
		--with-agylb) WITH_AGYLB=1 ;;
		--no-install|--skip-install) NO_INSTALL=1 ;;
		--install-node) INSTALL_NODE=1 ;;
		--url) URL="${2%/}"; shift ;;
		--key) KEY="$2"; shift ;;
		--lang) LANG_VAL="$2"; shift ;;
		-h|--help)
			echo "Usage / Użycie: ./setup.sh [--url URL] [--key KEY] [--lang pl|en] [--codex] [--with-agy] [--with-agylb] [--test] [--no-install] [--install-node] [--uninstall]"
			echo "  Klucz najlepiej podać w zmiennej AGENT_LB_API_KEY (argument --key widać w 'ps' i w historii powłoki)."
			echo "  --install-node  zainstaluj Node.js/npm przez apt (sudo), jeśli ich brak"
			exit 0
			;;
		*) echo "Unknown argument / Nieznany argument: $1" >&2; exit 2 ;;
	esac
	shift
done

if [ -z "$LANG_VAL" ]; then
	case "${LC_ALL:-}${LANG:-}" in
		pl*) LANG_VAL="pl" ;;
		*) LANG_VAL="en" ;;
	esac
fi

say() { printf '%s\n' "$*"; }
die() {
	if [ "$LANG_VAL" = "pl" ]; then
		printf 'BLAD: %s\n' "$*" >&2
	else
		printf 'ERROR: %s\n' "$*" >&2
	fi
	exit 1
}
# Jedna kopia na plik, robiona przy pierwszym dotknięciu — zawiera oryginał sprzed AgentLB.
# Wcześniej każde uruchomienie dokładało kopię z kluczem (<plik>.bak-<czas>).
backup_existing() {
	local file="$1"
	[ -f "$file" ] || return 0
	local backup="${file}.bak-agent-lb"
	[ -e "$backup" ] && return 0
	if ! cp -p "$file" "$backup" 2>/dev/null || ! chmod 600 "$backup" 2>/dev/null; then
		say "Ostrzeżenie: nie udało się utworzyć kopii $file; pozostawiam oryginał i kontynuuję."
	fi
}

check_and_ensure_nodejs() {
	if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
		say "[OK] Node.js $(node --version 2>/dev/null || true) i npm $(npm --version 2>/dev/null || true) są dostępne."
		return 0
	fi

	say "[Wykryto brak] Node.js lub npm nie są zainstalowane w systemie."
	if [ "$INSTALL_NODE" -ne 1 ] || [ "$NO_INSTALL" -eq 1 ]; then
		say "  -> Nie instaluję pakietów systemowych bez zgody (uruchom ponownie z --install-node albo zainstaluj sam)."
		say "      sudo apt-get install -y nodejs npm"
		return 0
	fi

	if command -v apt-get >/dev/null 2>&1; then
		say "  -> Wykryto system oparty na Debian/Ubuntu/WSL. Próbuję zainstalować nodejs i npm..."
		if [ "$(id -u)" -eq 0 ]; then
			apt-get update -qq && apt-get install -y -qq nodejs npm || true
		elif command -v sudo >/dev/null 2>&1; then
			sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm || true
		fi
		if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
			say "[OK] Pomyślnie zainstalowano Node.js i npm."
			return 0
		fi
	fi

	say "  [Instrukcja] Aby zainstalować Node.js (zalecana wersja 20+ lub 22+):"
	say "      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
	say "      sudo apt-get install -y nodejs"
}

ensure_cli_package() {
	local cmd_name="$1"
	local pkg_name="$2"
	local title="$3"

	if command -v "$cmd_name" >/dev/null 2>&1; then
		local ver
		ver="$("$cmd_name" --version 2>/dev/null || echo 'OK')"
		say "[OK] $title ($cmd_name) jest zainstalowany: $ver"
		return 0
	fi

	say "[Wykryto brak] $title ($cmd_name) nie jest zainstalowany."
	if [ "$NO_INSTALL" -eq 1 ]; then
		say "  -> Pominięto automatyczną instalację (--no-install). Zainstaluj ręcznie: npm install -g $pkg_name"
		return 0
	fi

	if ! command -v npm >/dev/null 2>&1; then
		say "  [Uwaga] Brak npm w PATH. Nie można automatycznie zainstalować $pkg_name."
		return 0
	fi

	say "  -> Instaluję $title ($pkg_name)..."
	if npm install -g "$pkg_name" 2>/dev/null; then
		say "[OK] Pomyślnie zainstalowano $title ($cmd_name)."
	else
		# Bez cichego sudo: instalacja systemowa to decyzja użytkownika.
		say "  [Uwaga] Brak uprawnień do zapisu w globalnym katalogu npm. Zainstaluj ręcznie: sudo npm install -g $pkg_name"
	fi
}

if [ "$UNINSTALL" -eq 1 ]; then
	for f in "$HOME/.config/agent-lb.env" "$HOME/.config/claude-lb.env"; do
		rm -f "$f" 2>/dev/null || say "Ostrzeżenie: nie udało się usunąć $f"
	done
	for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
		[ -f "$rc" ] || continue
		tmp="${rc}.tmp.$$"
		if sed -E '/# (agent-lb|claude-lb)/d' "$rc" > "$tmp" && mv "$tmp" "$rc"; then :; else
			rm -f "$tmp"; say "Ostrzeżenie: nie udało się zaktualizować $rc"
		fi
	done
	if command -v python3 >/dev/null 2>&1 && [ -f "$HOME/.claude/settings.json" ]; then
		SETUP_HOME="$HOME" python3 - <<'PY'
import json, os
p = os.path.join(os.environ['SETUP_HOME'], '.claude', 'settings.json')
try:
    with open(p, encoding='utf-8') as f: data = json.load(f)
except Exception:
    data = None
if isinstance(data, dict):
    env = data.get('env')
    if isinstance(env, dict):
        env.pop('ANTHROPIC_BASE_URL', None)
        env.pop('ANTHROPIC_API_KEY', None)
        # usuń tylko nagłówek x-api-key, pozostałe nagłówki użytkownika zostają
        existing = env.pop('ANTHROPIC_CUSTOM_HEADERS', None)
        if existing:
            lines = [l.strip() for l in existing.splitlines() if l.strip()]
            lines = [l for l in lines if not l.lower().startswith('x-api-key:')]
            if lines:
                env['ANTHROPIC_CUSTOM_HEADERS'] = '\n'.join(lines)
            else:
                env.pop('ANTHROPIC_CUSTOM_HEADERS', None)
        if not env: data.pop('env', None)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
PY
	fi
	if command -v python3 >/dev/null 2>&1; then
		SETUP_HOME="$HOME" python3 - <<'PY' || true
import json, os, uuid
home = os.environ['SETUP_HOME']

def strip_json_comments(s):
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ''
        if in_str:
            out.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c); i += 1; continue
        if c == '/' and nxt == '/':
            i += 2
            while i < n and s[i] not in '\r\n': i += 1
            continue
        if c == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                if s[i] in '\r\n': out.append(s[i])
                i += 1
            i += 2; continue
        out.append(c); i += 1
    s2 = ''.join(out)
    cleaned = []
    in_str = esc = False
    i, n = 0, len(s2)
    while i < n:
        c = s2[i]
        if in_str:
            cleaned.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; cleaned.append(c); i += 1; continue
        if c == ',':
            j = i + 1
            while j < n and s2[j].isspace(): j += 1
            if j < n and s2[j] in '}]':
                i += 1; continue
        cleaned.append(c); i += 1
    return ''.join(cleaned)

def write_atomic(p, text, mode=0o600):
    tmp = os.path.join(os.path.dirname(p), f'.{os.path.basename(p)}.tmp-{uuid.uuid4().hex}')
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            os.fchmod(f.fileno(), mode)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

apps = ('Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Antigravity')
bases = [f'.config/{a}/User' for a in apps] + [f'Library/Application Support/{a}/User' for a in apps]
for srv in ('.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server', '.antigravity-server'):
    bases.extend((f'{srv}/data/Machine', f'{srv}/data/User'))
for base in bases:
    p = os.path.join(home, base, 'settings.json')
    try:
        with open(p, encoding='utf-8') as f: data = json.loads(strip_json_comments(f.read()))
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    env_vars = [e for e in data.get('claudeCode.environmentVariables', [])
                if isinstance(e, dict) and e.get('name') not in ('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')]
    for e in env_vars:
        if e.get('name') == 'ANTHROPIC_CUSTOM_HEADERS':
            e['value'] = '\n'.join(l.strip() for l in str(e.get('value', '')).splitlines()
                                   if l.strip() and not l.strip().lower().startswith('x-api-key:'))
    env_vars = [e for e in env_vars if e.get('name') != 'ANTHROPIC_CUSTOM_HEADERS' or e.get('value')]
    if env_vars: data['claudeCode.environmentVariables'] = env_vars
    else: data.pop('claudeCode.environmentVariables', None)
    data.pop('claudeCode.disableLoginPrompt', None)
    data.pop('claudeCode.hideOnboarding', None)
    write_atomic(p, json.dumps(data, indent=2) + '\n')

# Clean OpenCode, OpenClaw, and Hermes AgentLB keys on uninstall
oc_cfg = os.path.join(home, '.config', 'opencode', 'opencode.json')
if os.path.isfile(oc_cfg):
    try:
        with open(oc_cfg, encoding='utf-8') as f: data = json.loads(strip_json_comments(f.read()))
        if isinstance(data, dict):
            changed = False
            for section in ('provider', 'providers'):
                if isinstance(data.get(section), dict) and 'agentlb' in data[section]:
                    data[section].pop('agentlb', None)
                    changed = True
            if changed:
                write_atomic(oc_cfg, json.dumps(data, indent=2) + '\n')
    except Exception:
        pass

oc_auth = os.path.join(home, '.local', 'share', 'opencode', 'auth.json')
if os.path.isfile(oc_auth):
    try:
        with open(oc_auth, encoding='utf-8') as f: data = json.loads(strip_json_comments(f.read()))
        if isinstance(data, dict) and 'agentlb' in data:
            data.pop('agentlb', None)
            write_atomic(oc_auth, json.dumps(data, indent=2) + '\n')
    except Exception:
        pass

claw_cfg = os.path.join(home, '.openclaw', 'openclaw.json')
if os.path.isfile(claw_cfg):
    try:
        with open(claw_cfg, encoding='utf-8') as f: data = json.loads(strip_json_comments(f.read()))
        if isinstance(data, dict) and isinstance(data.get('models'), dict) and isinstance(data['models'].get('providers'), dict):
            if 'agentlb' in data['models']['providers']:
                data['models']['providers'].pop('agentlb', None)
                write_atomic(claw_cfg, json.dumps(data, indent=2) + '\n')
    except Exception:
        pass

hermes_env = os.path.join(home, '.hermes', '.env')
if os.path.isfile(hermes_env):
    try:
        with open(hermes_env, encoding='utf-8') as f: raw = f.read()
        lines = [l for l in raw.splitlines() if not l.lstrip().startswith(('AGENT_LB_API_KEY=', 'export AGENT_LB_API_KEY=', 'AGENT_LB_URL=', 'export AGENT_LB_URL='))]
        new_text = ('\n'.join(lines) + '\n') if lines else ''
        if new_text != raw:
            write_atomic(hermes_env, new_text)
    except Exception:
        pass
PY
	fi
	if [ -f "$HOME/.aider.conf.yml" ]; then
		awk '
			/^# >>> agentlb/ { skip=1; next }
			/^# <<< agentlb/ { skip=0; next }
			!skip { print }
		' "$HOME/.aider.conf.yml" > "$HOME/.aider.conf.yml.tmp.$$" \
			&& chmod 600 "$HOME/.aider.conf.yml.tmp.$$" 2>/dev/null \
			&& mv "$HOME/.aider.conf.yml.tmp.$$" "$HOME/.aider.conf.yml" \
			|| rm -f "$HOME/.aider.conf.yml.tmp.$$"
	fi
	if [ -f "$HOME/.codex/codexlb.config.toml" ] && head -1 "$HOME/.codex/codexlb.config.toml" | grep -qxF "# zarzadzane przez setup AgentLB (profil codexlb)"; then
		rm -f "$HOME/.codex/codexlb.config.toml"
	fi
	if [ -f "$HOME/.codex/config.toml" ]; then
		backup_existing "$HOME/.codex/config.toml"
		awk '
			/^# >>> codexlb/ { skip=1; next }
			/^# <<< codexlb/ { skip=0; next }
			!skip { print }
		' "$HOME/.codex/config.toml" > "$HOME/.codex/config.toml.tmp.$$" \
			&& mv "$HOME/.codex/config.toml.tmp.$$" "$HOME/.codex/config.toml" \
			|| rm -f "$HOME/.codex/config.toml.tmp.$$"
	fi
	if command -v python3 >/dev/null 2>&1 && [ -f "$HOME/.codex/config.json" ]; then
		backup_existing "$HOME/.codex/config.json"
		SETUP_CODEX_CONF="$HOME/.codex/config.json" python3 - <<'PY'
import json, os
p = os.environ['SETUP_CODEX_CONF']
try:
    with open(p, encoding='utf-8') as f: data = json.load(f)
except Exception:
    data = None
if isinstance(data, dict):
    data.pop('base_url', None)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2); f.write('\n')
PY
	fi
	say "Usunięto ustawienia Agent-LB. Plik .credentials.json pozostawiono bez zmian."
	LEGACY="$(find "$HOME/.claude" "$HOME/.config" "$HOME/.codex" "$HOME/.vscode-server/data" "$HOME/.vscode-server-insiders/data" "$HOME" \
		-maxdepth 3 -type f -regextype posix-extended \
		-regex '.*/(settings\.json|\.credentials\.json|agent-lb\.env|config\.json|config\.toml|\.bashrc|\.zshrc)\.bak-[0-9]+' 2>/dev/null | sort -u || true)"
	if [ -n "$LEGACY" ]; then
		say ""
		say "Stare kopie zapasowe z poprzednich wersji instalatora mogą zawierać klucz AgentLB."
		say "Nie usuwam ich automatycznie — przejrzyj i usuń ręcznie:"
		printf '%s\n' "$LEGACY" | sed 's/^/  /'
	fi
	exit 0
fi

command -v curl >/dev/null || die "brak curl"

if [ -n "$KEY" ]; then
	case "$KEY" in
		\<*\>|"<KLUCZ_STACJI>"|"<KEY>"|"<TWÓJ_KLUCZ>") KEY="" ;;
	esac
fi

if [ -z "$KEY" ] && [ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]; then
	KEY="$(printf '%s\n' "$ANTHROPIC_CUSTOM_HEADERS" | sed -n 's/^[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy][[:space:]]*:[[:space:]]*//p' | head -1)"
fi
if [ -z "$KEY" ] && [ -r "$ENV_FILE" ]; then
	KEY="$(sed -n -e 's/^export CODEX_LB_API_KEY=//p' -e 's/^export ANTHROPIC_API_KEY=//p' "$ENV_FILE" | tr -d '"'\''' | head -1)"
	case "$KEY" in
		\<*\>|"<KLUCZ_STACJI>"|"<KEY>"|"<TWÓJ_KLUCZ>") KEY="" ;;
		*) [ -n "$KEY" ] && say "Używam klucza zapisanego w $ENV_FILE." ;;
	esac
fi
if [ -z "$KEY" ]; then
	printf 'Klucz API z Agent LB (%s), wklej i Enter: ' "$URL"
	if [ -e /dev/tty ]; then
		read -rs KEY </dev/tty
	else
		read -rs KEY
	fi
	printf '\n'
fi
KEY="$(printf '%s' "${KEY:-}" | tr -d '\r\n\t ')"
[ -n "$KEY" ] || die "nie podano klucza"

say "Sprawdzam połączenie i autoryzację klucza w $URL..."
code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "x-api-key: $KEY" "$URL/v1/models" || true)"
if [ "$code" = "404" ]; then
	code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "x-api-key: $KEY" "$URL/backend-api/codex/models" || true)"
fi
case "$code" in
	200) say "OK — klucz poprawny, proxy autoryzowało dostęp." ;;
	401|403) die "serwer odrzucił klucz ($code). Podaj prawidłowy klucz stacji roboczej (znajdziesz go w panelu $URL)." ;;
	000) die "brak połączenia z $URL. Sprawdź sieć/domenę." ;;
	*) say "Otrzymano kod $code — kontynuuję konfigurację." ;;
esac

# Weryfikacja środowiska i wdrożenie CLI
say ""
say "--- Weryfikacja środowiska i instalacja narzędzi CLI ---"
check_and_ensure_nodejs
ensure_cli_package "claude" "@anthropic-ai/claude-code" "Claude Code CLI"
ensure_cli_package "codex" "@openai/codex" "OpenAI Codex CLI"
say "--------------------------------------------------------"
say ""

# Zabezpieczenie przed Auth conflict
CREDS="$HOME/.claude/.credentials.json"
OAUTH_SESSION=0
if [ -f "$CREDS" ]; then
	if command -v python3 >/dev/null 2>&1; then
		SETUP_CREDS="$CREDS" python3 - <<'PY' >/dev/null 2>&1 && OAUTH_SESSION=1 || true
import json, os
with open(os.environ['SETUP_CREDS'], encoding='utf-8') as f:
    data = json.load(f)
oauth = data.get('claudeAiOauth') or data.get('oauth') or data
raise SystemExit(0 if isinstance(oauth, dict) and isinstance(oauth.get('accessToken'), str) and oauth['accessToken'] else 1)
PY
	elif grep -qE '\"accessToken\"[[:space:]]*:' "$CREDS" 2>/dev/null; then
		OAUTH_SESSION=1
	fi
fi
# .credentials.json jest tylko czytany, nigdy zmieniany — nie robimy jego kopii (każda to kolejny plik z tokenami).
if [ "$OAUTH_SESSION" -eq 1 ]; then
	say "Zachowuję tryb OAuth Claude Code; klucz proxy przekazuję przez ANTHROPIC_CUSTOM_HEADERS."
fi

# Zapis konfiguracji środowiskowej
mkdir -p "$(dirname "$ENV_FILE")" "$BIN_DIR"
umask 077
# $ENV_FILE należy w całości do instalatora i zawiera tylko klucz — bez kopii zapasowej.
shell_quote() {
	local value="$1"
	value="${value//\'/\'\\\'\'}"
	printf "'%s'" "$value"
}
# Claude Code bierze proxy z ~/.claude/settings.json, Codex z profilu codexlb — powłoka potrzebuje
# tylko klucza pod nazwami AgentLB. Ogólne ANTHROPIC_* / OPENAI_* przekierowywały na proxy
# każdy skrypt i narzędzie korzystające z tych SDK.
{
	printf '%s\n' '# Agent LB environment configuration'
	if [ "$OAUTH_SESSION" -eq 1 ]; then
		printf '%s\n' 'unset ANTHROPIC_API_KEY  # preserve Claude Code OAuth session'
	fi
	printf 'export CODEX_LB_API_KEY=%s\n' "$(shell_quote "$KEY")"
	printf 'export AGENT_LB_API_KEY=%s\n' "$(shell_quote "$KEY")"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Zapisano $ENV_FILE."

# Konfiguracja ~/.claude/settings.json (CLI Claude Code)
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
if [ ! -f "$CLAUDE_SETTINGS" ]; then
	echo '{"env":{}}' > "$CLAUDE_SETTINGS"
else
	backup_existing "$CLAUDE_SETTINGS"
fi
# Dopisanie zmiennych jeśli python jest dostępny
if command -v python3 >/dev/null 2>&1; then
	SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_OAUTH="$OAUTH_SESSION" SETUP_SETTINGS="$CLAUDE_SETTINGS" python3 - <<'PY' 2>/dev/null && say "Zaktualizowano $CLAUDE_SETTINGS."
import json, os
p = os.environ['SETUP_SETTINGS']
try:
    with open(p, encoding='utf-8') as f: data = json.load(f)
except Exception: data = {}
data.setdefault('env', {})
data['env']['ANTHROPIC_BASE_URL'] = os.environ['SETUP_URL']

def set_custom_header(existing, name, value):
    lines = [l.strip() for l in (existing or '').splitlines() if l.strip()]
    prefix = name.lower() + ':'
    lines = [l for l in lines if not l.lower().startswith(prefix)]
    lines.append(f"{name}: {value}")
    return '\n'.join(lines)

def remove_custom_header(existing, name):
    lines = [l.strip() for l in (existing or '').splitlines() if l.strip()]
    prefix = name.lower() + ':'
    lines = [l for l in lines if not l.lower().startswith(prefix)]
    return '\n'.join(lines) if lines else None

if os.environ.get('SETUP_OAUTH') == '1':
    data['env'].pop('ANTHROPIC_API_KEY', None)
    data['env']['ANTHROPIC_CUSTOM_HEADERS'] = set_custom_header(data['env'].get('ANTHROPIC_CUSTOM_HEADERS'), 'x-api-key', os.environ['SETUP_KEY'])
else:
    data['env']['ANTHROPIC_API_KEY'] = os.environ['SETUP_KEY']
    rem = remove_custom_header(data['env'].get('ANTHROPIC_CUSTOM_HEADERS'), 'x-api-key')
    if rem:
        data['env']['ANTHROPIC_CUSTOM_HEADERS'] = rem
    else:
        data['env'].pop('ANTHROPIC_CUSTOM_HEADERS', None)

with open(p, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PY
fi

# Konfiguracja oficjalnego rozszerzenia Claude Code w VS Code i edytorach VS Code-like (desktop + Remote SSH)
CONFIGURED_IDES=""
if command -v python3 >/dev/null 2>&1; then
	CONFIGURED_IDES="$(SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_OAUTH="$OAUTH_SESSION" python3 - <<'PY' 2>/dev/null || true
import json, os, shutil, sys, uuid

url = os.environ['SETUP_URL']
key = os.environ['SETUP_KEY']
oauth = os.environ.get('SETUP_OAUTH') == '1'
home = os.path.expanduser('~')

def strip_json_comments(s):
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ''
        if in_str:
            out.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True; out.append(c); i += 1; continue
        if c == '/' and nxt == '/':
            i += 2
            while i < n and s[i] not in '\r\n': i += 1
            continue
        if c == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                if s[i] in '\r\n': out.append(s[i])
                i += 1
            i += 2; continue
        out.append(c); i += 1
    s2 = ''.join(out)
    cleaned = []
    in_str = esc = False
    i, n = 0, len(s2)
    while i < n:
        c = s2[i]
        if in_str:
            cleaned.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; cleaned.append(c); i += 1; continue
        if c == ',':
            j = i + 1
            while j < n and s2[j].isspace(): j += 1
            if j < n and s2[j] in '}]':
                i += 1; continue
        cleaned.append(c); i += 1
    return ''.join(cleaned)

def write_atomic(p, text, mode=0o600):
    tmp = os.path.join(os.path.dirname(p), f'.{os.path.basename(p)}.tmp-{uuid.uuid4().hex}')
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            os.fchmod(f.fileno(), mode)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

apps = [
    ('Code', 'VS Code'),
    ('Code - Insiders', 'VS Code Insiders'),
    ('Cursor', 'Cursor'),
    ('Windsurf', 'Windsurf'),
    ('VSCodium', 'VSCodium'),
    ('Antigravity', 'Antigravity IDE'),
]
targets = []
for app_dir, label in apps:
    targets.append((os.path.join(home, '.config', app_dir, 'User', 'settings.json'), label, False))
    targets.append((os.path.join(home, 'Library', 'Application Support', app_dir, 'User', 'settings.json'), label, False))
for srv, label in [
    ('.vscode-server', 'VS Code Server'),
    ('.vscode-server-insiders', 'VS Code Insiders Server'),
    ('.cursor-server', 'Cursor Server'),
    ('.windsurf-server', 'Windsurf Server'),
    ('.antigravity-server', 'Antigravity Server'),
]:
    targets.append((os.path.join(home, srv, 'data', 'Machine', 'settings.json'), label, True))
    targets.append((os.path.join(home, srv, 'data', 'User', 'settings.json'), label, True))

configured = []

def update_file(p, label, is_server):
    d = os.path.dirname(p)
    if not os.path.isdir(d):
        if not is_server:
            return
        base = os.path.dirname(d)
        if not os.path.isdir(base):
            return
        os.makedirs(d, exist_ok=True)
    if os.path.islink(p):
        return
    data = {}
    if os.path.isfile(p):
        try:
            with open(p, encoding='utf-8') as f: raw = f.read()
            if raw.strip():
                parsed = json.loads(strip_json_comments(raw))
                if not isinstance(parsed, dict):
                    return
                data = parsed
        except Exception:
            print(f'warning: skipping malformed {p}', file=sys.stderr)
            return
        bak = p + '.bak-agent-lb'
        if not os.path.exists(bak):
            try:
                shutil.copy2(p, bak)
                os.chmod(bak, 0o600)
            except Exception:
                pass
    data['claudeCode.disableLoginPrompt'] = True
    data['claudeCode.hideOnboarding'] = True
    env_vars = [e for e in data.get('claudeCode.environmentVariables', []) if isinstance(e, dict) and e.get('name') not in ('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')]
    env_vars.append({'name': 'ANTHROPIC_BASE_URL', 'value': url})
    if oauth:
        existing_hdr = next((e.get('value', '') for e in env_vars if e.get('name') == 'ANTHROPIC_CUSTOM_HEADERS'), '')
        lines = [l.strip() for l in existing_hdr.splitlines() if l.strip() and not l.lower().startswith('x-api-key:')]
        lines.append(f'x-api-key: {key}')
        env_vars = [e for e in env_vars if e.get('name') != 'ANTHROPIC_CUSTOM_HEADERS']
        env_vars.append({'name': 'ANTHROPIC_CUSTOM_HEADERS', 'value': '\n'.join(lines)})
    else:
        env_vars.append({'name': 'ANTHROPIC_API_KEY', 'value': key})
        env_vars.append({'name': 'ANTHROPIC_AUTH_TOKEN', 'value': key})
        existing_hdr = next((e.get('value', '') for e in env_vars if e.get('name') == 'ANTHROPIC_CUSTOM_HEADERS'), '')
        lines = [l.strip() for l in existing_hdr.splitlines() if l.strip() and not l.lower().startswith('x-api-key:')]
        env_vars = [e for e in env_vars if e.get('name') != 'ANTHROPIC_CUSTOM_HEADERS']
        if lines:
            env_vars.append({'name': 'ANTHROPIC_CUSTOM_HEADERS', 'value': '\n'.join(lines)})
    data['claudeCode.environmentVariables'] = env_vars
    write_atomic(p, json.dumps(data, indent=2) + '\n')
    if label not in configured:
        configured.append(label)

for t, label, is_server in targets:
    update_file(t, label, is_server)

if configured:
    print(', '.join(configured))
PY
)"
	[ -n "$CONFIGURED_IDES" ] && say "[OK] Skonfigurowano rozszerzenie Claude Code w IDE: $CONFIGURED_IDES."
fi

# Konfiguracja ~/.codex (OpenAI Codex CLI: config.toml oraz config.json)
mkdir -p "$HOME/.codex"
CODEX_TOML="$HOME/.codex/config.toml"
CODEX_PROFILE="$HOME/.codex/codexlb.config.toml"
CODEX_PROFILE_HEADER="# zarzadzane przez setup AgentLB (profil codexlb)"
# Dostawca codex-lb jako domyślny: zwykłe `codex` idzie przez AgentLB bez globalnych OPENAI_*.
# Codex >= 0.160 odrzuca `profile = …` i `[profiles.<nazwa>]` w config.toml przy --profile;
# profil to osobny plik <CODEX_HOME>/codexlb.config.toml.
backup_existing "$CODEX_TOML"
[ -f "$CODEX_TOML" ] || : > "$CODEX_TOML"
if command -v python3 >/dev/null 2>&1; then
	SETUP_CODEX_TOML="$CODEX_TOML" SETUP_URL="$URL" python3 - <<'PY' || say "Ostrzeżenie: nie udało się zaktualizować $CODEX_TOML"
import os, re
p, url = os.environ['SETUP_CODEX_TOML'], os.environ['SETUP_URL']
text = open(p, encoding='utf-8').read()
rest = re.sub(r'^# >>> codexlb.*?^# <<< codexlb[^\n]*\n?', '', text, flags=re.S | re.M)
rest = re.sub(r'\n{3,}', '\n\n', rest).lstrip('\n')
m = re.search(r'^\s*\[', rest, flags=re.M)
top = rest[:m.start()] if m else rest
own_default = re.search(r'^\s*(profile|model_provider)\s*=', top, flags=re.M)
head = ''
if own_default:
    print(f"[INFO] {p} ma już własny domyślny profil/dostawcę — nie zmieniam go. Przez AgentLB: codex --profile codexlb")
else:
    head = '# >>> codexlb-default >>> (zarzadzane przez setup)\nmodel_provider = "codex-lb"\n'
    if not re.search(r'^\s*model\s*=', top, flags=re.M):
        head += 'model = "gpt-5.6-sol"\n'
    head += '# <<< codexlb-default <<<\n\n'
new = head + (rest.rstrip() + '\n' if rest.strip() else '')
if not re.search(r'^\s*\[model_providers\.codex-lb\]', rest, flags=re.M):
    new += ('\n# >>> codexlb >>> (zarzadzane przez setup)\n[model_providers.codex-lb]\nname = "openai"\n'
            f'base_url = "{url}/backend-api/codex"\nwire_api = "responses"\nsupports_websockets = false\n'
            'requires_openai_auth = true\nenv_key = "CODEX_LB_API_KEY"\n# <<< codexlb <<<\n')
if new != text:
    with open(p, 'w', encoding='utf-8') as f: f.write(new)
    print(f"Zaktualizowano {p} (dostawca codex-lb).")
PY
	chmod 600 "$CODEX_TOML" 2>/dev/null || true
elif ! grep -qF "model_providers.codex-lb" "$CODEX_TOML" 2>/dev/null; then
	cat >> "$CODEX_TOML" <<-EOF

# >>> codexlb >>> (zarzadzane przez setup.sh)
[model_providers.codex-lb]
name = "openai"
base_url = "$URL/backend-api/codex"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = true
env_key = "CODEX_LB_API_KEY"
# <<< codexlb <<<
EOF
	say "Brak python3 — zwykłe 'codex' nie przejdzie przez AgentLB; używaj: codex --profile codexlb"
fi
if [ ! -f "$CODEX_PROFILE" ] || head -1 "$CODEX_PROFILE" | grep -qxF "$CODEX_PROFILE_HEADER"; then
	printf '%s\nmodel = "gpt-5.6-sol"\nmodel_provider = "codex-lb"\nmodel_reasoning_effort = "xhigh"\n' "$CODEX_PROFILE_HEADER" > "$CODEX_PROFILE"
	chmod 600 "$CODEX_PROFILE" 2>/dev/null || true
else
	say "[INFO] $CODEX_PROFILE należy do użytkownika — nie zmieniam go."
fi

CODEX_CONF="$HOME/.codex/config.json"
if command -v python3 >/dev/null 2>&1 && ! grep -qF "\"base_url\": \"$URL/backend-api/codex\"" "$CODEX_CONF" 2>/dev/null; then
	backup_existing "$CODEX_CONF"
	SETUP_URL="$URL" SETUP_CODEX_CONF="$CODEX_CONF" python3 - <<'PY' 2>/dev/null && say "Zaktualizowano $CODEX_CONF."
import json, os
p = os.environ['SETUP_CODEX_CONF']
try:
    with open(p, encoding='utf-8') as f: data = json.load(f)
except Exception: data = {}
data['base_url'] = os.environ['SETUP_URL'] + '/backend-api/codex'
with open(p, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PY
fi

# Integracja z powłoką
src_line=". \"$ENV_FILE\"  # agent-lb"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
	[ -f "$rc" ] || continue
	if [ -w "$rc" ]; then
		if ! grep -qF "# agent-lb" "$rc" 2>/dev/null; then
			printf '\n%s\n' "$src_line" >> "$rc" 2>/dev/null && say "Dopisano wczytywanie do $rc." || true
		fi
	else
		say "Pominięto $rc (brak uprawnień do zapisu)."
	fi
done

if [ "$RUN_TEST" -eq 1 ] && command -v claude >/dev/null 2>&1; then
	say "Test claude --version:"
	if [ "$OAUTH_SESSION" -eq 1 ]; then
		env -u ANTHROPIC_API_KEY ANTHROPIC_BASE_URL="$URL" ANTHROPIC_CUSTOM_HEADERS="x-api-key: $KEY" claude --version || true
	else
		env -u ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_BASE_URL="$URL" ANTHROPIC_API_KEY="$KEY" claude --version || true
	fi
fi

if [ "$WITH_AGYLB" -eq 1 ]; then
	AGYLB_SETUP=''
	if [ -f "${BASH_SOURCE[0]:-}" ]; then AGYLB_SETUP="$(dirname "${BASH_SOURCE[0]}")/agylb-setup.sh"; fi
	if [ -n "$AGYLB_SETUP" ] && [ -f "$AGYLB_SETUP" ]; then
		AGENT_LB_URL="$URL" AGENT_LB_API_KEY="$KEY" bash "$AGYLB_SETUP"
	else
		(set -o pipefail; curl -fsSL "$URL/agylb-setup.sh" | AGENT_LB_URL="$URL" AGENT_LB_API_KEY="$KEY" bash)
	fi
fi

# Opcjonalnie: prawdziwy AGY lokalnie przez agybridge (Hermes, OpenCode, OpenClaw, Claude Code MCP)
if [ "$WITH_AGY" -eq 1 ]; then
	say ""
	say "Instaluję agybridge (AGY)..."
	AGY_SETUP=""
	if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
		AGY_SETUP="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/agy-setup.sh"
	fi
	if [ -n "$AGY_SETUP" ] && [ -f "$AGY_SETUP" ]; then
		bash "$AGY_SETUP" --url "$URL" --key "$KEY" || say "[Ostrzeżenie] Instalacja agybridge nie powiodła się (reszta konfiguracji jest gotowa)."
	else
		curl -fsSL "$URL/agy-setup.sh" | bash -s -- --url "$URL" --key "$KEY" || say "[Ostrzeżenie] Instalacja agybridge nie powiodła się (reszta konfiguracji jest gotowa)."
	fi
fi

# Auto-wykrywanie i konfiguracja popularnych aplikacji (tylko gdy są obecne na hoście)
EXTRA_APPS=""

if command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]; then
	if command -v python3 >/dev/null 2>&1; then
		if SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_HOME="$HOME" python3 - <<'PY' 2>/dev/null; then
import json, os, re, shutil, urllib.request, uuid
home = os.environ['SETUP_HOME']
url = os.environ['SETUP_URL'].rstrip('/')
key = os.environ['SETUP_KEY']
cfg_dir = os.path.join(home, '.config', 'opencode')
auth_dir = os.path.join(home, '.local', 'share', 'opencode')
cfg_path = os.path.join(cfg_dir, 'opencode.json')
auth_path = os.path.join(auth_dir, 'auth.json')

def strip_json_comments(s):
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ''
        if in_str:
            out.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; out.append(c); i += 1; continue
        if c == '/' and nxt == '/':
            i += 2
            while i < n and s[i] not in '\r\n': i += 1
            continue
        if c == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                if s[i] in '\r\n': out.append(s[i])
                i += 1
            i += 2; continue
        out.append(c); i += 1
    s2 = ''.join(out)
    cleaned = []
    in_str = esc = False
    i, n = 0, len(s2)
    while i < n:
        c = s2[i]
        if in_str:
            cleaned.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; cleaned.append(c); i += 1; continue
        if c == ',':
            j = i + 1
            while j < n and s2[j].isspace(): j += 1
            if j < n and s2[j] in '}]':
                i += 1; continue
        cleaned.append(c); i += 1
    return ''.join(cleaned)

def write_atomic(p, text, mode=0o600):
    if os.path.islink(p):
        raise RuntimeError('Refusing to overwrite symlink')
    tmp = os.path.join(os.path.dirname(p), f'.{os.path.basename(p)}.tmp-{uuid.uuid4().hex}')
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            os.fchmod(f.fileno(), mode)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

cfg = {}
if os.path.isfile(cfg_path):
    with open(cfg_path, encoding='utf-8') as f:
        cfg = json.loads(strip_json_comments(f.read()))
    if not isinstance(cfg, dict):
        raise ValueError('opencode.json must be an object')
auth = {}
if os.path.isfile(auth_path):
    with open(auth_path, encoding='utf-8') as f:
        auth = json.loads(strip_json_comments(f.read()))
    if not isinstance(auth, dict):
        raise ValueError('auth.json must be an object')

models = {
    'claude-fable-5-1': {'name': 'Claude Fable 5.1'},
    'claude-fable-5': {'name': 'Claude Fable 5'},
    'claude-opus-5-5': {'name': 'Claude Opus 5.5'},
    'claude-opus-5': {'name': 'Claude Opus 5'},
    'claude-opus-4-8': {'name': 'Claude Opus 4.8'},
    'claude-opus-4-7': {'name': 'Claude Opus 4.7'},
    'claude-opus-4-6': {'name': 'Claude Opus 4.6'},
    'claude-sonnet-5-5': {'name': 'Claude Sonnet 5.5'},
    'claude-sonnet-5': {'name': 'Claude Sonnet 5'},
    'claude-sonnet-4-6': {'name': 'Claude Sonnet 4.6'},
    'claude-haiku-5-5': {'name': 'Claude Haiku 5.5'},
    'claude-haiku-4-5-20251001': {'name': 'Claude Haiku 4.5'},
    'codex': {'name': 'OpenAI Codex (GPT-5.6 Sol)'},
    'gpt-5.6-sol': {'name': 'GPT-5.6 Sol'},
    'gpt-6-astra': {'name': 'GPT-6 Astra'},
    'gpt-6-sol': {'name': 'GPT-6 Sol'},
    'gpt-6-luna': {'name': 'GPT-6 Luna'},
    'gpt-5.6-terra': {'name': 'GPT-5.6 Terra'},
    'gpt-5.6-luna': {'name': 'GPT-5.6 Luna'},
    'gpt-5.3-codex': {'name': 'GPT-5.3-Codex'},
    'gpt-5.2-codex': {'name': 'GPT-5.2-Codex'},
    'gpt-5.5': {'name': 'GPT-5.5'},
    'gpt-4.1': {'name': 'GPT-4.1'},
    'gpt-4o': {'name': 'GPT-4o'},
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
try:
    req = urllib.request.Request(url + '/v1/models', headers={'x-api-key': key, 'Authorization': 'Bearer ' + key})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as resp:
        data = json.loads(resp.read(1048576))
    for item in (data.get('data') if isinstance(data, dict) else []) or []:
        mid = item.get('id') if isinstance(item, dict) else None
        if isinstance(mid, str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,100}', mid) and mid not in models:
            models[mid] = {'name': item.get('name') or mid}
except Exception:
    pass

cfg.setdefault('provider', {})['agentlb'] = {
    'npm': '@ai-sdk/openai-compatible',
    'name': 'AgentLB (All Models)',
    'options': {'baseURL': url + '/v1', 'apiKey': key},
    'models': models,
}
cfg.setdefault('providers', {})['agentlb'] = {
    'npm': '@ai-sdk/openai-compatible',
    'name': 'AgentLB (All Models)',
    'package': '@opencode/ai/providers/openai-compatible',
    'settings': {'baseURL': url + '/v1'},
    'options': {'baseURL': url + '/v1', 'apiKey': key},
    'apiKey': key,
    'models': models,
}
auth['agentlb'] = {'type': 'api', 'key': key}

for p, obj in ((cfg_path, cfg), (auth_path, auth)):
    os.makedirs(os.path.dirname(p), exist_ok=True, mode=0o700)
    if os.path.isfile(p) and not os.path.exists(p + '.bak-agent-lb'):
        try:
            shutil.copy2(p, p + '.bak-agent-lb')
            os.chmod(p + '.bak-agent-lb', 0o600)
        except Exception:
            pass
    write_atomic(p, json.dumps(obj, indent=2) + '\n')
PY
			say "[OK] Skonfigurowano OpenCode ($HOME/.config/opencode/opencode.json)."
			EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }OpenCode"
		else
			say "[Ostrzeżenie] Nie udało się skonfigurować OpenCode."
		fi
	fi
fi

if command -v aider >/dev/null 2>&1 || [ -f "$HOME/.aider.conf.yml" ] || [ -d "$HOME/.aider" ]; then
	if command -v python3 >/dev/null 2>&1; then
		if SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_HOME="$HOME" python3 - <<'PY' 2>/dev/null; then
import json, os, re, shutil, uuid
p = os.path.join(os.environ['SETUP_HOME'], '.aider.conf.yml')
if os.path.islink(p):
    raise RuntimeError('Refusing to overwrite symlink')
url = os.environ['SETUP_URL'].rstrip('/')
key = os.environ['SETUP_KEY']
existing = open(p, encoding='utf-8').read() if os.path.isfile(p) else ''
rest = re.sub(r'^# >>> agentlb.*?^# <<< agentlb[^\n]*\n?', '', existing, flags=re.S | re.M).strip()
has_model = bool(re.search(r'^\s*model\s*:', rest, flags=re.M))
block = (
    '# >>> agentlb >>> (zarzadzane przez setup AgentLB)\n'
    f'openai-api-base: {json.dumps(url + "/v1")}\n'
    f'openai-api-key: {json.dumps(key)}\n'
    + ('' if has_model else 'model: "openai/gpt-5.6-sol"\n')
    + '# <<< agentlb <<<\n'
)
new = (rest + '\n\n' if rest else '') + block
if new != existing:
    if os.path.isfile(p) and not os.path.exists(p + '.bak-agent-lb'):
        try:
            shutil.copy2(p, p + '.bak-agent-lb')
            os.chmod(p + '.bak-agent-lb', 0o600)
        except Exception:
            pass
    tmp = os.path.join(os.path.dirname(p), f'.{os.path.basename(p)}.tmp-{uuid.uuid4().hex}')
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(new)
            os.fchmod(f.fileno(), 0o600)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
PY
			say "[OK] Skonfigurowano Aider ($HOME/.aider.conf.yml)."
			EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }Aider"
		fi
	fi
fi

if command -v openclaw >/dev/null 2>&1 || [ -d "$HOME/.openclaw" ]; then
	if command -v python3 >/dev/null 2>&1; then
		if SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_HOME="$HOME" python3 - <<'PY' 2>/dev/null; then
import json, os, shutil, uuid
p = os.path.join(os.environ['SETUP_HOME'], '.openclaw', 'openclaw.json')
if os.path.islink(p):
    raise RuntimeError('Refusing to overwrite symlink')

def strip_json_comments(s):
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ''
        if in_str:
            out.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; out.append(c); i += 1; continue
        if c == '/' and nxt == '/':
            i += 2
            while i < n and s[i] not in '\r\n': i += 1
            continue
        if c == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                if s[i] in '\r\n': out.append(s[i])
                i += 1
            i += 2; continue
        out.append(c); i += 1
    s2 = ''.join(out)
    cleaned = []
    in_str = esc = False
    i, n = 0, len(s2)
    while i < n:
        c = s2[i]
        if in_str:
            cleaned.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; cleaned.append(c); i += 1; continue
        if c == ',':
            j = i + 1
            while j < n and s2[j].isspace(): j += 1
            if j < n and s2[j] in '}]':
                i += 1; continue
        cleaned.append(c); i += 1
    return ''.join(cleaned)

cfg = {}
if os.path.isfile(p):
    with open(p, encoding='utf-8') as f:
        cfg = json.loads(strip_json_comments(f.read()))
    if not isinstance(cfg, dict):
        raise ValueError('openclaw.json must be an object')
    if not os.path.exists(p + '.bak-agent-lb'):
        try:
            shutil.copy2(p, p + '.bak-agent-lb')
            os.chmod(p + '.bak-agent-lb', 0o600)
        except Exception:
            pass
os.makedirs(os.path.dirname(p), exist_ok=True, mode=0o700)
cfg.setdefault('models', {}).setdefault('providers', {})['agentlb'] = {
    'baseUrl': os.environ['SETUP_URL'].rstrip('/') + '/v1',
    'api': 'openai-completions',
    'apiKey': os.environ['SETUP_KEY'],
}
tmp = os.path.join(os.path.dirname(p), f'.{os.path.basename(p)}.tmp-{uuid.uuid4().hex}')
try:
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
        os.fchmod(f.fileno(), 0o600)
    os.replace(tmp, p)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
			say "[OK] Skonfigurowano OpenClaw ($HOME/.openclaw/openclaw.json)."
			EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }OpenClaw"
		fi
	fi
fi

if command -v hermes >/dev/null 2>&1 || [ -d "$HOME/.hermes" ]; then
	HERMES_SETUP=''
	HERMES_OK=0
	if [ -f "${BASH_SOURCE[0]:-}" ]; then HERMES_SETUP="$(dirname "${BASH_SOURCE[0]}")/hermes-setup.sh"; fi
	if [ -n "$HERMES_SETUP" ] && [ -f "$HERMES_SETUP" ]; then
		AGENT_LB_URL="$URL" AGENT_LB_API_KEY="$KEY" bash "$HERMES_SETUP" --url "$URL" </dev/null && HERMES_OK=1 || true
	else
		(set -o pipefail; curl -fsSL "$URL/hermes-setup.sh" | AGENT_LB_URL="$URL" AGENT_LB_API_KEY="$KEY" bash -s -- --url "$URL") </dev/null && HERMES_OK=1 || true
	fi
	if [ "$HERMES_OK" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
		if SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_HOME="$HOME" python3 - <<'PY' 2>/dev/null; then
import os, re, shutil, uuid
d = os.path.join(os.environ['SETUP_HOME'], '.hermes')
p = os.path.join(d, '.env')
if os.path.islink(p):
    raise RuntimeError('Refusing to overwrite symlink')
os.makedirs(d, exist_ok=True, mode=0o700)
lines = []
if os.path.isfile(p):
    if not os.path.exists(p + '.bak-agent-lb'):
        try:
            shutil.copy2(p, p + '.bak-agent-lb')
            os.chmod(p + '.bak-agent-lb', 0o600)
        except Exception:
            pass
    with open(p, encoding='utf-8') as f:
        for l in f.read().splitlines():
            if l and not re.match(r'^\s*(?:export\s+)?(AGENT_LB_API_KEY|AGENTLB_API_KEY|AGENT_LB_URL)=', l):
                lines.append(l)
lines.append('AGENT_LB_URL=' + os.environ['SETUP_URL'].rstrip('/'))
lines.append('AGENT_LB_API_KEY=' + os.environ['SETUP_KEY'])
tmp = os.path.join(d, f'..env.tmp-{uuid.uuid4().hex}')
try:
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
        os.fchmod(f.fileno(), 0o600)
    os.replace(tmp, p)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
			say "[OK] Zaktualizowano $HOME/.hermes/.env (Hermes Agent)."
			HERMES_OK=1
		fi
	fi
	if [ "$HERMES_OK" -eq 1 ]; then
		EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }Hermes Agent"
	else
		say "[Ostrzeżenie] Nie udało się skonfigurować Hermes Agent (pomijam)."
	fi
fi

if command -v herdr >/dev/null 2>&1 || [ -d "$HOME/.config/herdr" ]; then
	HERDR_DONE=""
	if command -v herdr >/dev/null 2>&1; then
		for ha in claude codex opencode agy; do
			present=0
			case "$ha" in
				claude) (command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]) && present=1 ;;
				codex) (command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]) && present=1 ;;
				opencode) (command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]) && present=1 ;;
				agy) (command -v agy >/dev/null 2>&1 || [ -x "$HOME/.local/bin/agylb" ]) && present=1 ;;
			esac
			if [ "$present" -eq 1 ] && herdr integration install "$ha" </dev/null >/dev/null 2>&1; then
				HERDR_DONE="${HERDR_DONE:+$HERDR_DONE, }$ha"
			fi
		done
	fi
	if [ -n "$HERDR_DONE" ]; then
		say "[OK] Zintegrowano Herdr dla agentów: $HERDR_DONE."
		EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }Herdr ($HERDR_DONE)"
	else
		EXTRA_APPS="${EXTRA_APPS:+$EXTRA_APPS, }Herdr"
	fi
fi

# Nie zabijamy procesów Codex hurtem (to przerywało trwające sesje użytkownika) —
# działające okna wczytają nową konfigurację po przeładowaniu.
if pgrep -u "$(id -u)" -f "codex.*app-server" >/dev/null 2>&1; then
	say "Działa Codex w VS Code — przeładuj okno (Ctrl+Shift+P → 'Developer: Reload Window'), by użył nowej konfiguracji."
fi

say ""
say "=== Wdrożenie i konfiguracja zakończona sukcesem! ==="
if command -v claude >/dev/null 2>&1; then
	say "✔ Claude Code CLI: $(claude --version 2>/dev/null || echo 'gotowy') -> uruchom 'claude'"
fi
if command -v codex >/dev/null 2>&1; then
	say "✔ OpenAI Codex CLI: $(codex --version 2>/dev/null || echo 'gotowy') -> uruchom 'codex --profile codexlb' lub 'codex'"
fi
if [ -n "$CONFIGURED_IDES" ]; then
	say "✔ Edytory IDE: $CONFIGURED_IDES (rozszerzenie Claude Code skonfigurowane pod proxy)"
elif [ -d "$HOME/.config/Code" ] || [ -d "$HOME/.vscode-server" ] || command -v code >/dev/null 2>&1; then
	say "✔ VS Code: oficjalne rozszerzenie Claude Code skonfigurowane pod proxy"
fi
if [ "$WITH_AGYLB" -eq 1 ]; then
	say "✔ AGY (pula Google): uruchom 'agylb' (standardowo) lub 'agylb-yolo' (bez pytań o akceptację)"
fi
if [ -n "$EXTRA_APPS" ]; then
	say "✔ Wykryte i skonfigurowane aplikacje: $EXTRA_APPS"
fi
say "✔ Agenty i narzędzia: zmienne zapisano w $ENV_FILE (załadowano do powłoki)"
say "✔ Serwer proxy: $URL"
say ""
say "Zrestartuj terminal lub otwórz nową kartę, aby wczytać zmienne środowiskowe."
say "W VS Code wciśnij Ctrl+Shift+P i wybierz 'Developer: Reload Window', aby odświeżyć rozszerzenia."
