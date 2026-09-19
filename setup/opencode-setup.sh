#!/usr/bin/env bash
# opencode-setup.sh — Konfigurator providera AgentLB w OpenCode
#
# Dodaje providera 'agentlb' do ~/.config/opencode/opencode.json
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/opencode-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/opencode-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

set -eu

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

TIMESTAMP=$(date +%s)
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak-$TIMESTAMP"
  echo "Utworzono kopię zapasową: $CONFIG_FILE.bak-$TIMESTAMP"
fi

# Aktualizacja pliku JSON przez Node.js lub Python
if command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const path = "$CONFIG_FILE";
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {}
}
cfg.providers = cfg.providers || {};
cfg.providers.agentlb = {
  name: "AgentLB (All Models)",
  package: "@opencode/ai/providers/openai-compatible",
  settings: {
    baseURL: "$URL/v1"
  },
  apiKey: "$KEY",
  models: {
    "claude-sonnet-5": { name: "Claude Sonnet 5", modelID: "claude-sonnet-5" },
    "claude-opus-5": { name: "Claude Opus 5", modelID: "claude-opus-5" },
    "claude-3-7-sonnet": { name: "Claude 3.7 Sonnet", modelID: "claude-3-7-sonnet-20250219" },
    "claude-3-5-sonnet": { name: "Claude 3.5 Sonnet", modelID: "claude-3-5-sonnet-20241022" },
    "codex": { name: "OpenAI Codex (GPT-5.6 Sol)", modelID: "codex" },
    "gpt-5.6-sol": { name: "GPT-5.6 Sol", modelID: "gpt-5.6-sol" },
    "gpt-6-astra": { name: "GPT-6 Astra", modelID: "gpt-6-astra" },
    "gpt-4o": { name: "GPT-4o", modelID: "gpt-4o" },
    "o3-mini": { name: "o3-mini", modelID: "o3-mini" }
  }
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
EOF
elif command -v python3 >/dev/null 2>&1; then
  python3 - << EOF
import os, json
path = "$CONFIG_FILE"
cfg = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except: pass
if "providers" not in cfg:
    cfg["providers"] = {}
cfg["providers"]["agentlb"] = {
    "name": "AgentLB (All Models)",
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {
        "baseURL": "$URL/v1"
    },
    "apiKey": "$KEY",
    "models": {
        "claude-sonnet-5": { "name": "Claude Sonnet 5", "modelID": "claude-sonnet-5" },
        "claude-opus-5": { "name": "Claude Opus 5", "modelID": "claude-opus-5" },
        "claude-3-7-sonnet": { "name": "Claude 3.7 Sonnet", "modelID": "claude-3-7-sonnet-20250219" },
        "claude-3-5-sonnet": { "name": "Claude 3.5 Sonnet", "modelID": "claude-3-5-sonnet-20241022" },
        "codex": { "name": "OpenAI Codex (GPT-5.6 Sol)", "modelID": "codex" },
        "gpt-5.6-sol": { "name": "GPT-5.6 Sol", "modelID": "gpt-5.6-sol" },
        "gpt-6-astra": { "name": "GPT-6 Astra", "modelID": "gpt-6-astra" },
        "gpt-4o": { "name": "GPT-4o", "modelID": "gpt-4o" },
        "o3-mini": { "name": "o3-mini", "modelID": "o3-mini" }
    }
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
EOF
fi

echo "Zaktualizowano konfigurację OpenCode: $CONFIG_FILE"
echo "Gotowe! Uruchom: opencode lub opencode models"
