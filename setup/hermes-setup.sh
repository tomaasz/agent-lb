#!/usr/bin/env bash
# hermes-setup.sh — Konfigurator providera AgentLB w Hermes Agent
#
# Dodaje providera 'agentlb' ze wszystkimi modelami Claude i Codex
# do ~/.hermes/config.yaml (i profili) oraz ~/.hermes/.env. Idempotentny:
# scala klucze zamiast doklejać, klucz trzyma tylko w .env.
#
# Użycie:
#   curl -fsSL https://agentlb.gotova.pl/hermes-setup.sh | bash -s -- --key <KLUCZ_STACJI>
#   ./setup/hermes-setup.sh --key <KLUCZ_STACJI> [--url https://agentlb.gotova.pl]

set -eu

URL="${AGENT_LB_URL:-${AGENTLB_URL:-https://agentlb.gotova.pl}}"
KEY="${AGENT_LB_API_KEY:-${AGENTLB_API_KEY:-${OPENAI_API_KEY:-}}}"

TOKEN_SAFE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift ;;
    --key) KEY="$2"; shift ;;
    --with-agy|--agy) ;;  # zachowane dla zgodności: Gemini idzie teraz przez providera agentlb
    --token-safe) TOKEN_SAFE=true ;;
    -h|--help)
      echo "Użycie: $0 [--key KLUCZ] [--url URL] [--token-safe]"
      echo "  --token-safe  ustaw agent.max_turns=25, compression.threshold=0.25, protect_last_n=10"
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

# Modele Gemini (AGY) serwuje sam agent-lb — pobieramy ich id z /v1/models.
# Odpowiedź zapisujemy w pliku: pełny katalog ma około 300 KB, więc nie mieści
# się bezpiecznie w pojedynczej zmiennej środowiskowej (Linux ogranicza ją do
# około 128 KB). Limit 2 MB odcina odpowiedź niepodobną do katalogu modeli.
REMOTE_MODELS_FILE=$(mktemp "${TMPDIR:-/tmp}/agentlb-models.XXXXXX")
cleanup_remote_models() { rm -f "$REMOTE_MODELS_FILE"; }
trap cleanup_remote_models EXIT HUP INT TERM
REMOTE_MODELS_OK=1
curl -s -f --max-filesize 2097152 -m 10 "$URL/v1/models" -H "Authorization: Bearer $KEY" -o "$REMOTE_MODELS_FILE" 2>/dev/null || REMOTE_MODELS_OK=0
if [ "$REMOTE_MODELS_OK" != "1" ] || [ ! -s "$REMOTE_MODELS_FILE" ]; then
  REMOTE_MODELS_OK=0
  : > "$REMOTE_MODELS_FILE"
  echo "Ostrzeżenie: nie udało się pobrać listy modeli z $URL/v1/models — zachowuję dotychczasowe modele Gemini z konfiguracji." >&2
fi

HERMES_DIR="$HOME/.hermes"
mkdir -p "$HERMES_DIR"

CONFIG_FILE="$HERMES_DIR/config.yaml"
ENV_FILE="$HERMES_DIR/.env"

TIMESTAMP=$(date +%s)  # kopie zapasowe: <plik>.bak-$TIMESTAMP przy każdym zmienianym config.yaml

