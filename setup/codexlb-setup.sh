#!/usr/bin/env bash
# codexlb-setup.sh — podpina lokalne Codex CLI i rozszerzenie VS Code pod proxy codexlb.gotova.pl.
#
# Jeśli w systemie jest Node.js i plik JS, deleguje zadanie do uniwersalnego codexlb-setup.js.
# W przeciwnym razie wykonuje konfigurację w czystym Bashu.
#
# Użycie:
#   ./codexlb-setup.sh                  # klucz z pytania, codexlb jako domyślny provider
#   ./codexlb-setup.sh --profile-only   # nie rusza domyślnych ustawień, dodaje tylko profil
#   ./codexlb-setup.sh --test           # po konfiguracji odpala próbne zapytanie
#   ./codexlb-setup.sh --status         # sprawdza stan konfiguracji i połączenie z proxy
#   ./codexlb-setup.sh --restore        # przywraca poprzednią konfigurację z kopii zapasowej (.bak)
#   ./codexlb-setup.sh --clean          # czyści klucz i konfigurację codexlb
#   ./codexlb-setup.sh --no-ws          # bez WebSocketów (firmowe proxy je zrywa)
#   ./codexlb-setup.sh --insecure       # ignoruje błędy certyfikatów SSL/TLS (-k)
#   CODEX_LB_API_KEY=sk-clb-... ./codexlb-setup.sh   # klucz ze zmiennej, bez pytania
#
# Skrypt jest idempotentny — można go puszczać wielokrotnie.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd || pwd)"

# Jeśli dostępny jest Node.js oraz plik JS (np. lokalne repo), deleguj
if [ -n "${SCRIPT_DIR:-}" ] && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/codexlb-setup.js" ]; then
	exec node "$SCRIPT_DIR/codexlb-setup.js" "$@"
fi

URL="${AGENT_LB_URL:-${CODEXLB_URL:-https://codexlb.gotova.pl}}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
ENV_FILE="${CODEXLB_ENV_FILE:-$HOME/.config/codexlb.env}"
MODEL="${CODEXLB_MODEL:-gpt-5.6-sol}"
EFFORT="${CODEXLB_EFFORT:-xhigh}"
CONFIG="$CODEX_HOME/config.toml"
PROFILE_FILE="$CODEX_HOME/codexlb.config.toml"
SET_DEFAULT=1
RUN_TEST=0
USE_WS=true
CLEAN=0
STATUS=0
RESTORE=0
INSECURE=0
CURL_INSECURE_FLAG=""

while [ $# -gt 0 ]; do
	case "$1" in
		--profile-only) SET_DEFAULT=0 ;;
		--test) RUN_TEST=1 ;;
		--no-ws) USE_WS=false ;;
		--clean) CLEAN=1 ;;
		--status|-s) STATUS=1 ;;
		--restore|-r) RESTORE=1 ;;
		--insecure|-k) INSECURE=1; CURL_INSECURE_FLAG="-k" ;;
		--model) MODEL="$2"; shift ;;
		--effort) EFFORT="$2"; shift ;;
		--url) URL="${2%/}"; shift ;;
		-h|--help) sed -n '2,21p' "$0"; exit 0 ;;
		*) echo "Nieznany argument: $1 (--help)" >&2; exit 2 ;;
	esac
	shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'BLAD: %s\n' "$*" >&2; exit 1; }

mask_key() {
	local k="$1"
	if [ -z "$k" ]; then
		printf '(brak)\n'
	elif [ "${#k}" -le 8 ]; then
		printf '****\n'
	else
		printf '%s...%s\n' "${k:0:7}" "${k: -4}"
	fi
}

# ------------------------------------------------------------------ restore
if [ "$RESTORE" -eq 1 ]; then
	say "=== Przywracanie konfiguracji Codex z kopii zapasowej ==="
	if [ ! -d "$CODEX_HOME" ]; then
		say "[Info] Katalog ~/.codex nie istnieje."
		exit 0
	fi
	latest="$(ls -1t "$CODEX_HOME"/config.toml.bak-* 2>/dev/null | head -n 1 || true)"
	if [ -z "$latest" ]; then
		say "[Info] Nie znaleziono zadnych plikow kopii zapasowej (config.toml.bak-*) w $CODEX_HOME."
		exit 0
	fi
	cp "$latest" "$CONFIG"
	say "[OK] Przywrocono konfiguracje z kopii: $(basename "$latest")"
	exit 0
