#!/usr/bin/env bash
# opencode-setup.sh — Konfigurator providera AgentLB w OpenCode
#
# Dodaje providera 'agentlb' do ~/.config/opencode/opencode.json
# oraz kopiuje go do kontenerów Docker (jeśli działają).
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/opencode-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/opencode-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

set -eu

# Configuration files and backups contain API keys.
umask 077

URL="${AGENT_LB_URL:-${AGENTLB_URL:-https://agentlb.gotova.pl}}"
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${OPENAI_API_KEY:-}}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift ;;
    --key) KEY="$2"; shift ;;
    -h|--help)
      echo "Użycie: $0 [--key KLUCZ] [--url URL]"
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

OPENCODE_DIR="$HOME/.config/opencode"
mkdir -p "$OPENCODE_DIR"
CONFIG_FILE="$OPENCODE_DIR/opencode.json"

AUTH_DIR="$HOME/.local/share/opencode"
mkdir -p "$AUTH_DIR"
AUTH_FILE="$AUTH_DIR/auth.json"

TIMESTAMP=$(date +%s)
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak-$TIMESTAMP"
  chmod 600 "$CONFIG_FILE.bak-$TIMESTAMP"
  echo "Utworzono kopię zapasową: $CONFIG_FILE.bak-$TIMESTAMP"
fi

# Aktualizacja pliku JSON przez Node.js lub Python
if command -v node >/dev/null 2>&1; then
  AGENTLB_SETUP_CONFIG_FILE="$CONFIG_FILE" AGENTLB_SETUP_URL="$URL" AGENTLB_SETUP_KEY="$KEY" AGENTLB_SETUP_AUTH_FILE="$AUTH_FILE" node - << 'EOF'
const fs = require('fs');
const path = process.env.AGENTLB_SETUP_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) {
  cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Configuration must be a JSON object');
}

// Validate both documents before writing either one.
const authPath = process.env.AGENTLB_SETUP_AUTH_FILE;
let auth = {};
if (fs.existsSync(authPath)) auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Auth must be a JSON object');
auth.agentlb = { type: "api", key: process.env.AGENTLB_SETUP_KEY };

const models = {
  "claude-fable-5-1": { name: "Claude Fable 5.1" },
  "claude-fable-5": { name: "Claude Fable 5" },
  "claude-opus-5-5": { name: "Claude Opus 5.5" },
  "claude-opus-5": { name: "Claude Opus 5" },
  "claude-opus-4-8": { name: "Claude Opus 4.8" },
  "claude-opus-4-7": { name: "Claude Opus 4.7" },
  "claude-opus-4-6": { name: "Claude Opus 4.6" },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5" },
  "claude-sonnet-5": { name: "Claude Sonnet 5" },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
  "claude-mythos-5-1": { name: "Claude Mythos 5.1" },
  "claude-mythos-5": { name: "Claude Mythos 5" },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5" },
  "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5" },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5" },
  "claude-opus-4-5": { name: "Claude Opus 4.5" },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" },
  "codex": { name: "OpenAI Codex (GPT-5.6 Sol)" },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol" },
  "gpt-6-astra": { name: "GPT-6 Astra" },
  "gpt-6-sol": { name: "GPT-6 Sol" },
  "gpt-6-luna": { name: "GPT-6 Luna" },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra" },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna" },
  "gpt-5.3-codex": { name: "GPT-5.3-Codex" },
  "gpt-5.2-codex": { name: "GPT-5.2-Codex" },
  "codex-mini-latest": { name: "codex-mini-latest" },
  "gpt-5.5": { name: "GPT-5.5" },
  "gpt-4.1": { name: "GPT-4.1" },
  "gpt-4o": { name: "GPT-4o" },
  "o3-mini": { name: "o3-mini" }
};

