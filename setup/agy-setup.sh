#!/usr/bin/env bash
# agy-setup.sh — instalator agybridge (prawdziwy AGY / Antigravity CLI) na stacji roboczej
#
# Instaluje https://github.com/tomaasz/agybridge i podłącza go do narzędzi
# znalezionych na tym komputerze:
#   - Hermes Agent  — wtyczka providera AGY (profile agy / agy-fast),
#   - OpenCode      — provider "agy" → lokalny serwer agybridge (127.0.0.1),
#   - OpenClaw      — provider "agy" → lokalny serwer agybridge,
#   - Claude Code   — serwer MCP "agybridge" (narzędzie agy_reason).
#
# AGY działa lokalnie, na koncie Google zalogowanym w `agy` na TYM komputerze.
# Ruch AGY nie przechodzi przez serwer agent-lb, więc klucz agent-lb nie jest
# tu potrzebny. Skrypt jest idempotentny — ponowne uruchomienie aktualizuje
# agybridge i odświeża konfigurację.
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/agy-setup.sh | bash
#   ./setup/agy-setup.sh [--dir KATALOG] [--ref GAŁĄŹ] [--port 8791]
#                        [--no-service] [--no-hermes] [--no-opencode]
#                        [--no-claw] [--no-claude]

set -eu

REPO_URL="${AGYBRIDGE_REPO:-https://github.com/tomaasz/agybridge.git}"
REF="${AGYBRIDGE_REF:-main}"
DIR="${AGYBRIDGE_DIR:-}"
PORT="${AGYBRIDGE_PORT:-8791}"
BIN_DIR="$HOME/.local/bin"
CONF_DIR="$HOME/.config/agybridge"
ENV_FILE="$CONF_DIR/agybridge.env"
DO_SERVICE=1
DO_HERMES=1
DO_OPENCODE=1
DO_CLAW=1
DO_CLAUDE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --no-service) DO_SERVICE=0 ;;
    --no-hermes) DO_HERMES=0 ;;
    --no-opencode) DO_OPENCODE=0 ;;
    --no-claw) DO_CLAW=0 ;;
    --no-claude) DO_CLAUDE=0 ;;
    # Przyjmowane dla zgodności z pozostałymi skryptami agent-lb (nieużywane).
    --url|--key|--lang) shift ;;
    -h|--help)
      echo "Użycie: $0 [--dir KATALOG] [--ref GAŁĄŹ] [--port 8791] [--no-service] [--no-hermes] [--no-opencode] [--no-claw] [--no-claude]"
      exit 0
      ;;
    *) echo "Nieznany argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$PORT" in
  ''|*[!0-9]*) echo "BŁĄD: --port musi być liczbą." >&2; exit 2 ;;
esac

WARNINGS=""
warn() {
  echo "  ⚠ $*" >&2
  WARNINGS="${WARNINGS}  - $*
"
}
step() { echo; echo "==> $*"; }

TS=$(date +%Y%m%d-%H%M%S)
backup() {
  if [ -e "$1" ]; then
    cp -p "$1" "$1.bak-$TS"
    echo "  Kopia zapasowa: $1.bak-$TS"
  fi
}

# ---------------------------------------------------------------------------
step "1/6 Sprawdzam wymagania"

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo "BŁĄD: obsługiwany jest Linux, macOS i WSL (na Windows uruchom w WSL)." >&2; exit 1 ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "BŁĄD: brak git. Zainstaluj go (np. sudo apt install git) i uruchom ponownie." >&2
  exit 1
fi

PY=""
for cand in python3.14 python3.13 python3.12 python3.11 python3; do
  if command -v "$cand" >/dev/null 2>&1 && \
     "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$(command -v "$cand")"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "BŁĄD: agybridge wymaga Pythona 3.11 lub nowszego." >&2
  exit 1
fi
echo "  Python: $PY ($("$PY" -c 'import platform; print(platform.python_version())'))"

if ! "$PY" -c 'import venv, ensurepip' >/dev/null 2>&1; then
  echo "BŁĄD: brak modułu venv/ensurepip dla $PY." >&2
  echo "      Debian/Ubuntu: sudo apt install python3-venv" >&2
  exit 1
fi

AGY_BIN="${AGY_CLI_PATH:-}"
if [ -z "$AGY_BIN" ]; then
  AGY_BIN="$(command -v agy 2>/dev/null || true)"
fi
if [ -z "$AGY_BIN" ] && [ -x "$BIN_DIR/agy" ]; then
  AGY_BIN="$BIN_DIR/agy"
fi
if [ -n "$AGY_BIN" ]; then
  echo "  AGY CLI: $AGY_BIN"
