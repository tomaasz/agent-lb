#!/usr/bin/env bash
# claude-lb / teamclaude client setup script (Debian/Ubuntu/WSL/macOS).
#
# Jeśli w systemie jest Node.js, deleguje zadanie do uniwersalnego setup.js,
# który kompleksowo konfiguruje CLI, VS Code oraz zapobiega konfliktom OAuth.
#
# Użycie:
#   ./setup.sh
#   ./setup.sh --url https://your-server.com
#   ./setup.sh --key tc-...
#   ./setup.sh --test

set -euo pipefail

if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
	if command -v node >/dev/null 2>&1; then
		if [ -f "$SCRIPT_DIR/setup.js" ]; then
			exec node "$SCRIPT_DIR/setup.js" "$@"
		elif [ -f "$SCRIPT_DIR/teamclaude-setup.js" ]; then
			exec node "$SCRIPT_DIR/teamclaude-setup.js" "$@"
		fi
	fi
fi

# Fallback w czystym bashu, gdy brak node
URL="${CLAUDE_LB_URL:-${TEAMCLAUDE_URL:-http://localhost:3456}}"
ENV_FILE="${CLAUDE_LB_ENV_FILE:-${TEAMCLAUDE_ENV_FILE:-$HOME/.config/claude-lb.env}}"
BIN_DIR="${HOME}/bin"
RUN_TEST=0
SETUP_CODEX=0
KEY="${CLAUDE_LB_API_KEY:-${TEAMCLAUDE_API_KEY:-${ANTHROPIC_API_KEY:-}}}"

while [ $# -gt 0 ]; do
	case "$1" in
		--test) RUN_TEST=1 ;;
		--codex) SETUP_CODEX=1 ;;
		--url) URL="${2%/}"; shift ;;
		--key) KEY="$2"; shift ;;
		-h|--help)
			echo "Użycie: ./setup.sh [--url URL] [--key KEY] [--codex] [--test]"
			exit 0
			;;
		*) echo "Nieznany argument: $1" >&2; exit 2 ;;
	esac
	shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'BLAD: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "brak curl"

if [ -z "$KEY" ] && [ -r "$ENV_FILE" ]; then
	KEY="$(sed -n 's/^export ANTHROPIC_API_KEY=//p' "$ENV_FILE" | tr -d '"'\''' | head -1)"
	[ -n "$KEY" ] && say "Używam klucza zapisanego w $ENV_FILE."
fi
if [ -z "$KEY" ] && [ -r "$HOME/.config/teamclaude.env" ]; then
	KEY="$(sed -n 's/^export ANTHROPIC_API_KEY=//p' "$HOME/.config/teamclaude.env" | tr -d '"'\''' | head -1)"
	[ -n "$KEY" ] && say "Używam klucza zapisanego w ~/.config/teamclaude.env."
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

say "Sprawdzam połączenie z $URL..."
code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "x-api-key: $KEY" "$URL/teamclaude/status" || true)"
if [ "$code" = "404" ]; then
	code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "x-api-key: $KEY" "$URL/status" || true)"
fi
case "$code" in
	200) say "OK — klucz poprawny, proxy odpowiada." ;;
	401|403) die "serwer odrzucił klucz ($code)." ;;
	000) die "brak połączenia z $URL. Sprawdź Tailscale/sieć." ;;
	*) say "Otrzymano kod $code — kontynuuję konfigurację." ;;
esac

# Zabezpieczenie przed Auth conflict
CREDS="$HOME/.claude/.credentials.json"
if [ -f "$CREDS" ]; then
	BAK="$CREDS.bak-$(date +%s)"
	mv "$CREDS" "$BAK"
	say "Zabezpieczono starą sesję OAuth (.credentials.json -> $(basename "$BAK")), by uniknąć 'Auth conflict'."
fi

# Zapis konfiguracji środowiskowej
mkdir -p "$(dirname "$ENV_FILE")" "$BIN_DIR"
umask 077
cat > "$ENV_FILE" <<-EOF
# Agent LB environment configuration
export ANTHROPIC_BASE_URL="$URL"
export ANTHROPIC_API_KEY="$KEY"
export CODEX_BASE_URL="$URL/backend-api/codex"
export OPENAI_BASE_URL="$URL/v1"
export CODEX_LB_API_KEY="$KEY"
EOF
chmod 600 "$ENV_FILE"
say "Zapisano $ENV_FILE."
if [ "$ENV_FILE" != "$HOME/.config/teamclaude.env" ]; then
	cp -f "$ENV_FILE" "$HOME/.config/teamclaude.env" 2>/dev/null || true
fi

# Konfiguracja ~/.claude/settings.json (CLI Claude Code)
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
if [ ! -f "$CLAUDE_SETTINGS" ]; then
	echo '{"env":{}}' > "$CLAUDE_SETTINGS"
fi
# Dopisanie zmiennych jeśli python jest dostępny
if command -v python3 >/dev/null 2>&1; then
	python3 -c "
import json
p = '$CLAUDE_SETTINGS'
try:
    with open(p, 'r') as f: data = json.load(f)
except Exception: data = {}
data.setdefault('env', {})
data['env']['ANTHROPIC_BASE_URL'] = '$URL'
data['env']['ANTHROPIC_API_KEY'] = '$KEY'
with open(p, 'w') as f: json.dump(data, f, indent=2)
" 2>/dev/null && say "Zaktualizowano $CLAUDE_SETTINGS."
fi

# Konfiguracja ~/.codex (OpenAI Codex CLI: config.toml oraz config.json)
mkdir -p "$HOME/.codex"
CODEX_TOML="$HOME/.codex/config.toml"
if [ ! -f "$CODEX_TOML" ] || ! grep -qF "model_providers.codex-lb" "$CODEX_TOML" 2>/dev/null; then
	cat >> "$CODEX_TOML" <<-EOF

# >>> codexlb >>> (zarzadzane przez setup.sh)
[model_providers.codex-lb]
name = "openai"
base_url = "$URL/backend-api/codex"
wire_api = "responses"
supports_websockets = true
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
	python3 -c "
import json
p = '$CODEX_CONF'
try:
    with open(p, 'r') as f: data = json.load(f)
except Exception: data = {}
data['base_url'] = '$URL/backend-api/codex'
with open(p, 'w') as f: json.dump(data, f, indent=2)
" 2>/dev/null && say "Zaktualizowano $CODEX_CONF."
fi

# Integracja z powłoką
src_line=". \"$ENV_FILE\"  # teamclaude"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
	[ -f "$rc" ] || continue
	if [ -w "$rc" ]; then
		if ! grep -qF "# teamclaude" "$rc" 2>/dev/null; then
			printf '\n%s\n' "$src_line" >> "$rc" 2>/dev/null && say "Dopisano wczytywanie do $rc." || true
		fi
	else
		say "Pominięto $rc (brak uprawnień do zapisu)."
	fi
done

if [ "$RUN_TEST" -eq 1 ] && command -v claude >/dev/null 2>&1; then
	say "Test claude --version:"
	ANTHROPIC_BASE_URL="$URL" ANTHROPIC_API_KEY="$KEY" claude --version || true
fi

say "Gotowe!"
