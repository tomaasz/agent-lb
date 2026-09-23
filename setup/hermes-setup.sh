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
  echo "Wykryto wtyczkę AGY (agybridge) na hoście — dodaję natywne providery agy i agy-fast..."
else
  echo "Nie wykryto wtyczki AGY na hoście (providery agy nie zostaną dodane). Instalacja: curl -fsSL $URL/agy-setup.sh | bash"
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
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-mythos-5-1",
    "claude-haiku-4-5-20251001",
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

# AGY nie jest dopisywany do listy agentlb: agent-lb nie ma backendu AGY i po
# cichu odpowiadałby Claude/GPT. Prawdziwy AGY to natywne providery agy/agy-fast
# z wtyczki agybridge (poniżej) — instalacja: agy-setup.sh.

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
    context_length: 128000
    models:
{models_yaml}
providers:
  agentlb:
    name: "AgentLB (All Models)"
    base_url: "{url}"
    api: "{url}"
    api_key: "{key}"
    api_mode: "chat_completions"
    context_length: 128000
    models:
{models_yaml}{extra_providers}
# --- End AgentLB ---
auxiliary:
  title_generation:
    model_upgrade_enabled: false
"""

config_paths = ["$CONFIG_FILE"]
profiles_dir = os.path.join(os.path.dirname("$CONFIG_FILE"), "profiles")
if os.path.isdir(profiles_dir):
    for entry in os.listdir(profiles_dir):
        pdir = os.path.join(profiles_dir, entry)
        if os.path.isdir(pdir):
            config_paths.append(os.path.join(pdir, "config.yaml"))

for p in config_paths:
    content = ""
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception:
            content = ""
        content = re.sub(r"# --- AgentLB Multi-Provider ---[\s\S]*?(?:# --- End AgentLB ---|(?=\n[a-zA-Z0-9_]+:)|\Z)", "", content)
    # Apply token-safe optimizations
    content = re.sub(r"(max_turns:\s*)\d+", r"\g<1>25", content)
    content = re.sub(r"(threshold:\s*)[0-9.]+", r"\g<1>0.25", content)
    content = re.sub(r"(protect_last_n:\s*)\d+", r"\g<1>10", content)
    content = re.sub(r"(context_length:\s*)\d+", r"\g<1>128000", content)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content.strip() + "\n" + block + "\n")
    print(f"✓ Zaktualizowano konfigurację: {p}")
EOF
elif command -v node >/dev/null 2>&1; then
  node - << EOF
const fs = require('fs');
const path = require('path');
const configPaths = ["$CONFIG_FILE"];
const profilesDir = path.join(path.dirname("$CONFIG_FILE"), "profiles");
if (fs.existsSync(profilesDir)) {
  for (const entry of fs.readdirSync(profilesDir)) {
    const pdir = path.join(profilesDir, entry);
    if (fs.statSync(pdir).isDirectory()) {
      configPaths.push(path.join(pdir, "config.yaml"));
    }
  }
}
const url = "$URL/v1";
const key = "$KEY";
const hasAgy = "$HAS_AGY_PLUGIN" === "true";
const models = [
  "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8",
  "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6",
  "claude-mythos-5-1", "claude-haiku-4-5-20251001", "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229",
  "codex", "codex-mini", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra",
  "gpt-5.6-luna", "gpt-5.5", "o3-mini", "o1", "gpt-4o", "gpt-4o-mini"
];
const modelsYaml = models.map(m => '      - "' + m + '"\n').join('');

let modelAliasesBlock = '';
let extraProviders = '';
if (hasAgy) {
  modelAliasesBlock = '\nmodel_aliases:\n  agy:\n    model: "gemini-3.8-flash-high"\n    provider: "agy"\n  agy-fast:\n    model: "gemini-3.8-flash-low"\n    provider: "agy-fast"\n';
  extraProviders = '\n  agy:\n    name: "AGY"\n    provider: "agy"\n    models:\n      - "gemini-3.8-flash-high"\n      - "agy"\n  agy-fast:\n    name: "AGY Fast"\n    provider: "agy-fast"\n    models:\n      - "gemini-3.8-flash-low"\n      - "agy-fast"\n';
}

const block = '\n# --- AgentLB Multi-Provider ---' + modelAliasesBlock + '\ncustom_providers:\n  - name: "agentlb"\n    base_url: "' + url + '"\n    api_key: "' + key + '"\n    api_mode: "chat_completions"\n    context_length: 128000\n    models:\n' + modelsYaml + '\nproviders:\n  agentlb:\n    name: "AgentLB (All Models)"\n    base_url: "' + url + '"\n    api: "' + url + '"\n    api_key: "' + key + '"\n    api_mode: "chat_completions"\n    context_length: 128000\n    models:\n' + modelsYaml + extraProviders + '\n# --- End AgentLB ---\nauxiliary:\n  title_generation:\n    model_upgrade_enabled: false\n';

for (const p of configPaths) {
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  content = content.replace(/# --- AgentLB Multi-Provider ---[\s\S]*?(?:# --- End AgentLB ---|(?=\n[a-zA-Z0-9_]+:)|\$)/, '').trim();
  content = content.replace(/(max_turns:\s*)\d+/g, '$125');
  content = content.replace(/(threshold:\s*)[0-9.]+/g, '$10.25');
  content = content.replace(/(protect_last_n:\s*)\d+/g, '$110');
  content = content.replace(/(context_length:\s*)\d+/g, '$1128000');
  fs.writeFileSync(p, (content ? content + '\n' : '') + block);
  console.log('✓ Zaktualizowano konfigurację:', p);
}
EOF
fi

# Zapisz też klucz do ~/.hermes/.env oraz każdego profilu w ~/.hermes/profiles/*/.env
env_files=("$ENV_FILE")
if [ -d "$HERMES_DIR/profiles" ]; then
  for pdir in "$HERMES_DIR/profiles"/*; do
    if [ -d "$pdir" ]; then
      env_files+=("$pdir/.env")
    fi
  done
fi

for ef in "${env_files[@]}"; do
  touch "$ef"
  grep -v "^AGENT_LB_API_KEY=" "$ef" | grep -v "^AGENTLB_API_KEY=" > "$ef.tmp" 2>/dev/null || true
  echo "AGENT_LB_API_KEY=\"$KEY\"" >> "$ef.tmp"
  echo "OPENAI_BASE_URL=\"$URL/v1\"" >> "$ef.tmp"
  mv "$ef.tmp" "$ef"
  chmod 600 "$ef" 2>/dev/null || true
done

echo "Zaktualizowano konfigurację Hermes: $CONFIG_FILE"
echo "Gotowe!"
echo ""
echo "Jak uruchomić Hermes z AgentLB:"
echo "  1. W Hermes wpisz: /model i wybierz 'AgentLB (All Models)'"
echo "  2. Albo bezpośrednio z konsoli:"
echo "     hermes --provider agentlb --model codex"
echo "     hermes --provider agentlb --model claude-sonnet-5"
echo "     hermes --provider agentlb --model gpt-5.6-sol"