else
  warn "Nie znaleziono AGY CLI (polecenie 'agy'). agybridge zostanie zainstalowany, ale zadziała dopiero po instalacji Antigravity CLI i zalogowaniu (uruchom 'agy' raz ręcznie)."
fi

# ---------------------------------------------------------------------------
step "2/6 Instaluję agybridge"

# Przy `curl | bash` skrypt czyta się ze stdin — polecenia zewnętrzne dostają
# </dev/null, żeby nie połknęły jego dalszej części.

# Używamy istniejącej kopii repo, jeśli już jest na tym komputerze.
if [ -z "$DIR" ]; then
  for cand in "$HOME/projekty/agybridge" "$HOME/agybridge"; do
    if [ -d "$cand/.git" ]; then DIR="$cand"; break; fi
  done
fi
[ -n "$DIR" ] || DIR="$HOME/.local/share/agybridge"

if [ -d "$DIR/.git" ]; then
  echo "  Repozytorium: $DIR"
  if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "W $DIR są niezacommitowane zmiany — pomijam aktualizację repozytorium."
  elif git -C "$DIR" fetch --quiet origin "$REF" 2>/dev/null; then
    CUR_BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
    if [ "$CUR_BRANCH" = "$REF" ]; then
      git -C "$DIR" merge --ff-only --quiet FETCH_HEAD 2>/dev/null \
        || warn "Nie udało się zaktualizować $DIR (gałąź rozjechała się z origin/$REF)."
    else
      warn "$DIR jest na gałęzi '$CUR_BRANCH', nie '$REF' — pomijam aktualizację."
    fi
  else
    warn "Nie udało się pobrać zmian z origin — instaluję obecną wersję z $DIR."
  fi
else
  echo "  Klonuję $REPO_URL → $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$REF" "$REPO_URL" "$DIR" </dev/null
fi
echo "  Wersja: $(git -C "$DIR" rev-parse --short HEAD)"

VENV="$DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true

MCP_OK=1
if ! "$VENV/bin/python" -m pip install --quiet --upgrade "$DIR[mcp]" </dev/null; then
  warn "Instalacja z obsługą MCP nie powiodła się — instaluję wersję podstawową (bez serwera MCP dla Claude Code)."
  MCP_OK=0
  "$VENV/bin/python" -m pip install --quiet --upgrade "$DIR" </dev/null
fi

mkdir -p "$BIN_DIR"
for exe in agybridge agybridge-serve agybridge-mcp; do
  if [ -x "$VENV/bin/$exe" ]; then
    ln -sfn "$VENV/bin/$exe" "$BIN_DIR/$exe"
  fi
done
AGYBRIDGE="$BIN_DIR/agybridge"
"$AGYBRIDGE" --help >/dev/null
echo "  Zainstalowano: $AGYBRIDGE"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR nie jest w PATH — dodaj go do profilu powłoki." ;;
esac

# Token lokalnego serwera HTTP: generowany na miejscu, nigdy nie wypisywany.
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
if [ ! -f "$ENV_FILE" ] || ! grep -q '^AGYBRIDGE_TOKEN=.' "$ENV_FILE"; then
  (
    umask 077
    TOKEN="$("$VENV/bin/python" -c 'import secrets; print("agyb-" + secrets.token_urlsafe(32))')"
    {
      echo "# agybridge — konfiguracja lokalnego serwera (generowane przez agy-setup.sh)"
      echo "AGYBRIDGE_TOKEN=$TOKEN"
      echo "HERMES_AGY_PERSISTENT=1"
    } > "$ENV_FILE"
  )
  echo "  Wygenerowano token serwera w $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
TOKEN="$(sed -n 's/^AGYBRIDGE_TOKEN=//p' "$ENV_FILE" | head -n 1)"
if [ -n "$AGY_BIN" ]; then
  if grep -q '^AGY_CLI_PATH=' "$ENV_FILE"; then
    sed -i.tmp "s|^AGY_CLI_PATH=.*|AGY_CLI_PATH=$AGY_BIN|" "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    echo "AGY_CLI_PATH=$AGY_BIN" >> "$ENV_FILE"
  fi
fi

BASE_URL="http://127.0.0.1:$PORT/v1"

# ---------------------------------------------------------------------------
step "3/6 Lokalny serwer agybridge (127.0.0.1:$PORT)"

SERVICE_OK=0
if [ "$DO_SERVICE" = "0" ]; then
  echo "  Pominięto (--no-service)."
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/agybridge.service"
  mkdir -p "$UNIT_DIR"
  SVC_PATH="$BIN_DIR"
  [ -n "$AGY_BIN" ] && SVC_PATH="$(dirname "$AGY_BIN"):$SVC_PATH"
  SVC_PATH="$SVC_PATH:/usr/local/bin:/usr/bin:/bin"
  cat > "$UNIT" <<EOF
