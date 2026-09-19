#!/usr/bin/env bash
# hermes-setup.sh — Konfigurator providera AgentLB w Hermes Agent
#
# Dodaje providera 'agentlb' ze wszystkimi modelami Claude i Codex
# do ~/.hermes/config.yaml oraz ~/.hermes/.env.
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/hermes-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/hermes-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

set -eu

URL="${AGENT_LB_URL:-${AGENTLB_URL:-https://agentlb.gotova.pl}}"
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${OPENAI_API_KEY:-}}}"

HAS_AGY_PLUGIN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift ;;
    --key) KEY="$2"; shift ;;
    --with-agy|--agy) HAS_AGY_PLUGIN=true ;;
    -h|--help)
      echo "Użycie: $0 [--key KLUCZ] [--url URL] [--with-agy]"
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
  # Spróbuj z x-api-key
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$URL/v1/models" -H "x-api-key: $KEY" || echo "000")
fi

if [ "$HTTP_STATUS" = "200" ]; then
  echo "OK — połączenie z AgentLB nawiązane pomyślnie."
else
  echo "Ostrzeżenie: Proxy zwróciło status HTTP $HTTP_STATUS, kontynuuję konfigurację..."
fi

HERMES_DIR="$HOME/.hermes"
mkdir -p "$HERMES_DIR"

CONFIG_FILE="$HERMES_DIR/config.yaml"
ENV_FILE="$HERMES_DIR/.env"

TIMESTAMP=$(date +%s)
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak-$TIMESTAMP"
  echo "Utworzono kopię zapasową: $CONFIG_FILE.bak-$TIMESTAMP"
fi

# Sprawdź obecność wtyczki hermes-agy-plugin na hoście (jeśli nie wymuszono przez parametr)
if [ "$HAS_AGY_PLUGIN" = "false" ]; then
  if [ -d "$HERMES_DIR/plugins/model-providers/agy" ] || \
     [ -d "${HERMES_HOME:-$HOME/.hermes}/plugins/model-providers/agy" ] || \
     [ -d "$HERMES_DIR/plugins/agy" ] || \
     [ -f "$HERMES_DIR/plugins/model-providers/agy/plugin.yaml" ] || \
     [ -f "$HERMES_DIR/plugins/model-providers/agy/__init__.py" ] || \
     [ -d "$HOME/hermes-agy-plugin" ] || \
     [ -d "$HOME/.hermes-agy-plugin" ]; then
    HAS_AGY_PLUGIN=true
  elif [ -d "$HERMES_DIR/plugins" ] && find "$HERMES_DIR/plugins" -maxdepth 4 \( -name "*agy*" -o -name "plugin.yaml" \) 2>/dev/null | grep -q "agy"; then
    HAS_AGY_PLUGIN=true
  elif command -v python3 >/dev/null 2>&1 && python3 -c "import sys; from importlib.util import find_spec; sys.exit(0 if (find_spec('agy') or find_spec('hermes_agy_plugin')) else 1)" 2>/dev/null; then
    HAS_AGY_PLUGIN=true
  fi
fi

if [ "$HAS_AGY_PLUGIN" = "true" ]; then
  echo "Wykryto wtyczkę hermes-agy-plugin na hoście — dodaję modele agy i agy-fast do listy AgentLB (All Models)..."
else
  echo "Nie wykryto wtyczki hermes-agy-plugin na hoście (modele agy nie zostaną dodane; użyj --with-agy aby wymusić)."
fi

# Zapis/aktualizacja konfiguracji przez Python lub Node.js lub fallback
if command -v python3 >/dev/null 2>&1; then
  python3 - << EOF
import os, re

config_path = "$CONFIG_FILE"
url = "$URL/v1"
key = "$KEY"
has_agy = "$HAS_AGY_PLUGIN" == "true"

models = [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-6",
    "claude-opus-5",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "codex",
    "codex-mini",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "o3-mini",
    "o1",
    "gpt-4o",
    "gpt-4o-mini"
]

if has_agy:
    models.extend(["agy", "agy-fast"])

models_yaml = "".join(f"      - \"{m}\"\n" for m in models)

