#!/usr/bin/env bash
# Install interactive agylb; keep the station key out of argv and output.
set -eu
URL="${AGENT_LB_URL:-https://agentlb.gotova.pl}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift ;;
    --lang) shift ;;
    -h|--help) echo 'agylb-setup.sh [--url URL]; klucz: AGENT_LB_API_KEY'; exit 0 ;;
    *) echo 'Nieznana opcja instalatora agylb.' >&2; exit 2 ;;
  esac
  shift
done
case "$(uname -s)" in Linux|Darwin) ;; *) echo 'Uruchom instalator agylb w Linux, macOS lub WSL.' >&2; exit 1 ;; esac
command -v python3 >/dev/null 2>&1 || { echo 'agylb wymaga Python 3.8+.' >&2; exit 1; }
AGYLB_SETUP_DIR=''
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  if [ -d "$(dirname "${BASH_SOURCE[0]}")/../clients" ]; then
    AGYLB_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../clients" && pwd)"
  fi
fi
export AGYLB_SETUP_DIR
AGENT_LB_URL="$URL" python3 - <<'PY'
import io
import json
import os
from pathlib import Path
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request

def fail(message):
    print('agylb: ' + message, file=sys.stderr)
    sys.exit(1)

if sys.version_info < (3, 8):
    fail('Wymagany Python 3.8 lub nowszy.')
if not (shutil.which('agy') or os.access(str(Path.home()/'.local/bin/agy'), os.X_OK)):
    fail('Najpierw zainstaluj Antigravity CLI (polecenie agy).')
url = os.environ['AGENT_LB_URL'].rstrip('/')
key = os.environ.get('AGENT_LB_API_KEY', '')
parsed = urllib.parse.urlsplit(url)
if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1'))) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
    fail('Adres AgentLB wymaga HTTPS (HTTP tylko lokalnie).')
if not key or any(c in key for c in '\r\n'):
    fail('Podaj klucz stacji w AGENT_LB_API_KEY.')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
try:
    request = urllib.request.Request(url+'/agy/credential', headers={'x-api-key': key})
    with opener.open(request, timeout=10) as response:
        # Check access without persisting or displaying Google credentials.
        reply = json.loads(response.read(1048576))
    if not isinstance(reply, dict) or not isinstance(reply.get('account'), dict) or not isinstance(reply.get('token'), dict):
        fail('Niepoprawna odpowiedź puli Google.')
    sources = {}
    local = os.environ.get('AGYLB_SETUP_DIR')
    for filename, endpoint in (('agylb.py', 'agylb.py'), ('install_agylb.py', 'agylb-install.py')):
        if local and (Path(local)/filename).is_file():
            sources[filename] = (Path(local)/filename).read_text()
        else:
            with opener.open(url+'/'+endpoint, timeout=15) as response:
                sources[filename] = response.read(1048576).decode('utf8')
        compile(sources[filename], filename, 'exec')
    payload = {'source': sources['agylb.py'], 'settings': {'url': url, 'key': key}}
    sys.stdin = io.StringIO(json.dumps(payload))
    exec(compile(sources['install_agylb.py'], 'install_agylb.py', 'exec'), {'__name__': '__main__'})
except urllib.error.HTTPError as exc:
    fail({403: 'Stacja nie ma dostępu do puli Google. Sprawdź jej uprawnienia w panelu.',
          401: 'Klucz stacji został odrzucony.', 404: 'Brak wolnego konta Google lub plików instalatora na serwerze.'}.get(exc.code, 'Błąd połączenia z AgentLB.'))
except (OSError, ValueError, SyntaxError, RuntimeError):
    fail('Nie udało się zainstalować agylb. Sprawdź połączenie i uprawnienia.')
print('Gotowe. Uruchom ~/.local/bin/agylb doctor, potem agylb z katalogu projektu.')
print('Wymagane PATH: ~/.local/bin. Rozmowy są zapisywane; zmiana konta pyta o nową rozmowę.')
PY