[Unit]
Description=agybridge — lokalny serwer OpenAI-compatible dla AGY CLI
After=network.target

[Service]
Type=simple
ExecStart=$AGYBRIDGE serve --host 127.0.0.1 --port $PORT
EnvironmentFile=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$SVC_PATH
WorkingDirectory=%h
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet agybridge.service
  systemctl --user restart agybridge.service
  echo "  Usługa systemd (użytkownika): agybridge.service — włączona i uruchomiona."
  if command -v loginctl >/dev/null 2>&1 && \
     [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 \
      || warn "Usługa działa tylko gdy jesteś zalogowany. Aby działała stale: sudo loginctl enable-linger $(id -un)"
  fi

  # Sprawdzenie, czy serwer odpowiada (token przez stdin, nie w argumentach).
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
      | curl -s -o /dev/null -w '%{http_code}' -m 3 -K - "$BASE_URL/models" 2>/dev/null || true)"
    if [ "$CODE" = "200" ]; then SERVICE_OK=1; break; fi
    sleep 1
  done
  if [ "$SERVICE_OK" = "1" ]; then
    echo "  Serwer odpowiada: $BASE_URL (HTTP 200)"
  else
    warn "Serwer agybridge nie odpowiada na $BASE_URL. Sprawdź: journalctl --user -u agybridge -n 50"
  fi
else
  START="$BIN_DIR/agybridge-start"
  cat > "$START" <<EOF
#!/usr/bin/env bash
# Uruchamia lokalny serwer agybridge (brak systemd --user na tym komputerze).
set -a; . "$ENV_FILE"; set +a
exec "$AGYBRIDGE" serve --host 127.0.0.1 --port $PORT "\$@"
EOF
  chmod 755 "$START"
  warn "Brak systemd --user — serwer nie startuje sam. Uruchamiaj go poleceniem: agybridge-start"
fi

# ---------------------------------------------------------------------------
step "4/6 Hermes Agent"

HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
HERMES_DONE=0
if [ "$DO_HERMES" = "0" ]; then
  echo "  Pominięto (--no-hermes)."
elif [ -d "$HERMES_HOME_DIR" ] || command -v hermes >/dev/null 2>&1; then
  PLUG_PARENT="$HERMES_HOME_DIR/plugins/model-providers"
  PLUG="$PLUG_PARENT/agy"
  mkdir -p "$PLUG_PARENT"
  # Dowiązanie zamiast kopii: wtyczka szuka kodu agybridge względem swojej
  # prawdziwej lokalizacji w repozytorium, a aktualizacja repo od razu ją odświeża.
  if [ -L "$PLUG" ]; then
    ln -sfn "$DIR/plugins/model-providers/agy" "$PLUG"
  elif [ -e "$PLUG" ]; then
    mv "$PLUG" "$PLUG.bak-$TS"
    echo "  Poprzednia wtyczka przeniesiona do: $PLUG.bak-$TS"
    ln -sfn "$DIR/plugins/model-providers/agy" "$PLUG"
  else
    ln -sfn "$DIR/plugins/model-providers/agy" "$PLUG"
  fi
  echo "  Wtyczka AGY: $PLUG → $DIR/plugins/model-providers/agy"
  HERMES_DONE=1
else
  echo "  Nie znaleziono Hermesa — pomijam."
fi

# ---------------------------------------------------------------------------
step "5/6 OpenCode i OpenClaw"

# Dopisuje provider "agy" do pliku JSON bez ruszania reszty konfiguracji.
# Plik, którego nie da się sparsować (np. z komentarzami), zostaje nietknięty.
set_json_provider() {
  target="$1" kind="$2"
  mkdir -p "$(dirname "$target")"
  [ -f "$target" ] && backup "$target"
  AGYB_TOKEN="$TOKEN" "$VENV/bin/python" - "$target" "$kind" "$BASE_URL" <<'PYEOF'
import json, os, sys

path, kind, base_url = sys.argv[1], sys.argv[2], sys.argv[3]
token = os.environ["AGYB_TOKEN"]
cfg = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except ValueError:
        print(f"  Nie mogę odczytać {path} jako JSON — pomijam (dodaj provider ręcznie).", file=sys.stderr)
        sys.exit(3)
    if not isinstance(cfg, dict):
        print(f"  {path} nie zawiera obiektu JSON — pomijam.", file=sys.stderr)
        sys.exit(3)

models = {
    "gemini-3.8-flash-high": {"name": "AGY – Gemini 3.8 Flash High"},
    "gemini-3.8-flash-low": {"name": "AGY Fast – Gemini 3.8 Flash Low"},
}
if kind == "opencode":
    providers = cfg.setdefault("provider", {})
    providers["agy"] = {
        "npm": "@ai-sdk/openai-compatible",
        "name": "AGY (lokalnie, agybridge)",
        "options": {"baseURL": base_url, "apiKey": token},
        "models": models,
    }
else:
    providers = cfg.setdefault("models", {}).setdefault("providers", {})
    providers["agy"] = {
        "baseUrl": base_url,
        "api": "openai-completions",
        "apiKey": token,
        "models": [{"id": k, "name": v["name"]} for k, v in models.items()],
    }

tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PYEOF
}

