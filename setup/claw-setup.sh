#!/usr/bin/env bash
# claw-setup.sh — Konfigurator providera AgentLB w Claw / OpenClaw
#
# Dodaje providera 'agentlb' do ~/.openclaw/openclaw.json
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/claw-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/claw-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

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

CLAW_DIR="$HOME/.openclaw"
mkdir -p "$CLAW_DIR"
CONFIG_FILE="$CLAW_DIR/openclaw.json"

TIMESTAMP=$(date +%s)
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak-$TIMESTAMP"
  echo "Utworzono kopię zapasową: $CONFIG_FILE.bak-$TIMESTAMP"
fi

if command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const path = "$CONFIG_FILE";
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {}
}
cfg.models = cfg.models || {};
cfg.models.providers = cfg.models.providers || {};
cfg.models.providers.agentlb = {
  baseUrl: "$URL/v1",
  api: "openai-completions",
  apiKey: "$KEY"
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
if "models" not in cfg:
    cfg["models"] = {}
if "providers" not in cfg["models"]:
    cfg["models"]["providers"] = {}
cfg["models"]["providers"]["agentlb"] = {
    "baseUrl": "$URL/v1",
    "api": "openai-completions",
    "apiKey": "$KEY"
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
EOF
fi

echo "Zaktualizowano konfigurację OpenClaw: $CONFIG_FILE"
echo "Gotowe! Uruchom: openclaw"
