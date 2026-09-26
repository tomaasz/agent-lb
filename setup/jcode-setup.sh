#!/usr/bin/env bash
# jcode-setup.sh — instaluje jcode (github.com/1jehuang/jcode) w PIASKOWNICY i podpina go pod AgentLB.
#
# Użycie (Linux / WSL; na Windowsie uruchom w WSL):
#   export AGENT_LB_API_KEY=...   # klucz stacji (lepiej: read -rs AGENT_LB_API_KEY; export AGENT_LB_API_KEY)
#   curl -fsSL https://agentlb.gotova.pl/jcode-setup.sh | bash
#   (albo: ... | bash -s -- --key <KLUCZ_STACJI>  — klucz trafi wtedy do historii powłoki)
#
# Co robi (idempotentnie, można puszczać wielokrotnie):
#  1. instaluje bubblewrap (sudo -n) jeśli brak, jcode przez oficjalny instalator BEZ telemetrii
#  2. ~/bin/jcode-sandboxed: bwrap — home ukryty, widać tylko projekt + ~/.jcode, każdy .git zamaskowany,
#     środowisko czyszczone (klucze hosta nie wchodzą do środka), binarki tylko do odczytu
#  3. ~/.local/bin/jcode -> piaskownica; strażnik (systemd --user path + .bashrc) przywraca to po aktualizacji
#  4. cron: codzienna aktualizacja jcode tylko gdy jest nowsza wersja (jcode-update --auto)
#  5. profil dostawcy "agentlb" (openai-compatible, <URL>/v1) z kluczem stacji; pomija ekran powitalny
#  6. weryfikacja: izolacja + odpowiedź modelu
set -euo pipefail

URL="${AGENT_LB_URL:-https://agentlb.gotova.pl}"
KEY="${AGENT_LB_API_KEY:-}"
MODEL="${JCODE_MODEL:-claude-opus-5-5}"
VERIFY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift ;;
    --url) URL="${2%/}"; shift ;;
    --model) MODEL="$2"; shift ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n 2,20p "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Nieznany argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
[ "$(uname -s)" = "Linux" ] || { echo "Tylko Linux/WSL. Na Windowsie uruchom w WSL (patrz agent-prompt.md)." >&2; exit 1; }
[ "$(id -u)" != "0" ] || { echo "Nie uruchamiaj jako root." >&2; exit 1; }

export JCODE_NO_TELEMETRY=1 DO_NOT_TRACK=1 JCODE_SKIP_SERVER_RELOAD=1
mkdir -p "$HOME/.jcode" "$HOME/bin" "$HOME/.local/bin" "$HOME/.jcode/logs"
touch "$HOME/.jcode/no_telemetry"

# 1. bubblewrap
if ! command -v bwrap >/dev/null 2>&1; then
  say "Instaluję bubblewrap"
  if sudo -n true 2>/dev/null && command -v apt-get >/dev/null; then sudo -n apt-get install -y -qq bubblewrap >/dev/null
  elif sudo -n true 2>/dev/null && command -v dnf >/dev/null; then sudo -n dnf install -y -q bubblewrap >/dev/null
  else echo "Brak bwrap i brak sudo bez hasła — zainstaluj pakiet 'bubblewrap' i uruchom ponownie." >&2; exit 1; fi
fi
bwrap --unshare-user --unshare-pid --ro-bind / / true 2>/dev/null \
  || { echo "bwrap nie może utworzyć przestrzeni nazw użytkownika (kernel.unprivileged_userns_clone?)." >&2; exit 1; }

# 2. skrypty (osadzone)
say "Zapisuję piaskownicę i strażnika"
cat > "$HOME/bin/jcode-sandboxed" <<'__JCODE_EOF__'
#!/usr/bin/env bash
# jcode-sandboxed — uruchamia jcode w piaskownicy bwrap (wariant ai-isolated-runner.sh).
# - katalog domowy ukryty (tmpfs); widoczne tylko: projekt (rw), ~/.jcode (rw), binarki jcode (ro)
# - każdy .git w projekcie zamaskowany pustym tmpfs
# - sieć WŁĄCZONA (jcode musi rozmawiać z modelem), telemetria i auto-update wyłączone
# - środowisko czyszczone (--clearenv), sekrety hosta nie przechodzą do środka
set -euo pipefail

SCRIPT_NAME=$(basename "$0")
WORKSPACE="$(pwd)"
DRY_RUN=false
EXTRA_ARGS=()
PASS_ENV=()

