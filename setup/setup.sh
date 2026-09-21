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
NO_INSTALL=0
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${CLAUDE_LB_API_KEY:-${CODEX_LB_API_KEY:-${ANTHROPIC_API_KEY:-}}}}}"

while [ $# -gt 0 ]; do
	case "$1" in
		--test) RUN_TEST=1 ;;
		--codex) SETUP_CODEX=1 ;;
		--uninstall) UNINSTALL=1 ;;
		--no-install|--skip-install) NO_INSTALL=1 ;;
		--url) URL="${2%/}"; shift ;;
		--key) KEY="$2"; shift ;;
		-h|--help)
			echo "Użycie: ./setup.sh [--url URL] [--key KEY] [--codex] [--test] [--no-install] [--uninstall]"
			exit 0
			;;
		*) echo "Nieznany argument: $1" >&2; exit 2 ;;
	esac
	shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'BLAD: %s\n' "$*" >&2; exit 1; }
backup_existing() {
	local file="$1"
	[ -f "$file" ] || return 0
	local backup="${file}.bak-$(date +%s)"
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
	if [ "$NO_INSTALL" -eq 1 ]; then
		say "  -> Pominięto instalację Node.js (--no-install)."
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
	elif command -v sudo >/dev/null 2>&1; then
		say "  -> Wymagane uprawnienia administratora do zapisu w globalnym katalogu npm (sudo)..."
		if sudo npm install -g "$pkg_name" 2>/dev/null; then
			say "[OK] Pomyślnie zainstalowano $title ($cmd_name) przez sudo."
		else
			say "  [Uwaga] Instalacja przez sudo nie powiodła się. Możesz zainstalować ręcznie: npm install -g $pkg_name"
		fi
	else
		say "  [Uwaga] Brak uprawnień do zapisu w globalnym katalogu npm. Zainstaluj ręcznie: npm install -g $pkg_name"
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
        env.pop('ANTHROPIC_CUSTOM_HEADERS', None)
        existing = env.get('ANTHROPIC_CUSTOM_HEADERS')
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
	if [ -f "$HOME/.codex/config.toml" ]; then
		backup_existing "$HOME/.codex/config.toml"
		awk '
			/# >>> codexlb >>>/ { skip=1; next }
			/# <<< codexlb <<</ { skip=0; next }
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
	401|403) die "serwer odrzucił klucz ($code). Podaj prawidłowy klucz stacji roboczej (znajdziesz go w panelu https://agentlb.gotova.pl)." ;;
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
if [ -f "$CREDS" ]; then
	BAK="$CREDS.bak-$(date +%s)"
	if cp -f "$CREDS" "$BAK"; then
		say "Wykryto sesję OAuth — utworzono kopię zapasową (.credentials.json -> $(basename "$BAK"))."
	else
		say "Ostrzeżenie: nie udało się utworzyć kopii .credentials.json; kontynuuję bez jej usuwania."
	fi
fi
if [ "$OAUTH_SESSION" -eq 1 ]; then
	say "Zachowuję tryb OAuth Claude Code; klucz proxy przekazuję przez ANTHROPIC_CUSTOM_HEADERS."
fi