// OpenCode official standard schema: "provider"
cfg.provider = cfg.provider || {};
cfg.provider.agentlb = {
  npm: "@ai-sdk/openai-compatible",
  name: "AgentLB (All Models)",
  options: {
    baseURL: process.env.AGENTLB_SETUP_URL + "/v1",
    apiKey: process.env.AGENTLB_SETUP_KEY
  },
  models: models
};

// Backward compatibility alias for "providers"
cfg.providers = cfg.providers || {};
cfg.providers.agentlb = {
  npm: "@ai-sdk/openai-compatible",
  name: "AgentLB (All Models)",
  package: "@opencode/ai/providers/openai-compatible",
  settings: {
    baseURL: process.env.AGENTLB_SETUP_URL + "/v1"
  },
  options: {
    baseURL: process.env.AGENTLB_SETUP_URL + "/v1",
    apiKey: process.env.AGENTLB_SETUP_KEY
  },
  apiKey: process.env.AGENTLB_SETUP_KEY,
  models: models
};

if (fs.existsSync(path)) fs.chmodSync(path, 0o600);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

// Update auth.json; failures must stop setup instead of reporting success.
if (fs.existsSync(authPath)) fs.chmodSync(authPath, 0o600);
fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
EOF
elif command -v python3 >/dev/null 2>&1; then
  AGENTLB_SETUP_CONFIG_FILE="$CONFIG_FILE" AGENTLB_SETUP_URL="$URL" AGENTLB_SETUP_KEY="$KEY" AGENTLB_SETUP_AUTH_FILE="$AUTH_FILE" python3 - << 'EOF'
import os, json
path = os.environ["AGENTLB_SETUP_CONFIG_FILE"]
cfg = {}
if os.path.exists(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("Configuration must be a JSON object")

# Validate both documents before writing either one.
auth_path = os.environ["AGENTLB_SETUP_AUTH_FILE"]
auth = {}
if os.path.exists(auth_path):
    with open(auth_path, "r", encoding="utf-8") as f:
        auth = json.load(f)
if not isinstance(auth, dict):
    raise ValueError("Auth must be a JSON object")
auth["agentlb"] = { "type": "api", "key": os.environ["AGENTLB_SETUP_KEY"] }

models = {
    "claude-fable-5-1": { "name": "Claude Fable 5.1" },
    "claude-fable-5": { "name": "Claude Fable 5" },
    "claude-opus-5-5": { "name": "Claude Opus 5.5" },
    "claude-opus-5": { "name": "Claude Opus 5" },
    "claude-opus-4-8": { "name": "Claude Opus 4.8" },
    "claude-opus-4-7": { "name": "Claude Opus 4.7" },
    "claude-opus-4-6": { "name": "Claude Opus 4.6" },
    "claude-sonnet-5-5": { "name": "Claude Sonnet 5.5" },
    "claude-sonnet-5": { "name": "Claude Sonnet 5" },
    "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" },
    "claude-mythos-5-1": { "name": "Claude Mythos 5.1" },
    "claude-mythos-5": { "name": "Claude Mythos 5" },
    "claude-haiku-5-5": { "name": "Claude Haiku 5.5" },
    "claude-haiku-4-5-20251001": { "name": "Claude Haiku 4.5" },
    "claude-haiku-4-5": { "name": "Claude Haiku 4.5" },
    "claude-opus-4-5": { "name": "Claude Opus 4.5" },
    "claude-sonnet-4-5": { "name": "Claude Sonnet 4.5" },
    "codex": { "name": "OpenAI Codex (GPT-5.6 Sol)" },
    "gpt-5.6-sol": { "name": "GPT-5.6 Sol" },
    "gpt-6-astra": { "name": "GPT-6 Astra" },
    "gpt-6-sol": { "name": "GPT-6 Sol" },
    "gpt-6-luna": { "name": "GPT-6 Luna" },
    "gpt-5.6-terra": { "name": "GPT-5.6 Terra" },
    "gpt-5.6-luna": { "name": "GPT-5.6 Luna" },
    "gpt-5.3-codex": { "name": "GPT-5.3-Codex" },
    "gpt-5.2-codex": { "name": "GPT-5.2-Codex" },
    "codex-mini-latest": { "name": "codex-mini-latest" },
    "gpt-5.5": { "name": "GPT-5.5" },
    "gpt-4.1": { "name": "GPT-4.1" },
    "gpt-4o": { "name": "GPT-4o" },
    "o3-mini": { "name": "o3-mini" }
}