usage() {
    cat <<EOF
Użycie: $SCRIPT_NAME [opcje] [--] [argumenty jcode...]

Opcje:
  -w, --workspace <katalog>   Katalog projektu (domyślnie: bieżący)
  --ro <ścieżka>              Dodatkowy katalog tylko do odczytu (np. ~/.cargo)
  --rw <ścieżka>              Dodatkowy katalog do zapisu
  --env <NAZWA>               Przekaż zmienną środowiskową z hosta (np. klucz LiteLLM)
  --shell                     Zamiast jcode uruchom bash w tej samej piaskownicy (debug)
  --dry-run                   Wypisz polecenie bwrap bez uruchamiania
  -h, --help                  Pomoc

Przykłady:
  $SCRIPT_NAME                          # jcode w bieżącym katalogu
  $SCRIPT_NAME -w ~/projekty/foo        # jcode w wybranym projekcie
  $SCRIPT_NAME -- login                 # logowanie (dane trafiają do ~/.jcode)
  $SCRIPT_NAME --ro ~/.cargo -- run "zbuduj projekt"
EOF
    exit 1
}

CMD=("$HOME/.jcode/builds/stable/jcode")
JCODE_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -w|--workspace) WORKSPACE="$(realpath "$2")"; shift 2 ;;
        --ro) EXTRA_ARGS+=(--ro-bind "$(realpath "$2")" "$(realpath "$2")"); shift 2 ;;
        --rw) EXTRA_ARGS+=(--bind "$(realpath "$2")" "$(realpath "$2")"); shift 2 ;;
        --env) PASS_ENV+=("$2"); shift 2 ;;
        --shell) CMD=(/bin/bash); shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) usage ;;
        --) shift; JCODE_ARGS+=("$@"); break ;;
        *) JCODE_ARGS+=("$1"); shift ;;
    esac
done

command -v bwrap >/dev/null 2>&1 || { echo "Błąd: brak bwrap." >&2; exit 3; }
[[ -d "$WORKSPACE" ]] || { echo "Błąd: katalog '$WORKSPACE' nie istnieje." >&2; exit 2; }
if [[ "$WORKSPACE" == "$HOME" ]]; then
    echo "Błąd: nie uruchamiaj jcode na całym katalogu domowym — wskaż projekt (-w)." >&2
    exit 2
fi

JHOME="$HOME/.jcode"
mkdir -p "$JHOME/xdg-config" "$JHOME/xdg-data" "$JHOME/xdg-cache" "$JHOME/tools" "$JHOME/external"
touch "$JHOME/no_telemetry"
[[ -f "$JHOME/mcp.json" ]] || echo '{"mcpServers":{}}' > "$JHOME/mcp.json"

