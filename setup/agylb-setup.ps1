# Install interactive agylb and agylb-yolo on Windows (PowerShell);
# keep the station key out of argv and output.

[CmdletBinding()]
param(
	[string]$Url = '',
	[string]$Lang = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Url) {
	if ($env:AGENT_LB_URL) { $Url = $env:AGENT_LB_URL }
	elseif ($env:AGENTLB_URL) { $Url = $env:AGENTLB_URL }
	else { $Url = 'https://agentlb.gotova.pl' }
}
$Url = $Url.TrimEnd('/')

$pyExe = $null
$pyPrefix = @()
foreach ($cand in @(
	@{ exe = 'py'; prefix = @('-3') },
	@{ exe = 'python'; prefix = @() },
	@{ exe = 'python3'; prefix = @() }
)) {
	$cmd = Get-Command $cand.exe -ErrorAction SilentlyContinue
	if (-not $cmd) { continue }
	try {
		$verOut = & $cmd.Source @($cand.prefix + @('-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)')) 2>$null
		if ($LASTEXITCODE -eq 0) {
			$pyExe = $cmd.Source
			$pyPrefix = $cand.prefix
			break
		}
	} catch {}
}
if (-not $pyExe) {
	throw 'agylb wymaga Python 3.8 lub nowszego w PATH (python lub py -3).'
}

$localClientsDir = ''
if ($PSScriptRoot) {
	$candDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'clients'
	if (Test-Path $candDir) { $localClientsDir = (Resolve-Path $candDir).Path }
}

$pyCode = @'
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

home = Path.home()
local_app = Path(os.environ.get('LOCALAPPDATA') or (home / 'AppData/Local'))
agy_found = bool(shutil.which('agy')) or any(
    p.is_file() for p in (
        home / '.local/bin/agy.exe',
        home / '.local/bin/agy.cmd',
        home / '.gemini/antigravity-cli/bin/agy.exe',
        local_app / 'Programs/Antigravity/bin/agy.exe',
        local_app / 'antigravity/bin/agy.exe',
    )
)
if not agy_found:
    fail('Najpierw zainstaluj Antigravity CLI (polecenie agy) na Windows.')

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
    request = urllib.request.Request(url + '/agy/credential', headers={'x-api-key': key})
    with opener.open(request, timeout=10) as response:
        # Check access without persisting or displaying Google credentials.
        reply = json.loads(response.read(1048576))
    if not isinstance(reply, dict) or not isinstance(reply.get('account'), dict) or not isinstance(reply.get('token'), dict):
        fail('Niepoprawna odpowied\u017a puli Google.')
    sources = {}
    local = os.environ.get('AGYLB_SETUP_DIR')
    for filename, endpoint in (('agylb.py', 'agylb.py'), ('install_agylb.py', 'agylb-install.py')):
        if local and (Path(local) / filename).is_file():
            sources[filename] = (Path(local) / filename).read_text(encoding='utf-8')
        else:
            with opener.open(url + '/' + endpoint, timeout=15) as response:
                sources[filename] = response.read(1048576).decode('utf-8')
        compile(sources[filename], filename, 'exec')
    payload = {'source': sources['agylb.py'], 'settings': {'url': url, 'key': key}}
    sys.stdin = io.StringIO(json.dumps(payload))
    exec(compile(sources['install_agylb.py'], 'install_agylb.py', 'exec'), {'__name__': '__main__'})
except urllib.error.HTTPError as exc:
    fail({403: 'Stacja nie ma dost\u0119pu do puli Google. Sprawd\u017a jej uprawnienia w panelu.',
          401: 'Klucz stacji zosta\u0142 odrzucony.',
          404: 'Brak wolnego konta Google lub plik\u00f3w instalatora na serwerze.'}.get(exc.code, 'B\u0142\u0105d po\u0142\u0105czenia z AgentLB.'))
except (OSError, ValueError, SyntaxError, RuntimeError):
    fail('Nie uda\u0142o si\u0119 zainstalowa\u0107 agylb. Sprawd\u017a po\u0142\u0105czenie i uprawnienia.')
'@

$prevUrl = $env:AGENT_LB_URL
$prevDir = $env:AGYLB_SETUP_DIR
$prevUtf8 = $env:PYTHONUTF8
try {
	$env:AGENT_LB_URL = $Url
	$env:AGYLB_SETUP_DIR = $localClientsDir
	$env:PYTHONUTF8 = '1'
	$pyCode | & $pyExe @($pyPrefix + @('-'))
	if ($LASTEXITCODE -ne 0) {
		throw "Instalacja agylb nie powiodla sie (kod $LASTEXITCODE)."
	}
} finally {
	$env:AGENT_LB_URL = $prevUrl
	$env:AGYLB_SETUP_DIR = $prevDir
	$env:PYTHONUTF8 = $prevUtf8
}

$homeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { '.' }
$binDir = Join-Path $homeDir '.local\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() }) }
$normBin = $binDir.TrimEnd('\').ToLowerInvariant()
$hasInUser = $entries | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $normBin }
if (-not $hasInUser) {
	$newUserPath = if ($entries.Count -gt 0) { ($entries + $binDir) -join ';' } else { $binDir }
	[Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
}
$procEntries = @($env:Path -split ';' | Where-Object { $_ -and $_.Trim() })
$hasInProc = $procEntries | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $normBin }
if (-not $hasInProc) {
	$env:Path = if ($env:Path) { "$binDir;$env:Path" } else { $binDir }
}

Write-Host 'Gotowe. Zainstalowano polecenia: agylb (standardowe uprawnienia) oraz agylb-yolo (bez pytan o akceptacje).'
Write-Host "Dodano $binDir do PATH (biezaca sesja i profil uzytkownika Windows)."
Write-Host 'Uruchom: agylb doctor, potem agylb lub agylb-yolo w katalogu projektu.'