if "provider" not in cfg:
    cfg["provider"] = {}
cfg["provider"]["agentlb"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "AgentLB (All Models)",
    "options": {
        "baseURL": os.environ["AGENTLB_SETUP_URL"] + "/v1",
        "apiKey": os.environ["AGENTLB_SETUP_KEY"]
    },
    "models": models
}

if "providers" not in cfg:
    cfg["providers"] = {}
cfg["providers"]["agentlb"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "AgentLB (All Models)",
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {
        "baseURL": os.environ["AGENTLB_SETUP_URL"] + "/v1"
    },
    "options": {
        "baseURL": os.environ["AGENTLB_SETUP_URL"] + "/v1",
        "apiKey": os.environ["AGENTLB_SETUP_KEY"]
    },
    "apiKey": os.environ["AGENTLB_SETUP_KEY"],
    "models": models
}

if os.path.exists(path):
    os.chmod(path, 0o600)
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

if os.path.exists(auth_path):
    os.chmod(auth_path, 0o600)
with os.fdopen(os.open(auth_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
    json.dump(auth, f, indent=2)
    f.write("\n")
EOF
fi

echo "✓ Zaktualizowano konfigurację OpenCode: $CONFIG_FILE"

# Jeśli OpenCode działa w Dockerze, skopiuj plik do kontenera
if command -v docker >/dev/null 2>&1; then
  CONTAINERS=$(docker ps -q --filter "name=opencode" 2>/dev/null || true)
  if [ -z "$CONTAINERS" ]; then
    CONTAINERS=$(docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | grep -i 'opencode' | awk '{print $1}' || true)
  fi
  if [ -n "$CONTAINERS" ]; then
    for CID in $CONTAINERS; do
      echo "Wykryto kontener Docker OpenCode ($CID) — kopiuję konfigurację..."
      docker exec "$CID" mkdir -p /root/.config/opencode /home/opencode/.config/opencode /root/.local/share/opencode /home/opencode/.local/share/opencode 2>/dev/null || true
      docker cp "$CONFIG_FILE" "$CID:/root/.config/opencode/opencode.json" 2>/dev/null || true
      docker cp "$CONFIG_FILE" "$CID:/home/opencode/.config/opencode/opencode.json" 2>/dev/null || true
      if [ -f "$AUTH_FILE" ]; then
        docker cp "$AUTH_FILE" "$CID:/root/.local/share/opencode/auth.json" 2>/dev/null || true
        docker cp "$AUTH_FILE" "$CID:/home/opencode/.local/share/opencode/auth.json" 2>/dev/null || true
      fi
      echo "✓ Skopiowano konfigurację do kontenera $CID."
      echo "Wskazówka: Zrestartuj kontener OpenCode (docker restart $CID) jeśli interfejs nie odświeżył listy."
    done
  fi
fi

echo ""
echo "Gotowe!"
echo "W OpenCode Web UI:"
echo "1. Jeśli lista dostawców nie odświeżyła się automatycznie, w oknie 'Połącz dostawcę' kliknij:"
echo "   -> 'Niestandardowy dostawca zgodny z OpenAI' (sekcja Inne)"
echo "   i podaj:"
echo "     Base URL: $URL/v1"
echo "     Klucz API: zapisany w konfiguracji (wartość ukryta)"
echo "2. W terminalu / CLI możesz sprawdzić: opencode models"