fi

# ------------------------------------------------------------------- status
if [ "$STATUS" -eq 1 ]; then
	say "=== Stan konfiguracji CodexLB ==="
	say ""

	current_key="${AGENT_LB_API_KEY:-${CODEX_LB_API_KEY:-}}"
	if [ -z "$current_key" ] && [ -r "$ENV_FILE" ]; then
		current_key="$(sed -n 's/^export \(?:AGENT_LB_API_KEY\|CODEX_LB_API_KEY\)=//p' "$ENV_FILE" 2>/dev/null | tr -d '"'\''' | head -1)"
		[ -z "$current_key" ] && current_key="$(sed -n 's/^export CODEX_LB_API_KEY=//p' "$ENV_FILE" | tr -d '"'\''' | head -1)"
	fi
	say "1. Klucz API:          $(mask_key "$current_key")"

	if [ -f "$CONFIG" ]; then
		say "2. Konfiguracja:       $CONFIG"
		m="$(grep -E '^[[:space:]]*model[[:space:]]*=' "$CONFIG" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/' || true)"
		p="$(grep -E '^[[:space:]]*model_provider[[:space:]]*=' "$CONFIG" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/' || true)"
		u="$(grep -E '^[[:space:]]*base_url[[:space:]]*=' "$CONFIG" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/' || true)"
		ws="$(grep -E '^[[:space:]]*supports_websockets[[:space:]]*=' "$CONFIG" | head -1 | sed -E 's/.*=[[:space:]]*([a-zA-Z]+).*/\1/' || true)"
		[ -n "$m" ] && say "   - Domyslny model:   $m"
		[ -n "$p" ] && say "   - Model provider:   $p"
		[ -n "$u" ] && say "   - Base URL:         $u"
		[ -n "$ws" ] && say "   - WebSockets:       $ws"
	else
		say "2. Konfiguracja:       $CONFIG (brak pliku)"
	fi

	if [ -f "$PROFILE_FILE" ]; then
		say "3. Profil dedykowany:  [OK] $PROFILE_FILE"
	else
		say "3. Profil dedykowany:  (brak)"
	fi

	if command -v codex >/dev/null 2>&1; then
		say "4. Codex CLI w PATH:   [OK] $(codex --version 2>/dev/null || echo 'znaleziono w PATH')"
	else
		say "4. Codex CLI w PATH:   [Brak] zainstaluj via npm install -g @openai/codex"
	fi

	if [ -n "$current_key" ]; then
		printf '5. Test proxy (%s)... ' "$URL"
		body="$(curl -s -m 25 $CURL_INSECURE_FLAG -H "Authorization: Bearer $current_key" "$URL/backend-api/codex/models" || true)"
		if printf '%s' "$body" | grep -q '"id":'; then
			say "OK"
			models="$(printf '%s' "$body" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | paste -sd ', ' -)"
			say "   - Dostepne modele:  $models"
		else
			say "BLAD"
			say "   - $body"
		fi
	else
		say "5. Test proxy:         Pominieto (brak zapisanego klucza)"
	fi
	exit 0
fi

