#!/usr/bin/env bash
# claw-setup.sh — Konfigurator providera AgentLB w Claw / OpenClaw
#
# Dodaje providera 'agentlb' do ~/.openclaw/openclaw.json
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/claw-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/claw-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

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

CLAW_DIR="$HOME/.openclaw"
mkdir -p "$CLAW_DIR"
CONFIG_FILE="$CLAW_DIR/openclaw.json"

TIMESTAMP=$(date +%s)
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak-$TIMESTAMP"
  chmod 600 "$CONFIG_FILE.bak-$TIMESTAMP"
  echo "Utworzono kopię zapasową: $CONFIG_FILE.bak-$TIMESTAMP"
fi

if command -v node >/dev/null 2>&1; then
  AGENTLB_SETUP_CONFIG_FILE="$CONFIG_FILE" AGENTLB_SETUP_URL="$URL" AGENTLB_SETUP_KEY="$KEY" node - << 'EOF'
const fs = require('fs');
const path = process.env.AGENTLB_SETUP_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) {
  cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Configuration must be a JSON object');
}
cfg.models = cfg.models || {};
cfg.models.providers = cfg.models.providers || {};
cfg.models.providers.agentlb = {
  baseUrl: process.env.AGENTLB_SETUP_URL + "/v1",
  api: "openai-completions",
  apiKey: process.env.AGENTLB_SETUP_KEY
};
if (fs.existsSync(path)) fs.chmodSync(path, 0o600);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
EOF
elif command -v python3 >/dev/null 2>&1; then
  AGENTLB_SETUP_CONFIG_FILE="$CONFIG_FILE" AGENTLB_SETUP_URL="$URL" AGENTLB_SETUP_KEY="$KEY" python3 - << 'EOF'
import os, json
path = os.environ["AGENTLB_SETUP_CONFIG_FILE"]
cfg = {}
if os.path.exists(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("Configuration must be a JSON object")
if "models" not in cfg:
    cfg["models"] = {}
if "providers" not in cfg["models"]:
    cfg["models"]["providers"] = {}
cfg["models"]["providers"]["agentlb"] = {
    "baseUrl": os.environ["AGENTLB_SETUP_URL"] + "/v1",
    "api": "openai-completions",
    "apiKey": os.environ["AGENTLB_SETUP_KEY"]
}
if os.path.exists(path):
    os.chmod(path, 0o600)
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
EOF
fi

echo "Zaktualizowano konfigurację OpenClaw: $CONFIG_FILE"
echo "Gotowe! Uruchom: openclaw"