OPENCODE_DONE=0
OPENCODE_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
if [ "$DO_OPENCODE" = "0" ]; then
  echo "  OpenCode: pominięto (--no-opencode)."
elif [ -d "$(dirname "$OPENCODE_CFG")" ] || command -v opencode >/dev/null 2>&1; then
  if set_json_provider "$OPENCODE_CFG" opencode; then
    echo "  OpenCode: provider 'agy' → $BASE_URL ($OPENCODE_CFG)"
    OPENCODE_DONE=1
  else
    warn "OpenCode: nie zaktualizowano $OPENCODE_CFG."
  fi
else
  echo "  OpenCode: nie znaleziono — pomijam."
fi

CLAW_DONE=0
CLAW_CFG="$HOME/.openclaw/openclaw.json"
if [ "$DO_CLAW" = "0" ]; then
  echo "  OpenClaw: pominięto (--no-claw)."
elif [ -d "$HOME/.openclaw" ] || command -v openclaw >/dev/null 2>&1; then
  if set_json_provider "$CLAW_CFG" claw; then
    echo "  OpenClaw: provider 'agy' → $BASE_URL ($CLAW_CFG)"
    CLAW_DONE=1
  else
    warn "OpenClaw: nie zaktualizowano $CLAW_CFG."
  fi
else
  echo "  OpenClaw: nie znaleziono — pomijam."
fi

# ---------------------------------------------------------------------------
step "6/6 Claude Code (serwer MCP)"

CLAUDE_DONE=0
if [ "$DO_CLAUDE" = "0" ]; then
  echo "  Pominięto (--no-claude)."
elif ! command -v claude >/dev/null 2>&1; then
  echo "  Nie znaleziono Claude Code — pomijam."
elif [ "$MCP_OK" = "0" ]; then
  warn "Claude Code: pominięto serwer MCP (brak pakietu mcp)."
else
  claude mcp remove agybridge -s user </dev/null >/dev/null 2>&1 || true
  # Nazwa serwera musi stać przed -e (opcja -e przyjmuje wiele wartości).
  set -- claude mcp add agybridge -s user
  [ -n "$AGY_BIN" ] && set -- "$@" -e "AGY_CLI_PATH=$AGY_BIN"
  if "$@" -- "$AGYBRIDGE" mcp </dev/null >/dev/null 2>&1; then
    echo "  Serwer MCP 'agybridge' dodany (zasięg: user) — narzędzie agy_reason."
    CLAUDE_DONE=1
  else
    warn "Claude Code: nie udało się dodać serwera MCP. Ręcznie: claude mcp add -s user agybridge -- $AGYBRIDGE mcp"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "=== agybridge gotowy ==="
echo "  Repozytorium:  $DIR"
echo "  Polecenie:     $AGYBRIDGE"
echo "  Konfiguracja:  $ENV_FILE (token — nie udostępniaj)"
[ "$SERVICE_OK" = "1" ] && echo "  Serwer HTTP:   $BASE_URL"
[ "$HERMES_DONE" = "1" ] && echo "  Hermes:        wtyczka AGY zainstalowana"
[ "$OPENCODE_DONE" = "1" ] && echo "  OpenCode:      provider 'agy' (modele gemini-3.8-flash-high / -low)"
[ "$CLAW_DONE" = "1" ] && echo "  OpenClaw:      provider 'agy'"
[ "$CLAUDE_DONE" = "1" ] && echo "  Claude Code:   MCP 'agybridge'"

if [ "$HERMES_DONE" = "1" ]; then
  echo
  echo "Hermes: aby dopisać modele agy / agy-fast do konfiguracji, uruchom hermes-setup.sh"
  echo "(wykryje wtyczkę automatycznie). Jeśli gateway Hermesa już działa, zrestartuj go:"
  echo "  systemctl --user restart hermes-gateway"
fi

if [ -n "$WARNINGS" ]; then
  echo
  echo "Uwagi:"
  printf '%s' "$WARNINGS"
fi