# ------------------------------------------------------------- czyszczenie
if [ "$CLEAN" -eq 1 ]; then
	say "=== Czyszczenie konfiguracji i kluczy CodexLB ==="
	if [ -f "$ENV_FILE" ]; then
		rm -f "$ENV_FILE"
		say "[OK] Usunieto $ENV_FILE."
	fi
	for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
		if [ -f "$rc" ] && grep -qF "# codexlb" "$rc"; then
			grep -v "# codexlb" "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc"
			say "[OK] Usunieto wpis codexlb z $rc."
		fi
	done

	if [ -f "$CONFIG" ]; then
		backup="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
		cp "$CONFIG" "$backup"
		say "Kopia dotychczasowej konfiguracji: $backup"
		stripped="$(mktemp)"
		awk '
			/^# >>> codexlb/ { skip = 1; next }
			/^# <<< codexlb/ { skip = 0; next }
			skip { next }
			/^[[:space:]]*\[profiles\.codexlb\]/ { drop_profile = 1; next }
			drop_profile && /^[[:space:]]*\[/ { drop_profile = 0 }
			drop_profile { next }
			{ print }
		' "$CONFIG" > "$stripped"
		mv "$stripped" "$CONFIG"
		say "[OK] Usunieto sekcje codexlb z $CONFIG."
	fi

	if [ -f "$PROFILE_FILE" ]; then
		rm -f "$PROFILE_FILE"
		say "[OK] Usunieto profil $PROFILE_FILE."
	fi

	say ""
	say "=== Czyszczenie zakonczone! ==="
	say "Otworz nowa powloke lub wykonaj: unset CODEX_LB_API_KEY"
	exit 0
fi

command -v curl >/dev/null || die "brak curl"

# ---------------------------------------------------------------- klucz API
KEY="${AGENT_LB_API_KEY:-${CODEX_LB_API_KEY:-}}"
if [ -z "$KEY" ] && [ -r "$ENV_FILE" ]; then
	KEY="$(sed -n 's/^export \(?:AGENT_LB_API_KEY\|CODEX_LB_API_KEY\)=//p' "$ENV_FILE" 2>/dev/null | tr -d '"'\''' | head -1)"
	[ -z "$KEY" ] && KEY="$(sed -n 's/^export CODEX_LB_API_KEY=//p' "$ENV_FILE" | tr -d '"'\''' | head -1)"
	[ -n "$KEY" ] && say "Uzywam klucza zapisanego wczesniej: $(mask_key "$KEY")"
fi
if [ -z "$KEY" ]; then
	printf 'Klucz API z panelu %s (zakladka /apis), wklej i Enter: ' "$URL"
	if [ -t 0 ]; then
		read -rs KEY; printf '\n'
	elif [ -e /dev/tty ]; then
		read -rs KEY </dev/tty; printf '\n'
	else
		read -rs KEY; printf '\n'
	fi
fi
[ -n "$KEY" ] || die "nie podano klucza"

# ------------------------------------------------------- sprawdzenie klucza
say "Sprawdzam klucz na $URL ..."
resp_file="$(mktemp)"
code="$(curl -s -m 25 $CURL_INSECURE_FLAG -o "$resp_file" -w '%{http_code}' \
	-H "Authorization: Bearer $KEY" "$URL/backend-api/codex/models" || true)"

case "$code" in
	200)
		say "OK — klucz dziala, proxy odpowiada."
		models="$(grep -o '"id":"[^"]*"' "$resp_file" | cut -d'"' -f4 | paste -sd ', ' - || true)"
		if [ -n "$models" ]; then
			say "Dostepne modele na proxy: $models"
		fi
		;;
	401|403)
		rm -f "$resp_file"
		die "serwer odrzucil klucz ($code). Wygeneruj nowy w panelu, zakladka /apis."
		;;
	000)
		rm -f "$resp_file"
		die "brak polaczenia z $URL. W sieci firmowej sprawdz proxy (export https_proxy=...) lub uzyj --insecure."
		;;
	*)
		rm -f "$resp_file"
		die "nieoczekiwana odpowiedz $code z $URL/backend-api/codex/models"
		;;
esac
rm -f "$resp_file"

# --------------------------------------------------------- klucz w powloce
mkdir -p "$(dirname "$ENV_FILE")"
umask 077
printf 'export CODEX_LB_API_KEY=%s\n' "$KEY" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Klucz zapisany w $ENV_FILE (tylko dla Ciebie, chmod 600)."

src_line=". \"$ENV_FILE\"  # codexlb"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
	[ -f "$rc" ] || continue
	if ! grep -qF "# codexlb" "$rc"; then
		printf '\n%s\n' "$src_line" >> "$rc"
		say "Dopisalem wczytywanie klucza do $rc."
	fi