# Zapis konfiguracji środowiskowej
mkdir -p "$(dirname "$ENV_FILE")" "$BIN_DIR"
umask 077
backup_existing "$ENV_FILE"
shell_quote() {
	local value="$1"
	value="${value//\'/\'\\\'\'}"
	printf "'%s'" "$value"
}
{
	printf '%s\n' '# Agent LB environment configuration'
	printf 'export ANTHROPIC_BASE_URL=%s\n' "$(shell_quote "$URL")"
	if [ "$OAUTH_SESSION" -eq 1 ]; then
		printf '%s\n' 'unset ANTHROPIC_API_KEY  # preserve Claude Code OAuth session'
		printf 'export ANTHROPIC_CUSTOM_HEADERS=%s\n' "$(shell_quote "x-api-key: $KEY")"
		EXISTING_HDRS=""
		if [ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]; then
			EXISTING_HDRS="$(printf '%s\n' "$ANTHROPIC_CUSTOM_HEADERS" | grep -iv '^x-api-key:' || true)"
		fi
		if [ -n "$EXISTING_HDRS" ]; then
			printf 'export ANTHROPIC_CUSTOM_HEADERS=%s\n' "$(shell_quote "$(printf '%s\nx-api-key: %s' "$EXISTING_HDRS" "$KEY")")"
		else
			printf 'export ANTHROPIC_CUSTOM_HEADERS=%s\n' "$(shell_quote "x-api-key: $KEY")"
		fi
	else
		printf 'export ANTHROPIC_API_KEY=%s\n' "$(shell_quote "$KEY")"
		printf '%s\n' 'unset ANTHROPIC_CUSTOM_HEADERS'
		EXISTING_HDRS=""
		if [ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]; then
			EXISTING_HDRS="$(printf '%s\n' "$ANTHROPIC_CUSTOM_HEADERS" | grep -iv '^x-api-key:' || true)"
		fi
		if [ -n "$EXISTING_HDRS" ]; then
			printf 'export ANTHROPIC_CUSTOM_HEADERS=%s\n' "$(shell_quote "$EXISTING_HDRS")"
		else
			printf '%s\n' 'unset ANTHROPIC_CUSTOM_HEADERS'
		fi
	fi
	printf 'export CODEX_BASE_URL=%s\n' "$(shell_quote "$URL/backend-api/codex")"
	printf 'export OPENAI_BASE_URL=%s\n' "$(shell_quote "$URL/v1")"
	printf 'export OPENAI_API_KEY=%s\n' "$(shell_quote "$KEY")"
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
    data['env']['ANTHROPIC_CUSTOM_HEADERS'] = 'x-api-key: ' + os.environ['SETUP_KEY']
    data['env']['ANTHROPIC_CUSTOM_HEADERS'] = set_custom_header(data['env'].get('ANTHROPIC_CUSTOM_HEADERS'), 'x-api-key', os.environ['SETUP_KEY'])
else:
    data['env']['ANTHROPIC_API_KEY'] = os.environ['SETUP_KEY']
    data['env'].pop('ANTHROPIC_CUSTOM_HEADERS', None)
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

# Konfiguracja oficjalnego rozszerzenia Claude Code w VS Code (zarówno desktop jak i Remote SSH)
if command -v python3 >/dev/null 2>&1; then
	SETUP_URL="$URL" SETUP_KEY="$KEY" SETUP_OAUTH="$OAUTH_SESSION" python3 - <<'PY' 2>/dev/null || true
import json, os

url = os.environ['SETUP_URL']
key = os.environ['SETUP_KEY']
oauth = os.environ.get('SETUP_OAUTH') == '1'

targets = [
    os.path.expanduser('~/.config/Code/User/settings.json'),
    os.path.expanduser('~/.vscode-server/data/Machine/settings.json'),
    os.path.expanduser('~/.vscode-server/data/User/settings.json'),
    os.path.expanduser('~/.vscode-server-insiders/data/Machine/settings.json'),
    os.path.expanduser('~/.vscode-server-insiders/data/User/settings.json')
]

def update_file(p):
    d = os.path.dirname(p)
    if not os.path.isdir(d):
        base = os.path.dirname(d)
        if not os.path.isdir(base):
            return
        os.makedirs(d, exist_ok=True)
    try:
        with open(p, encoding='utf-8') as f: data = json.load(f)
    except Exception: data = {}
    data['claudeCode.disableLoginPrompt'] = True
    data['claudeCode.hideOnboarding'] = True
    env_vars = [e for e in data.get('claudeCode.environmentVariables', []) if e.get('name') not in ('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')]
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
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.write('\n')

for t in targets:
    update_file(t)
PY
fi

# Konfiguracja ~/.codex (OpenAI Codex CLI: config.toml oraz config.json)
mkdir -p "$HOME/.codex"
CODEX_TOML="$HOME/.codex/config.toml"
if [ ! -f "$CODEX_TOML" ] || ! grep -qF "model_providers.codex-lb" "$CODEX_TOML" 2>/dev/null; then
	backup_existing "$CODEX_TOML"
	cat >> "$CODEX_TOML" <<-EOF

# >>> codexlb >>> (zarzadzane przez setup.sh)
[model_providers.codex-lb]
name = "openai"
base_url = "$URL/backend-api/codex"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = true
env_key = "CODEX_LB_API_KEY"

[profiles.codexlb]
model = "gpt-5.6-sol"
model_provider = "codex-lb"
model_reasoning_effort = "xhigh"
# <<< codexlb <<<
EOF
	say "Zaktualizowano $CODEX_TOML (profil codexlb)."
fi

CODEX_CONF="$HOME/.codex/config.json"
if command -v python3 >/dev/null 2>&1; then
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

say ""
say "=== Wdrożenie i konfiguracja zakończona sukcesem! ==="
if command -v claude >/dev/null 2>&1; then
	say "✔ Claude Code CLI: $(claude --version 2>/dev/null || echo 'gotowy') -> uruchom 'claude'"
fi
if command -v codex >/dev/null 2>&1; then
	say "✔ OpenAI Codex CLI: $(codex --version 2>/dev/null || echo 'gotowy') -> uruchom 'codex --profile codexlb' lub 'codex'"
fi
if [ -d "$HOME/.config/Code" ] || [ -d "$HOME/.vscode-server" ] || command -v code >/dev/null 2>&1; then
	say "✔ VS Code: oficjalne rozszerzenie Claude Code skonfigurowane pod proxy"
fi
say "✔ Agenty i narzędzia: zmienne zapisano w $ENV_FILE (załadowano do powłoki)"
say "✔ Serwer proxy: $URL"
say ""
say "Zrestartuj terminal lub otwórz nową kartę, aby wczytać zmienne środowiskowe."
