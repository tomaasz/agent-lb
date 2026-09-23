#!/usr/bin/env bash
# orca-setup.sh — Konfigurator providera AgentLB w środowisku Orca (stablyai/orca)
#
# Orca jest otwartoźródłowym środowiskiem ADE (Agent Development Environment),
# które orkiestruje agenty (Claude Code, OpenAI Codex, OpenCode) w równoległych worktree.
#
# Niniejszy skrypt:
# 1. Konfiguruje profil zmiennych środowiskowych ~/.config/agent-lb.env
# 2. Aktualizuje ~/.claude/settings.json (zachowując nienaruszone hooki orkiestracji Orca)
# 3. Aktualizuje konfigurację OpenAI Codex (~/.codex/config.json oraz ~/.codex/config.toml)
# 4. Rejestruje providera 'agentlb' w ~/.config/opencode/opencode.json
# 5. Konfiguruje środowisko ADE Orca (~/.config/orca) oraz terminale PTY (~/.bashrc, ~/.zshrc)
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/orca-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/orca-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

set -eu

URL="${AGENT_LB_URL:-${AGENTLB_URL:-https://agentlb.gotova.pl}}"
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${OPENAI_API_KEY:-}}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift ;;
    --key) KEY="$2"; shift ;;
    -h|--help)
      echo "Użycie: $0 [--key KLUCZ] [--url URL]"
      echo ""
      echo "Opcje:"
      echo "  --key KLUCZ   Klucz stacji roboczej AgentLB (tc-...)"
      echo "  --url URL     Adres URL instancji AgentLB (domyślnie: https://agentlb.gotova.pl)"
      echo "  -h, --help    Wyświetla tę pomoc"
      exit 0
      ;;
    *) echo "Nieznany argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$KEY" ]; then
  if [ -t 0 ]; then
    read -r -p "Podaj klucz stacji roboczej (tc-...): " KEY
  fi
fi

if [ -z "$KEY" ]; then
  echo "BŁĄD: Brak klucza stacji roboczej. Użyj: $0 --key <KLUCZ>" >&2
  exit 1
fi

echo "Sprawdzam połączenie z $URL..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$URL/v1/models" -H "Authorization: Bearer $KEY" || echo "000")
if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "401" ] && [ "$HTTP_STATUS" != "403" ]; then
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$URL/v1/models" -H "x-api-key: $KEY" || echo "000")
fi

if [ "$HTTP_STATUS" = "200" ]; then
  echo "OK — połączenie z AgentLB nawiązane pomyślnie."
else
  echo "Ostrzeżenie: Proxy zwróciło status HTTP $HTTP_STATUS, kontynuuję konfigurację..."
fi