done

# ------------------------------------------------------------ config.toml
mkdir -p "$CODEX_HOME"
if [ -f "$CONFIG" ]; then
	backup="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
	cp "$CONFIG" "$backup"
	say "Kopia dotychczasowej konfiguracji: $backup"
else
	: > "$CONFIG"
fi

stripped="$(mktemp)"
awk -v strip_top="$SET_DEFAULT" '
	/^# >>> codexlb/ { skip = 1; next }
	/^# <<< codexlb/ { skip = 0; next }
	skip { next }
	/^[[:space:]]*\[profiles\.codexlb\]/ { drop_profile = 1; next }
	drop_profile && /^[[:space:]]*\[/ { drop_profile = 0 }
	drop_profile { next }
	/^[[:space:]]*\[/ { seen_table = 1 }
	strip_top == 1 && !seen_table && /^[[:space:]]*(model|model_provider|model_reasoning_effort)[[:space:]]*=/ { next }
	{ print }
' "$CONFIG" > "$stripped"

{
	if [ "$SET_DEFAULT" -eq 1 ]; then
		cat <<-EOF
			# >>> codexlb-default >>> (zarzadzane przez codexlb-setup.sh)
			model = "$MODEL"
			model_provider = "codex-lb"
			model_reasoning_effort = "$EFFORT"
			# <<< codexlb-default <<<

		EOF
	fi
	cat "$stripped"
	cat <<-EOF

		# >>> codexlb >>> (zarzadzane przez codexlb-setup.sh)
		# Codex CLI gada z proxy po /backend-api/codex — to inna sciezka niz /v1,
		# ktorej uzywaja biblioteki OpenAI. Klucz idzie ze zmiennej srodowiskowej.
		[model_providers.codex-lb]
		name = "openai"
		base_url = "$URL/backend-api/codex"
		wire_api = "responses"
		supports_websockets = $USE_WS
		requires_openai_auth = true
		env_key = "CODEX_LB_API_KEY"
		# <<< codexlb <<<
	EOF
} > "$CONFIG"
rm -f "$stripped"
say "Zapisalem $CONFIG."

cat > "$PROFILE_FILE" <<-EOF
	# Profil "codexlb" — zarzadzane przez codexlb-setup.sh.
	# Uzycie: codex --profile codexlb
	model = "$MODEL"
	model_provider = "codex-lb"
	model_reasoning_effort = "$EFFORT"
EOF
say "Zapisalem profil $PROFILE_FILE."

# ------------------------------------------------------------------- test
if [ "$RUN_TEST" -eq 1 ]; then
	if ! command -v codex >/dev/null 2>&1; then
		say ""
		say "[Uwaga] Nie znaleziono polecenia codex w PATH."
		say "Konfiguracja zostala zapisana. Aby wykonac test, zainstaluj Codex CLI:"
		say "    npm install -g @openai/codex"
	else
		say "Probne zapytanie przez proxy (moze chwile potrwac)..."
		out="$(CODEX_LB_API_KEY="$KEY" timeout 180 codex exec --profile codexlb \
			--skip-git-repo-check "Odpowiedz jednym slowem: ok" 2>&1 || true)"
		printf '%s\n' "$out" | tail -12
		case "$out" in
			*"No available accounts"*|*"429"*|*"usage limit"*|*"owner account is unavailable"*)
				say ""
				say "Uwaga: polaczenie i klucz sa dobre — to konta ChatGPT sa na limicie."
				say "Zuzycie i reset limitow widac w panelu $URL." ;;
			*"401"*|*"invalid_api_key"*)
				say ""
				say "Serwer odrzucil klucz przy samym zapytaniu — wygeneruj nowy w /apis." ;;
		esac
	fi
fi

say ""
say "Gotowe. W nowej powloce (albo po: . $ENV_FILE) uruchamiaj:"
if [ "$SET_DEFAULT" -eq 1 ]; then
	say "    codex                      # codexlb jest teraz domyslny"
fi
say "    codex --profile codexlb    # jawnie przez proxy"