BWRAP_ARGS=(
    bwrap
    --ro-bind /usr /usr
    --ro-bind /bin /bin
    --ro-bind /lib /lib
    --ro-bind /lib64 /lib64
    --ro-bind /etc /etc
    --proc /proc
    --dev /dev
    --tmpfs /tmp
    --tmpfs /run
    --tmpfs /home
    --dir "$HOME"
    --bind "$JHOME" "$JHOME"
    # binarki jcode tylko do odczytu — agent nie podmieni sam sobie programu
    --ro-bind "$JHOME/builds" "$JHOME/builds"
    # most MCP (mcp-remote), konfiguracja MCP i globalne instrukcje — też tylko do odczytu
    --ro-bind "$JHOME/tools" "$JHOME/tools"
    --ro-bind "$JHOME/mcp.json" "$JHOME/mcp.json"
    --ro-bind "$JHOME/external" "$JHOME/external"
    --unshare-user
    --unshare-ipc
    --unshare-pid
    --unshare-uts
    --die-with-parent
    --clearenv
    --setenv HOME "$HOME"
    --setenv USER "${USER:-$(id -un)}"
    --setenv PATH "/usr/local/bin:/usr/bin:/bin"
    --setenv TERM "${TERM:-xterm-256color}"
    --setenv LANG "${LANG:-C.UTF-8}"
    --setenv JCODE_HOME "$JHOME"
    --setenv XDG_CONFIG_HOME "$JHOME/xdg-config"
    --setenv XDG_DATA_HOME "$JHOME/xdg-data"
    --setenv XDG_CACHE_HOME "$JHOME/xdg-cache"
    --setenv JCODE_NO_TELEMETRY 1
    --setenv DO_NOT_TRACK 1
    --setenv JCODE_NO_AUTO_UPDATE 1
    --setenv JCODE_NO_BROWSER 1
)
[[ -n "${COLORTERM:-}" ]] && BWRAP_ARGS+=(--setenv COLORTERM "$COLORTERM")
[[ -d /opt ]] && BWRAP_ARGS+=(--ro-bind /opt /opt)
# DNS: /etc/resolv.conf bywa dowiązaniem poza /etc (systemd-resolved: /run/systemd/resolve/…,
# WSL: /mnt/wsl/resolv.conf) — udostępnij sam docelowy plik, tylko do odczytu.
RESOLV="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"
if [[ -n "$RESOLV" && -f "$RESOLV" && "$RESOLV" != /etc/* ]]; then
    BWRAP_ARGS+=(--ro-bind "$RESOLV" "$RESOLV")
fi

# node dla mostu MCP: gdy systemowy `node` to dowiązanie do nvm w $HOME (niewidocznym
# w piaskownicy), udostępnij tylko tę jedną instalację node, tylko do odczytu.
for n in /usr/local/bin/node /usr/bin/node; do
    [[ -e "$n" ]] || continue
    NODE_REAL="$(readlink -f "$n")"
    if [[ "$NODE_REAL" == "$HOME"/* ]]; then
        NODE_DIR="$(dirname "$(dirname "$NODE_REAL")")"
        BWRAP_ARGS+=(--ro-bind "$NODE_DIR" "$NODE_DIR")
    fi
    break
done

for var in "${PASS_ENV[@]}"; do
    [[ -n "${!var:-}" ]] && BWRAP_ARGS+=(--setenv "$var" "${!var}")
done

BWRAP_ARGS+=("${EXTRA_ARGS[@]}" --bind "$WORKSPACE" "$WORKSPACE" --chdir "$WORKSPACE")

# TWARDA IZOLACJA .GIT (katalogi i pliki-wskaźniki worktree)
while IFS= read -r git_entry; do
    if [[ -d "$git_entry" ]]; then
        BWRAP_ARGS+=(--tmpfs "$git_entry")
    else
        BWRAP_ARGS+=(--ro-bind /dev/null "$git_entry")
    fi
done < <(find "$WORKSPACE" -maxdepth 4 -name .git 2>/dev/null)

if [[ "$DRY_RUN" == "true" ]]; then
    printf '%q ' "${BWRAP_ARGS[@]}" -- "${CMD[@]}" "${JCODE_ARGS[@]}"; echo
    exit 0
fi

# Bez exec: po wyjściu jcode (także zabitego/po awarii) przywróć terminal — TUI włącza śledzenie
# myszy, a gdy zginie bez sprzątania, terminal wypisuje kody ruchów myszy („35;40;24M…”).
restore_tty() {
    [[ -t 1 ]] || return 0
    printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1015l\e[?2004l\e[?1049l\e[?25h'
    stty sane 2>/dev/null || true
}
trap restore_tty EXIT
trap 'exit 130' INT TERM HUP
"${BWRAP_ARGS[@]}" -- "${CMD[@]}" "${JCODE_ARGS[@]}"
__JCODE_EOF__
cat > "$HOME/bin/jcode-relink" <<'__JCODE_EOF__'
#!/usr/bin/env bash
# jcode-relink — pilnuje, żeby komenda `jcode` zawsze prowadziła do piaskownicy.
# Instalator/aktualizacja jcode nadpisuje ~/.local/bin/jcode dowiązaniem do prawdziwej binarki;
# ten skrypt przywraca dowiązanie do ~/bin/jcode-sandboxed. Idempotentny, cichy gdy nic nie robi.
# Wołany przez: systemd --user jcode-relink.path (inotify), blok w ~/.bashrc, jcode-update.
set -u
LINK="$HOME/.local/bin/jcode"
TARGET="$HOME/bin/jcode-sandboxed"
[ -x "$TARGET" ] || exit 0
[ "$(readlink "$LINK" 2>/dev/null)" = "$TARGET" ] && exit 0
mkdir -p "$(dirname "$LINK")"
ln -sfn "$TARGET" "$LINK"
ln -sfn "$TARGET" "$HOME/.local/bin/jcode-sandboxed"
echo "[jcode-relink] $(date -Is) przywrócono $LINK -> $TARGET" >&2
__JCODE_EOF__
cat > "$HOME/bin/jcode-update" <<'__JCODE_EOF__'
#!/usr/bin/env bash
# jcode-update — bezpieczna aktualizacja jcode: instalator bez telemetrii (pobrany do pliku,
# weryfikuje SHA-256), bez przeładowania serwera spoza piaskownicy, potem przepięcie `jcode`
# na piaskownicę i weryfikacja.
# Użycie: jcode-update [--version vX.Y.Z]   — ręcznie, zawsze instaluje
#         jcode-update --auto               — z crona: tylko gdy jest nowsza wersja, log w ~/.jcode/logs/update.log
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin"
[ "${1:-}" = "--version" ] && export JCODE_VERSION="$2"
if [ "${1:-}" = "--auto" ]; then
  mkdir -p "$HOME/.jcode/logs"
  exec >>"$HOME/.jcode/logs/update.log" 2>&1
  exec 9>"$HOME/.jcode/update.lock"; flock -n 9 || { echo "$(date -Is) inna aktualizacja w toku"; exit 0; }
  CUR="$("$HOME/.jcode/builds/stable/jcode" --version 2>/dev/null | awk '{print $2}')"   # np. v0.88.0
  LATEST="$(curl -fsSIL --connect-timeout 10 -o /dev/null -w '%{url_effective}' https://github.com/1jehuang/jcode/releases/latest || true)"
  LATEST="${LATEST##*/}"
  if [[ ! "$LATEST" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$(date -Is) nie ustalono najnowszej wersji — pomijam"; exit 0; fi
  # zawsze pilnuj dowiązania, nawet gdy nie ma aktualizacji
  "$HOME/bin/jcode-relink" || true
  if [ "$CUR" = "$LATEST" ]; then exit 0; fi
  echo "$(date -Is) aktualizacja $CUR -> $LATEST"
  export JCODE_VERSION="$LATEST"
fi
export JCODE_NO_TELEMETRY=1 DO_NOT_TRACK=1 JCODE_SKIP_SERVER_RELOAD=1
touch "$HOME/.jcode/no_telemetry"
BASHRC_BAK="$(mktemp)"; cp "$HOME/.bashrc" "$BASHRC_BAK"
INST="$(mktemp)"; trap 'rm -f "$INST" "$BASHRC_BAK"' EXIT
curl -fsSL https://jcode.sh/install -o "$INST"
bash "$INST"
cp "$BASHRC_BAK" "$HOME/.bashrc"   # instalator dopisuje PATH do .bashrc — ~/.local/bin już w nim jest
"$HOME/bin/jcode-relink" || true
# zatrzymaj serwery jcode działające POZA piaskownicą (stara wersja / uruchomione bez wrappera)
for p in $(pgrep -f jcode-linux-x86_64.bin || true); do
  [ "$(readlink /proc/$p/ns/mnt 2>/dev/null)" = "$(readlink /proc/self/ns/mnt)" ] && kill "$p" 2>/dev/null || true
done
[ "$(readlink "$HOME/.local/bin/jcode")" = "$HOME/bin/jcode-sandboxed" ] || { echo "BŁĄD: jcode nie wskazuje na piaskownicę" >&2; exit 1; }
"$HOME/.jcode/builds/stable/jcode" telemetry status | head -1
T="$(mktemp -d)"; (cd "$T" && jcode --version); rmdir "$T"
echo "OK: jcode zaktualizowany, uruchamia się w piaskownicy."
__JCODE_EOF__
chmod 755 "$HOME/bin/jcode-sandboxed" "$HOME/bin/jcode-relink" "$HOME/bin/jcode-update"
ln -sfn "$HOME/bin/jcode-update" "$HOME/.local/bin/jcode-update"

# 3. jcode (oficjalny instalator: weryfikuje SHA-256; .bashrc przywracamy, bo instalator dopisuje PATH)
if [ ! -x "$HOME/.jcode/builds/stable/jcode" ]; then
  say "Instaluję jcode (bez telemetrii)"
  INST="$(mktemp)"; BRC="$(mktemp)"; [ -f "$HOME/.bashrc" ] && cp "$HOME/.bashrc" "$BRC"
  curl -fsSL https://jcode.sh/install -o "$INST"
  bash "$INST" >/dev/null
  [ -s "$BRC" ] && cp "$BRC" "$HOME/.bashrc"; rm -f "$INST" "$BRC"
fi
"$HOME/.jcode/builds/stable/jcode" telemetry disable >/dev/null 2>&1 || true
"$HOME/bin/jcode-relink" 2>/dev/null || true

# strażnik: systemd --user (jeśli jest) + .bashrc
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/jcode-relink.path" <<'__JCODE_EOF__'
[Unit]
Description=Pilnuj, by ~/.local/bin/jcode wskazywał piaskownicę (jcode-sandboxed)

[Path]
PathChanged=%h/.local/bin/jcode
PathModified=%h/.local/bin
Unit=jcode-relink.service

[Install]
WantedBy=default.target
__JCODE_EOF__
  cat > "$HOME/.config/systemd/user/jcode-relink.service" <<'__JCODE_EOF__'
[Unit]
Description=Przepnij ~/.local/bin/jcode na jcode-sandboxed

[Service]
Type=oneshot
ExecStart=%h/bin/jcode-relink
__JCODE_EOF__
  systemctl --user daemon-reload && systemctl --user enable --now jcode-relink.path >/dev/null 2>&1 || warn "nie włączono jcode-relink.path"
else
  warn "brak systemd --user — strażnik działa tylko przy starcie powłoki i w cronie"
fi
python3 - <<'__JCODE_EOF__'
import os,re
f=os.path.expanduser("~/.bashrc"); t=open(f).read() if os.path.exists(f) else ""
b="# >>> jcode-sandbox (zarzadzane) >>>"; e="# <<< jcode-sandbox <<<"
blk=b+"\n# jcode zawsze w piaskownicy: przywróć dowiązanie, gdyby aktualizacja je nadpisała\n[ -x ~/bin/jcode-relink ] && ~/bin/jcode-relink\ncase \":$PATH:\" in *\":$HOME/.local/bin:\"*) ;; *) PATH=\"$HOME/.local/bin:$PATH\" ;; esac\n"+e
t=re.sub(re.escape(b)+".*?"+re.escape(e),lambda _:blk,t,flags=re.S) if b in t else t.rstrip("\n")+"\n\n"+blk+"\n"
open(f,"w").write(t)
__JCODE_EOF__

# 4. cron: codzienna aktualizacja (~04:xx, minuta zależna od hosta)
if command -v crontab >/dev/null 2>&1; then
  MIN=$(( $(hostname | cksum | cut -d' ' -f1) % 50 + 5 ))
  { crontab -l 2>/dev/null | grep -v '# jcode-update (zarzadzane' || true
    echo "$MIN 4 * * * \$HOME/bin/jcode-update --auto  # jcode-update (zarzadzane: jcode-setup.sh)"; } | crontab -
else
  warn "brak crontab — aktualizuj ręcznie: jcode-update"
fi

# 5. ekran powitalny jcode nie widzi profili openai-compatible i proponuje logowanie do OpenAI — pomiń go
python3 - <<'__JCODE_EOF__'
import json,os
f=os.path.expanduser("~/.jcode/setup_hints.json")
d=json.load(open(f)) if os.path.exists(f) else {}
if int(d.get("launch_count",0)) <= 5:
    d["launch_count"]=6; json.dump(d,open(f,"w"),indent=2)
__JCODE_EOF__

# profil agentlb (klucz przez stdin — nie trafia do argv ani na ekran)
W="$(mktemp -d)"
if [ -n "$KEY" ]; then
  say "Profil dostawcy agentlb -> $URL/v1 (model: $MODEL)"
  printf '%s' "$KEY" | "$HOME/bin/jcode-sandboxed" -w "$W" -- provider add agentlb \
    --base-url "$URL/v1" --model "$MODEL" --api-key-stdin --set-default --model-catalog \
    --context-window 200000 --overwrite --json 2>&1 | grep -q '"status": "ok"' \
    || { rm -rf "$W"; echo "Nie udało się dodać profilu agentlb." >&2; exit 1; }
else
  warn "Brak klucza (AGENT_LB_API_KEY / --key) — pomijam profil agentlb"
fi

# 6. weryfikacja
if [ "$VERIFY" = 1 ]; then
  say "Weryfikacja piaskownicy"
  git -C "$W" init -q 2>/dev/null || true
  CHK="$("$HOME/bin/jcode-sandboxed" -w "$W" --shell -- -c 'git status >/dev/null 2>&1 && echo GIT_WIDOCZNY; ls -A ~ | tr "\n" " "; env | grep -ciE "api_key|token" || true' 2>&1)"
  echo "   $CHK" | tr '\n' ' '; echo
  case "$CHK" in *GIT_WIDOCZNY*) echo "BŁĄD: .git widoczny w piaskownicy" >&2; exit 1 ;; esac
  if [ -n "$KEY" ]; then
    say "Weryfikacja modelu"
    R="$(cd "$W" && timeout 180 "$HOME/bin/jcode-sandboxed" -w "$W" -- run 'Reply exactly: JCODE_OK' 2>&1 | tail -1 || true)"
    case "$R" in *JCODE_OK*) echo "   model odpowiada: OK" ;; *) warn "model nie odpowiedział: $R" ;; esac
  fi
fi
rm -rf "$W"
[ "$(readlink "$HOME/.local/bin/jcode")" = "$HOME/bin/jcode-sandboxed" ] || warn "~/.local/bin/jcode nie wskazuje na piaskownicę"
say "Gotowe. W katalogu projektu uruchom: jcode   (w VS Code: nowy terminal w folderze projektu)"