extra_providers = ""
model_aliases_block = ""
if has_agy:
    model_aliases_block = """
model_aliases:
  agy:
    model: "gemini-3.8-flash-high"
    provider: "agy"
  agy-fast:
    model: "gemini-3.8-flash-low"
    provider: "agy-fast"
"""
    extra_providers = """
  agy:
    name: "AGY"
    provider: "agy"
    models:
      - "gemini-3.8-flash-high"
      - "agy"
  agy-fast:
    name: "AGY Fast"
    provider: "agy-fast"
    models:
      - "gemini-3.8-flash-low"
      - "agy-fast"
"""

block = f"""
# --- AgentLB Multi-Provider ---{model_aliases_block}
custom_providers:
  - name: "agentlb"
    base_url: "{url}"
    api_key: "{key}"
    api_mode: "chat_completions"
    models:
{models_yaml}
providers:
  agentlb:
    name: "AgentLB (All Models)"
    base_url: "{url}"
    api: "{url}"
    api_key: "{key}"
    api_mode: "chat_completions"
    models:
{models_yaml}{extra_providers}
# --- End AgentLB ---"""

content = ""
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        content = f.read()
    content = re.sub(r"# --- AgentLB Multi-Provider ---[\s\S]*?(?:# --- End AgentLB ---|(?=\n[a-zA-Z0-9_]+:)|\Z)", "", content)

with open(config_path, "w", encoding="utf-8") as f:
    f.write(content.strip() + "\n" + block + "\n")
EOF
elif command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const configPath = "$CONFIG_FILE";
const url = "$URL/v1";
const key = "$KEY";
const hasAgy = "$HAS_AGY_PLUGIN" === "true";
const models = [
  "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
  "claude-opus-4-6", "claude-opus-5", "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229",
  "codex", "codex-mini", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra",
  "gpt-5.6-luna", "gpt-5.5", "o3-mini", "o1", "gpt-4o", "gpt-4o-mini"
];
if (hasAgy) models.push('agy', 'agy-fast');
const modelsYaml = models.map(m => '      - "' + m + '"\n').join('');

let modelAliasesBlock = '';
let extraProviders = '';
if (hasAgy) {
  modelAliasesBlock = '\nmodel_aliases:\n  agy:\n    model: "gemini-3.8-flash-high"\n    provider: "agy"\n  agy-fast:\n    model: "gemini-3.8-flash-low"\n    provider: "agy-fast"\n';
  extraProviders = '\n  agy:\n    name: "AGY"\n    provider: "agy"\n    models:\n      - "gemini-3.8-flash-high"\n      - "agy"\n  agy-fast:\n    name: "AGY Fast"\n    provider: "agy-fast"\n    models:\n      - "gemini-3.8-flash-low"\n      - "agy-fast"\n';
}

const block = '\n# --- AgentLB Multi-Provider ---' + modelAliasesBlock + '\ncustom_providers:\n  - name: "agentlb"\n    base_url: "' + url + '"\n    api_key: "' + key + '"\n    api_mode: "chat_completions"\n    models:\n' + modelsYaml + '\nproviders:\n  agentlb:\n    name: "AgentLB (All Models)"\n    base_url: "' + url + '"\n    api: "' + url + '"\n    api_key: "' + key + '"\n    api_mode: "chat_completions"\n    models:\n' + modelsYaml + extraProviders + '\n# --- End AgentLB ---\n';
let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
content = content.replace(/# --- AgentLB Multi-Provider ---[\s\S]*?(?:# --- End AgentLB ---|(?=\n[a-zA-Z0-9_]+:)|\$)/, '').trim();
fs.writeFileSync(configPath, (content ? content + '\n' : '') + block);
EOF
fi

# Zapisz też klucz do ~/.hermes/.env
touch "$ENV_FILE"
grep -v "^AGENT_LB_API_KEY=" "$ENV_FILE" | grep -v "^AGENTLB_API_KEY=" > "$ENV_FILE.tmp" 2>/dev/null || true
echo "AGENT_LB_API_KEY=\"$KEY\"" >> "$ENV_FILE.tmp"
echo "OPENAI_BASE_URL=\"$URL/v1\"" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

echo "Zaktualizowano konfigurację Hermes: $CONFIG_FILE"
echo "Gotowe!"
echo ""
echo "Jak uruchomić Hermes z AgentLB:"
echo "  1. W Hermes wpisz: /model i wybierz 'AgentLB (All Models)'"
echo "  2. Albo bezpośrednio z konsoli:"
echo "     hermes --provider agentlb --model codex"
echo "     hermes --provider agentlb --model claude-sonnet-5"
echo "     hermes --provider agentlb --model gpt-5.6-sol"
