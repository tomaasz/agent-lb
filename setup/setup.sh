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
		--no-install|--skip-install) NO_INSTALL=1 ;;
		--install-node) INSTALL_NODE=1 ;;
		--url) URL="${2%/}"; shift ;;
		--key) KEY="$2"; shift ;;
		--lang) LANG_VAL="$2"; shift ;;
		-h|--help)
			echo "Usage / Użycie: ./setup.sh [--url URL] [--key KEY] [--lang pl|en] [--codex] [--with-agy] [--test] [--no-install] [--install-node] [--uninstall]"
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
import json, os
home = os.environ['SETUP_HOME']
for base in ('.config/Code/User', '.vscode-server/data/Machine', '.vscode-server/data/User',
             '.vscode-server-insiders/data/Machine', '.vscode-server-insiders/data/User'):
    p = os.path.join(home, base, 'settings.json')
    try:
        with open(p, encoding='utf-8') as f: data = json.load(f)
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    env_vars = [e for e in data.get('claudeCode.environmentVariables', [])
                if e.get('name') not in ('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')]
    for e in env_vars:
        if e.get('name') == 'ANTHROPIC_CUSTOM_HEADERS':
            e['value'] = '\n'.join(l.strip() for l in str(e.get('value', '')).splitlines()
                                   if l.strip() and not l.strip().lower().startswith('x-api-key:'))
    env_vars = [e for e in env_vars if e.get('name') != 'ANTHROPIC_CUSTOM_HEADERS' or e.get('value')]
    if env_vars: data['claudeCode.environmentVariables'] = env_vars
    else: data.pop('claudeCode.environmentVariables', None)
    data.pop('claudeCode.disableLoginPrompt', None)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2); f.write('\n')
PY
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
if [ -d "$HOME/.config/Code" ] || [ -d "$HOME/.vscode-server" ] || command -v code >/dev/null 2>&1; then
	say "✔ VS Code: oficjalne rozszerzenie Claude Code skonfigurowane pod proxy"
fi
say "✔ Agenty i narzędzia: zmienne zapisano w $ENV_FILE (załadowano do powłoki)"
say "✔ Serwer proxy: $URL"
say ""
say "Zrestartuj terminal lub otwórz nową kartę, aby wczytać zmienne środowiskowe."
say "W VS Code wciśnij Ctrl+Shift+P i wybierz 'Developer: Reload Window', aby odświeżyć rozszerzenia."