backup_existing() {
  local file="$1"
  [ -f "$file" ] || return 0
  local backup="${file}.bak-$(date +%s)"
  if cp -p "$file" "$backup" 2>/dev/null || cp "$file" "$backup" 2>/dev/null; then
    chmod 600 "$backup" 2>/dev/null || true
    echo "Utworzono kopię zapasową: $backup"
  fi
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# 1. Główny plik środowiskowy ~/.config/agent-lb.env
mkdir -p "$HOME/.config"
ENV_FILE="$HOME/.config/agent-lb.env"
backup_existing "$ENV_FILE"

OAUTH_SESSION=0
if [ -f "$HOME/.claude/.credentials.json" ]; then
  OAUTH_SESSION=1
  echo "Wykryto sesję OAuth Claude Code — używam x-api-key w nagłówkach."
fi

{
  printf '%s\n' '# Agent LB environment configuration for Orca & Agents'
  printf 'export ANTHROPIC_BASE_URL=%s\n' "$(shell_quote "$URL")"
  if [ "$OAUTH_SESSION" -eq 1 ]; then
    printf '%s\n' 'unset ANTHROPIC_API_KEY  # preserve Claude Code OAuth session'
    printf 'export ANTHROPIC_CUSTOM_HEADERS=%s\n' "$(shell_quote "x-api-key: $KEY")"
  else
    printf 'export ANTHROPIC_API_KEY=%s\n' "$(shell_quote "$KEY")"
    printf '%s\n' 'unset ANTHROPIC_CUSTOM_HEADERS'
  fi
  printf 'export OPENAI_BASE_URL=%s\n' "$(shell_quote "$URL/v1")"
  printf 'export OPENAI_API_KEY=%s\n' "$(shell_quote "$KEY")"
  printf 'export CODEX_BASE_URL=%s\n' "$(shell_quote "$URL/backend-api/codex")"
  printf 'export CODEX_LB_API_KEY=%s\n' "$(shell_quote "$KEY")"
  printf 'export AGENT_LB_API_KEY=%s\n' "$(shell_quote "$KEY")"
  printf 'export AGENT_LB_URL=%s\n' "$(shell_quote "$URL")"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true
echo "Zapisano profil środowiskowy: $ENV_FILE"

# 2. Konfiguracja Claude Code CLI w Orca (~/.claude/settings.json)
# UWAGA: Orca wstrzykuje własne hooki do settings.json — zachowujemy je w całości!
CLAUDE_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_DIR"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"

if [ -f "$CLAUDE_SETTINGS" ]; then
  backup_existing "$CLAUDE_SETTINGS"
fi

if command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const p = "$CLAUDE_SETTINGS";
let data = {};
if (fs.existsSync(p)) {
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
}
data.env = data.env || {};
data.env.ANTHROPIC_BASE_URL = "$URL";

const isOAuth = "$OAUTH_SESSION" === "1";
if (isOAuth) {
  delete data.env.ANTHROPIC_API_KEY;
  let lines = (data.env.ANTHROPIC_CUSTOM_HEADERS || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.toLowerCase().startsWith('x-api-key:'));
  lines.push("x-api-key: $KEY");
  data.env.ANTHROPIC_CUSTOM_HEADERS = lines.join('\n');
} else {
  data.env.ANTHROPIC_API_KEY = "$KEY";
  let lines = (data.env.ANTHROPIC_CUSTOM_HEADERS || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.toLowerCase().startsWith('x-api-key:'));
  if (lines.length > 0) {
    data.env.ANTHROPIC_CUSTOM_HEADERS = lines.join('\n');
  } else {
    delete data.env.ANTHROPIC_CUSTOM_HEADERS;
  }
}
fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
EOF
  echo "Zaktualizowano konfigurację Claude Code dla Orca (zachowano hooki Orca): $CLAUDE_SETTINGS"
elif command -v python3 >/dev/null 2>&1; then
  python3 - << EOF
import os, json
p = "$CLAUDE_SETTINGS"
data = {}
if os.path.exists(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except: pass
if "env" not in data:
    data["env"] = {}
data["env"]["ANTHROPIC_BASE_URL"] = "$URL"

is_oauth = "$OAUTH_SESSION" == "1"
if is_oauth:
    data["env"].pop("ANTHROPIC_API_KEY", None)
    existing = data["env"].get("ANTHROPIC_CUSTOM_HEADERS") or ""
    lines = [l.strip() for l in existing.splitlines() if l.strip() and not l.lower().startswith("x-api-key:")]
    lines.append("x-api-key: $KEY")
    data["env"]["ANTHROPIC_CUSTOM_HEADERS"] = "\n".join(lines)
else:
    data["env"]["ANTHROPIC_API_KEY"] = "$KEY"
    existing = data["env"].get("ANTHROPIC_CUSTOM_HEADERS") or ""
    lines = [l.strip() for l in existing.splitlines() if l.strip() and not l.lower().startswith("x-api-key:")]
    if lines:
        data["env"]["ANTHROPIC_CUSTOM_HEADERS"] = "\n".join(lines)
    else:
        data["env"].pop("ANTHROPIC_CUSTOM_HEADERS", None)

with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
EOF
  echo "Zaktualizowano konfigurację Claude Code dla Orca (zachowano hooki Orca): $CLAUDE_SETTINGS"
fi

# 3. Konfiguracja OpenAI Codex CLI w Orca (~/.codex/config.json oraz ~/.codex/config.toml)
CODEX_DIR="$HOME/.codex"
mkdir -p "$CODEX_DIR"
CODEX_CONF="$CODEX_DIR/config.json"

if [ -f "$CODEX_CONF" ]; then
  backup_existing "$CODEX_CONF"
fi

if command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const p = "$CODEX_CONF";
let data = {};
if (fs.existsSync(p)) {
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
}
data.base_url = "$URL/backend-api/codex";
fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
EOF
  echo "Zaktualizowano konfigurację Codex CLI dla Orca: $CODEX_CONF"
elif command -v python3 >/dev/null 2>&1; then
  python3 - << EOF
import os, json
p = "$CODEX_CONF"
data = {}
if os.path.exists(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except: pass
data["base_url"] = "$URL/backend-api/codex"
with open(p, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
EOF
  echo "Zaktualizowano konfigurację Codex CLI dla Orca: $CODEX_CONF"
fi

CODEX_TOML="$CODEX_DIR/config.toml"
if [ ! -f "$CODEX_TOML" ] || ! grep -qF "model_providers.codex-lb" "$CODEX_TOML" 2>/dev/null; then
  backup_existing "$CODEX_TOML"
  cat >> "$CODEX_TOML" <<-EOF

# >>> codexlb >>> (zarządzane przez agent-lb)
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
  echo "Zaktualizowano profil Codex TOML: $CODEX_TOML"
fi

# 4. Konfiguracja OpenCode (opcjonalny agent w Orca)
OPENCODE_DIR="$HOME/.config/opencode"
mkdir -p "$OPENCODE_DIR"
OPENCODE_CONF="$OPENCODE_DIR/opencode.json"

if [ -f "$OPENCODE_CONF" ]; then
  backup_existing "$OPENCODE_CONF"
fi

if command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const p = "$OPENCODE_CONF";
let cfg = {};
if (fs.existsSync(p)) {
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
}
const models = {
  "claude-fable-5-1": { name: "Claude Fable 5.1", modelID: "claude-fable-5-1" },
  "claude-fable-5": { name: "Claude Fable 5", modelID: "claude-fable-5" },
  "claude-opus-5-5": { name: "Claude Opus 5.5", modelID: "claude-opus-5-5" },
  "claude-opus-5": { name: "Claude Opus 5", modelID: "claude-opus-5" },
  "claude-opus-4-8": { name: "Claude Opus 4.8", modelID: "claude-opus-4-8" },
  "claude-opus-4-7": { name: "Claude Opus 4.7", modelID: "claude-opus-4-7" },
  "claude-opus-4-6": { name: "Claude Opus 4.6", modelID: "claude-opus-4-6" },
  "claude-sonnet-5": { name: "Claude Sonnet 5", modelID: "claude-sonnet-5" },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", modelID: "claude-sonnet-4-6" },
  "claude-mythos-5-1": { name: "Claude Mythos 5.1", modelID: "claude-mythos-5-1" },
  "claude-mythos-5": { name: "Claude Mythos 5", modelID: "claude-mythos-5" },
  "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", modelID: "claude-haiku-4-5-20251001" },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", modelID: "claude-haiku-4-5-20251001" },
  "claude-opus-4-5": { name: "Claude Opus 4.5", modelID: "claude-opus-4-5-20251101" },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", modelID: "claude-sonnet-4-5-20250929" },
  "claude-3-7-sonnet": { name: "Claude 3.7 Sonnet", modelID: "claude-3-7-sonnet-20250219" },
  "claude-3-5-sonnet": { name: "Claude 3.5 Sonnet", modelID: "claude-3-5-sonnet-20241022" },
  "codex": { name: "OpenAI Codex (GPT-5.6 Sol)", modelID: "codex" },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol", modelID: "gpt-5.6-sol" },
  "gpt-6-astra": { name: "GPT-6 Astra", modelID: "gpt-6-astra" },
  "gpt-6-sol": { name: "GPT-6 Sol", modelID: "gpt-6-sol" },
  "gpt-6-luna": { name: "GPT-6 Luna", modelID: "gpt-6-luna" },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra", modelID: "gpt-5.6-terra" },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", modelID: "gpt-5.6-luna" },
  "gpt-5.3-codex": { name: "GPT-5.3-Codex", modelID: "gpt-5.3-codex" },
  "gpt-5.2-codex": { name: "GPT-5.2-Codex", modelID: "gpt-5.2-codex" },
  "codex-mini-latest": { name: "codex-mini-latest", modelID: "codex-mini-latest" },
  "gpt-5.5": { name: "GPT-5.5", modelID: "gpt-5.5" },
  "gpt-4.1": { name: "GPT-4.1", modelID: "gpt-4.1" },
  "gpt-4o": { name: "GPT-4o", modelID: "gpt-4o" },
  "o3-mini": { name: "o3-mini", modelID: "o3-mini" }
};
cfg.provider = cfg.provider || {};
cfg.provider.agentlb = {
  npm: "@ai-sdk/openai-compatible",
  name: "AgentLB (All Models)",
  options: {
    baseURL: "$URL/v1",
    apiKey: "$KEY"
  },
  models: models
};
cfg.providers = cfg.providers || {};
cfg.providers.agentlb = {
  npm: "@ai-sdk/openai-compatible",
  name: "AgentLB (All Models)",
  package: "@opencode/ai/providers/openai-compatible",
  settings: {
    baseURL: "$URL/v1"
  },
  apiKey: "$KEY",
  models: models
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
EOF
  echo "Zaktualizowano konfigurację OpenCode: $OPENCODE_CONF"
fi

# 5. Konfiguracja środowiska Orca (~/.config/orca)
ORCA_DIR="$HOME/.config/orca"
mkdir -p "$ORCA_DIR"
cp -p "$ENV_FILE" "$ORCA_DIR/agent-lb.env" 2>/dev/null || cp "$ENV_FILE" "$ORCA_DIR/agent-lb.env"
echo "Zapisano kopię profilu dla Orca ADE: $ORCA_DIR/agent-lb.env"

# 6. Integracja z powłoką dla terminali i PTY tworzonych w Orca
SRC_LINE=". \"$ENV_FILE\"  # agent-lb"
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    if ! grep -qF "agent-lb.env" "$rc" 2>/dev/null; then
      printf '\n%s\n' "$SRC_LINE" >> "$rc"
      echo "Dopisano wczytywanie do $rc"
    fi
  fi
done

echo ""
echo "================================================================="
echo "  ✅ AgentLB został pomyślnie skonfigurowany dla środowiska Orca!"
echo "================================================================="
echo "  • Proxy:       $URL"
echo "  • Profil ENV:  $ENV_FILE"
echo "  • Claude:      $CLAUDE_SETTINGS (hooki Orca zachowane)"
echo "  • Codex:       $CODEX_CONF"
echo "  • OpenCode:    $OPENCODE_CONF"
echo "  • Orca ADE:    $ORCA_DIR/agent-lb.env"
echo ""
echo "Wszystkie terminale, worktree i agenty uruchamiane wewnątrz Orca"
echo "będą automatycznie korzystać z modeli proxy AgentLB."
echo "Uruchomienie: orca"
echo "================================================================="