# Scalanie konfiguracji: ruamel.yaml z venva Hermesa (zachowuje komentarze,
# odmawia zapisu pliku z duplikatami kluczy). Dawniej blok był doklejany na
# koniec pliku, co przy każdym uruchomieniu dublowało model_aliases,
# custom_providers, providers i auxiliary, a globalne regexy nadpisywały każde
# context_length/threshold/max_turns — także 1048576 dla agy.
find_yaml_python() {
  local c
  for c in "${HERMES_SETUP_PYTHON:-}" "$HERMES_DIR/hermes-agent/venv/bin/python" \
           "$HERMES_DIR"/installs/*/environments/*/venv/bin/python python3; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c 'import ruamel.yaml' >/dev/null 2>&1 && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

if ! YAML_PYTHON="$(find_yaml_python)"; then
  echo "BŁĄD: nie znaleziono Pythona z ruamel.yaml (instaluje go Hermes)." >&2
  echo "Zainstaluj najpierw Hermes Agent albo wskaż interpreter: HERMES_SETUP_PYTHON=/ścieżka/python $0 ..." >&2
  exit 1
fi

config_paths=("$CONFIG_FILE")
if [ -d "$HERMES_DIR/profiles" ]; then
  for pdir in "$HERMES_DIR/profiles"/*; do
    [ -f "$pdir/config.yaml" ] && config_paths+=("$pdir/config.yaml")
  done
fi

# Wartości przekazujemy przez zmienne środowiskowe, nie przez wklejanie w kod.
# Klucz nie trafia do config.yaml — tylko referencja ${AGENT_LB_API_KEY}.
merge_status=0
AGENTLB_BASE_URL="$URL/v1" REMOTE_MODELS_FILE="$REMOTE_MODELS_FILE" REMOTE_MODELS_OK="$REMOTE_MODELS_OK" TOKEN_SAFE="$TOKEN_SAFE" BACKUP_SUFFIX="bak-$TIMESTAMP" \
  "$YAML_PYTHON" - "${config_paths[@]}" <<'PY' || merge_status=$?
import json
import os
import re
import shutil
import sys

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

MODELS = [
    "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5",
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5-5", "claude-sonnet-5",
    "claude-sonnet-4-6", "claude-mythos-5-1", "claude-mythos-5",
    "claude-haiku-5-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929", "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229",
    "codex", "codex-mini", "codex-mini-latest", "gpt-6-astra", "gpt-6-sol",
    "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-cyber",
    "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex",
    "gpt-5-codex", "gpt-5.5", "gpt-5.4", "gpt-4.1", "o3-mini", "o1", "gpt-4o",
    "gpt-4o-mini",
]
# Modele Gemini (AGY) obsługuje sam agent-lb (pula kont Google + agybridge na
# serwerze), więc trafiają na listę providera agentlb — ich id przychodzą z
# /v1/models. Natywne providery agy/agy-fast z wtyczki Hermesa nie są już
# dopisywane nowym instalacjom; istniejące wpisy w config.yaml zostają nietknięte.
GEMINI_ID = re.compile(r"^gemini-[A-Za-z0-9._-]{1,100}$")
MAX_GEMINI = 100


def gemini_models():
    """Lista id z /v1/models albo None, gdy pobranie się nie udało (odpowiedź pusta/uszkodzona)."""
    if os.environ.get("REMOTE_MODELS_OK") != "1":
        return None
    try:
        with open(os.environ["REMOTE_MODELS_FILE"], encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        print("Ostrzeżenie: nie udało się odczytać listy modeli z odpowiedzi HTTP 200 — "
              "zachowuję dotychczasowe modele Gemini z konfiguracji.", file=sys.stderr)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        print("Ostrzeżenie: nie udało się odczytać listy modeli z odpowiedzi HTTP 200 — "
              "zachowuję dotychczasowe modele Gemini z konfiguracji.", file=sys.stderr)
        return None
    ids = []
    for item in data["data"]:
        mid = item.get("id") if isinstance(item, dict) else None
        if isinstance(mid, str) and GEMINI_ID.fullmatch(mid) and mid not in ids:
            ids.append(mid)
    return ids[:MAX_GEMINI]


REMOTE_GEMINI = gemini_models()


def models_for(*existing):
    """Statyczne modele + Gemini: z serwera, a przy błędzie pobrania te już zapisane w configu."""
    if REMOTE_GEMINI is not None:
        gem = REMOTE_GEMINI
    else:
        gem = []
        for seq in existing:
            for m in seq if isinstance(seq, list) else []:
                if isinstance(m, str) and GEMINI_ID.fullmatch(m) and m not in gem:
                    gem.append(m)
        gem = gem[:MAX_GEMINI]
    return MODELS + [m for m in gem if m not in MODELS]


KEY_REF = "${AGENT_LB_API_KEY}"
# Blok doklejany przez starsze wersje tego skryptu (wraz z auxiliary za znacznikiem końca).
LEGACY = re.compile(
    r"\n*# --- AgentLB Multi-Provider ---[\s\S]*?# --- End AgentLB ---\n"
    r"(?:auxiliary:\n  title_generation:\n    model_upgrade_enabled: false\n)?"
)

url = os.environ["AGENTLB_BASE_URL"]
token_safe = os.environ.get("TOKEN_SAFE") == "true"
suffix = os.environ["BACKUP_SUFFIX"]

yaml = YAML()
yaml.preserve_quotes = True
yaml.width = 4096
yaml.indent(mapping=2, sequence=4, offset=2)


def section(parent, key):
    if not isinstance(parent.get(key), dict):
        parent[key] = CommentedMap()
    return parent[key]


def agentlb_fields(extra, models):
    fields = {"base_url": url, **extra, "api_key": KEY_REF, "api_mode": "chat_completions",
              "context_length": 128000, "models": CommentedSeq(models)}
    return fields


def merge(cfg):
    providers = section(cfg, "providers")
    prov = section(providers, "agentlb")
    custom = cfg.get("custom_providers")
    if not isinstance(custom, list):
        custom = cfg["custom_providers"] = CommentedSeq()
    entry = next((c for c in custom if isinstance(c, dict) and c.get("name") == "agentlb"), None)
    # Przy błędzie pobrania /v1/models zachowujemy Gemini z obu istniejących list.
    models = models_for(prov.get("models"), entry.get("models") if entry is not None else None)
    prov.update(agentlb_fields({"name": "AgentLB (All Models)", "api": url}, models))
    if entry is None:
        entry = CommentedMap(name="agentlb")
        custom.append(entry)
    entry.update(agentlb_fields({}, models))

    section(section(cfg, "auxiliary"), "title_generation")["model_upgrade_enabled"] = False

    if token_safe:
        section(cfg, "agent")["max_turns"] = 25
        compression = section(cfg, "compression")
        compression["threshold"] = 0.25
        compression["protect_last_n"] = 10


failed = 0
for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    cleaned = LEGACY.sub("\n", text)
    try:
        cfg = yaml.load(cleaned) or CommentedMap()
    except Exception as exc:  # np. zduplikowane klucze — nie pogarszamy uszkodzonego pliku
        lines = str(exc).strip().splitlines()
        first = next((l for l in lines if "duplicate key" in l), lines[0]).strip()
        print(f"✗ Pomijam {path}: plik YAML jest uszkodzony ({first}). Napraw go i uruchom ponownie.",
              file=sys.stderr)
        failed += 1
        continue
    if not isinstance(cfg, dict):
        print(f"✗ Pomijam {path}: oczekiwano mapy YAML na najwyższym poziomie.", file=sys.stderr)
        failed += 1
        continue

    merge(cfg)
    if os.path.exists(path):
        shutil.copy2(path, f"{path}.{suffix}")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        yaml.dump(cfg, fh)
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    else:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    note = " (usunięto stary doklejony blok AgentLB)" if cleaned != text else ""
    print(f"✓ Zaktualizowano konfigurację: {path}{note}")

sys.exit(1 if failed else 0)
PY

# Klucz trafia tylko do .env (głównego i profili, które mają config.yaml).
# Usuwamy poprzednie wpisy, żeby nie mnożyć OPENAI_BASE_URL przy każdym uruchomieniu.
env_files=("$ENV_FILE")
for cfg in "${config_paths[@]:1}"; do
  env_files+=("$(dirname "$cfg")/.env")
done

for ef in "${env_files[@]}"; do
  touch "$ef"
  chmod 600 "$ef" 2>/dev/null || true
  grep -vE '^(export[[:space:]]+)?(AGENT_LB_API_KEY|AGENTLB_API_KEY|OPENAI_BASE_URL)=' "$ef" > "$ef.tmp" 2>/dev/null || true
  printf 'AGENT_LB_API_KEY="%s"\nOPENAI_BASE_URL="%s"\n' "$KEY" "$URL/v1" >> "$ef.tmp"
  chmod 600 "$ef.tmp" 2>/dev/null || true
  mv "$ef.tmp" "$ef"
done

if [ "$merge_status" -ne 0 ]; then
  echo "Uwaga: część plików konfiguracji pominięto (szczegóły wyżej)." >&2
  exit "$merge_status"
fi

echo "Zaktualizowano konfigurację Hermes: $CONFIG_FILE"
echo "Gotowe!"
echo ""
echo "Jak uruchomić Hermes z AgentLB:"
echo "  1. W Hermes wpisz: /model i wybierz 'AgentLB (All Models)'"
echo "  2. Albo bezpośrednio z konsoli:"
echo "     hermes --provider agentlb --model codex"
echo "     hermes --provider agentlb --model claude-sonnet-5"
echo "     hermes --provider agentlb --model gpt-5.6-sol"
