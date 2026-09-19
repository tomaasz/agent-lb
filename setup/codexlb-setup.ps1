# codexlb-setup.ps1 - podpina Codex po stronie Windowsa (CLI + rozszerzenie w
# VS Code) pod proxy codexlb.gotova.pl.
#
# Jeśli w systemie jest Node.js, deleguje zadanie do uniwersalnego codexlb-setup.js.
# W przeciwnym razie wykonuje konfigurację w natywnym PowerShellu.
#
# Uzycie (PowerShell, zwykly uzytkownik, bez administratora):
#   .\codexlb-setup.ps1                # klucz z pytania, codexlb jako domyslny
#   .\codexlb-setup.ps1 -ProfileOnly   # nie rusza domyslnych, dodaje tylko profil
#   .\codexlb-setup.ps1 -NoWs          # bez WebSocketow (firmowe proxy je zrywa)
#   .\codexlb-setup.ps1 -Test          # po konfiguracji odpala probne zapytanie
#   .\codexlb-setup.ps1 -Status        # sprawdza stan konfiguracji i polaczenie
#   .\codexlb-setup.ps1 -Restore       # przywraca poprzednia konfiguracje z kopii (.bak)
#   .\codexlb-setup.ps1 -Clean         # czysci klucz i konfiguracje codexlb
#   .\codexlb-setup.ps1 -Insecure      # ignoruje bledy certyfikatow SSL/TLS
#   .\codexlb-setup.ps1 -Key sk-...    # klucz z parametru
#
# Skrypt jest idempotentny.

[CmdletBinding()]
param(
	[switch]$ProfileOnly,
	[switch]$NoWs,
	[switch]$Test,
	[switch]$Clean,
	[switch]$Status,
	[switch]$Restore,
	[switch]$Insecure,
	[alias('h')][switch]$Help,
	[string]$Url    = 'https://codexlb.gotova.pl',
	[string]$Key    = '',
	[string]$Model  = 'gpt-5.6-sol',
	[string]$Effort = 'xhigh'
)

$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')

function Say($msg) { Write-Host $msg }

if ($Help) {
	Say @"
CodexLB Client Setup (PowerShell / Windows)

Uzycie:
  .\codexlb-setup.ps1 [opcje]

Opcje:
  -Url <URL>          Adres proxy (domyslnie: $Url)
  -Key <KLUCZ>        Klucz API z panelu codexlb (zakladka /apis)
  -Model <MODEL>      Model Codex (domyslnie: $Model)
  -Effort <EFFORT>    Reasoning effort (domyslnie: $Effort)
  -NoWs               Wylacz obsluge WebSocket (dla sieci firmowych z inspekcja TLS)
  -ProfileOnly        Nie zmieniaj domyslnego modelu, utworz tylko profil codexlb
  -Test               Wykonaj testowe zapytanie przez proxy po konfiguracji
  -Status, -s         Sprawdz stan konfiguracji, klucza i polaczenia z proxy
  -Restore, -r        Przywroc poprzednia konfiguracje z kopii zapasowej (.bak)
  -Clean              Wyczysc klucz API oraz konfiguracje codexlb z systemu
  -Insecure, -k       Ignoruj bledy certyfikatow SSL/TLS (inspekcja SSL / proxy)
  -Help, -h           Pokaz ten ekran pomocy
"@
	exit 0
}

# Obsługa ignorowania certyfikatów SSL/TLS (inspekcja TLS w firmowych proxy)
if ($Insecure) {
	try {
		[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
	} catch {}
}

# Delegacja do node jeśli dostępny i uruchomiono z lokalnego repozytorium
if ($PSScriptRoot) {
	$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
	$jsScript = Join-Path $PSScriptRoot "codexlb-setup.js"
	if ($nodeCmd -and (Test-Path $jsScript)) {
		$nodeArgs = @($jsScript, "--url", $Url, "--model", $Model, "--effort", $Effort)
		if ($Key) { $nodeArgs += @("--key", $Key) }
		if ($NoWs) { $nodeArgs += "--no-ws" }
		if ($ProfileOnly) { $nodeArgs += "--profile-only" }
		if ($Test) { $nodeArgs += "--test" }
		if ($Clean) { $nodeArgs += "--clean" }
		if ($Status) { $nodeArgs += "--status" }
		if ($Restore) { $nodeArgs += "--restore" }
		if ($Insecure) { $nodeArgs += "--insecure" }
		& node $nodeArgs
		exit $LASTEXITCODE
	}
}

$homeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { '.' }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $homeDir '.codex' }
$config    = Join-Path $codexHome 'config.toml'
$profFile  = Join-Path $codexHome 'codexlb.config.toml'
$wsValue   = if ($NoWs) { 'false' } else { 'true' }

function Mask-Key($k) {
	if (-not $k) { return '(brak)' }
	if ($k.Length -le 8) { return '****' }
	return $k.Substring(0, 7) + '...' + $k.Substring($k.Length - 4)
}

# ------------------------------------------------------------------ restore
if ($Restore) {
	Say '=== Przywracanie konfiguracji Codex z kopii zapasowej ==='
	if (-not (Test-Path $codexHome)) {
		Say '[Info] Katalog ~/.codex nie istnieje.'
		exit 0
	}
	$bakFiles = Get-ChildItem -Path $codexHome -Filter 'config.toml.bak-*' | Sort-Object Name -Descending
	if (-not $bakFiles -or $bakFiles.Count -eq 0) {
		Say "[Info] Nie znaleziono zadnych plikow kopii zapasowej (config.toml.bak-*) w $codexHome"
		exit 0
	}
	$latest = $bakFiles[0].FullName
	Copy-Item -Path $latest -Destination $config -Force
	Say "[OK] Przywrocono konfiguracje z kopii: $($bakFiles[0].Name)"
	exit 0
}

# ------------------------------------------------------------------- status
if ($Status) {
	Say '=== Stan konfiguracji CodexLB ==='
	Say ''
	$userKey = [Environment]::GetEnvironmentVariable('CODEX_LB_API_KEY', 'User')
	$activeKey = if ($env:CODEX_LB_API_KEY) { $env:CODEX_LB_API_KEY } else { $userKey }
	Say "1. Klucz API:          $(Mask-Key $activeKey)"

	if (Test-Path $config) {
		Say "2. Konfiguracja:       $config"
		$content = Get-Content -Path $config -Raw
		if ($content -match '(?m)^\s*model\s*=\s*"([^"]+)"') { Say "   - Domyslny model:   $($Matches[1])" }
		if ($content -match '(?m)^\s*model_provider\s*=\s*"([^"]+)"') { Say "   - Model provider:   $($Matches[1])" }
		if ($content -match '(?m)^\s*base_url\s*=\s*"([^"]+)"') { Say "   - Base URL:         $($Matches[1])" }
		if ($content -match '(?m)^\s*supports_websockets\s*=\s*([a-zA-Z]+)') { Say "   - WebSockets:       $($Matches[1])" }
	} else {
		Say "2. Konfiguracja:       $config (brak pliku)"
	}

	$hasProf = Test-Path $profFile
	$profStatus = if ($hasProf) { "[OK] $profFile" } else { "(brak)" }
	Say "3. Profil dedykowany:  $profStatus"

	$hasCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
	$codexText = if ($hasCodex) { "[OK] znaleziono w PATH" } else { "[Brak] zainstaluj via npm install -g @openai/codex" }
	Say "4. Codex CLI w PATH:   $codexText"

	if ($activeKey) {
		Write-Host "5. Test proxy ($Url)... " -NoNewline
		$sw = [System.Diagnostics.Stopwatch]::StartNew()
		try {
			$resp = Invoke-RestMethod -Uri "$Url/backend-api/codex/models" -Method Get `
				-Headers @{ Authorization = "Bearer $activeKey" } -TimeoutSec 25
			$sw.Stop()
			Say "OK ($($sw.ElapsedMilliseconds) ms)"
			if ($resp.data) {
				$mIds = $resp.data | ForEach-Object { $_.id }
				Say "   - Dostepne modele ($($mIds.Count)): $($mIds -join ', ')"
			}
		} catch {
			Say 'BLAD'
			Say "   - $($_.Exception.Message)"
		}
	} else {
		Say '5. Test proxy:         Pominieto (brak zapisanego klucza)'
	}
	exit 0
}

# ------------------------------------------------------------- czyszczenie
if ($Clean) {
	Say '=== Czyszczenie konfiguracji i kluczy CodexLB ==='
	Say 'Usuwam zmienne Agent-LB / Codex ze srodowiska uzytkownika...'
	[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $null, 'User')
	[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $null, 'User')
	[Environment]::SetEnvironmentVariable('AGENT_LB_API_KEY', $null, 'User')
	[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', $null, 'User')
	[Environment]::SetEnvironmentVariable('CODEX_BASE_URL', $null, 'User')
	$env:CODEX_LB_API_KEY = $null
	$env:OPENAI_API_KEY = $null
	$env:AGENT_LB_API_KEY = $null
	Say '[OK] Usunieto zmienne ze srodowiska Windows.'

	if (Test-Path $config) {
		$backup = "$config.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
		Copy-Item -Path $config -Destination $backup
		Say "Kopia dotychczasowej konfiguracji: $backup"

		$raw = Get-Content -Path $config
		$kept = [System.Collections.Generic.List[string]]::new()
		$skipBlock = $false
		$dropProfile = $false

		foreach ($line in $raw) {
			if ($line -match '^# >>> codexlb') { $skipBlock = $true; continue }
			if ($line -match '^# <<< codexlb') { $skipBlock = $false; continue }
			if ($skipBlock) { continue }

			if ($line -match '^\s*\[profiles\.codexlb\]') { $dropProfile = $true; continue }
			if ($dropProfile -and $line -match '^\s*\[') { $dropProfile = $false }
			if ($dropProfile) { continue }

			$kept.Add($line)
		}
		Set-Content -Path $config -Value $kept -Encoding UTF8
		Say "[OK] Usunieto sekcje codexlb z $config."
	}

	if (Test-Path $profFile) {
		Remove-Item -Path $profFile -Force
		Say "[OK] Usunieto profil $profFile."
	}

	Say ''
	Say '=== Czyszczenie zakonczone! ==='
	Say 'Zrestartuj terminale lub VS Code, aby odswiezyc zmienne srodowiskowe.'
	exit 0
}

# ---------------------------------------------------------------- klucz API
if (-not $Key) { $Key = $env:CODEX_LB_API_KEY }
if (-not $Key) {
	$Key = [Environment]::GetEnvironmentVariable('CODEX_LB_API_KEY', 'User')
	if ($Key) { Say "Uzywam klucza zapisanego wczesniej: $(Mask-Key $Key)" }
}
if (-not $Key) {
	$secure = Read-Host -Prompt "Klucz API z panelu $Url, wklej i Enter" -AsSecureString
	$Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
		[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($Key) { $Key = $Key.Trim() }
if (-not $Key) { throw 'Nie podano klucza.' }

# ------------------------------------------------------- sprawdzenie klucza
Say "Sprawdzam klucz na $Url ..."
try {
	$resp = Invoke-RestMethod -Uri "$Url/backend-api/codex/models" -Method Get `
		-Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 25
	Say 'OK - klucz dziala, proxy odpowiada.'
	if ($resp.data) {
		$mIds = $resp.data | ForEach-Object { $_.id }
		Say "Dostepne modele na proxy ($($mIds.Count)): $($mIds -join ', ')"
		if ($mIds -notcontains $Model) {
			Say "[Ostrzezenie] Model '$Model' nie znajduje sie na liscie zwroconej przez proxy."
		}
	}
} catch {
	$code = $null
	if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
	switch ($code) {
		401 { throw 'Serwer odrzucil klucz (401). Wygeneruj nowy w panelu, zakladka /apis.' }
		403 { throw 'Serwer odrzucil klucz (403). Wygeneruj nowy w panelu, zakladka /apis.' }
		default {
			throw "Brak polaczenia z $Url ($($_.Exception.Message)). W sieci firmowej sprawdz proxy lub uzyj -Insecure."
		}
	}
}

# --------------------------------------------------------- klucz w rejestrze
Say 'Zapisuje klucz i zmienne w srodowisku uzytkownika (rejestr)...'
[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('AGENT_LB_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', "$Url/v1", 'User')
[Environment]::SetEnvironmentVariable('CODEX_BASE_URL', "$Url/backend-api/codex", 'User')
$env:CODEX_LB_API_KEY = $Key
$env:OPENAI_API_KEY   = $Key
$env:AGENT_LB_API_KEY = $Key
$env:OPENAI_BASE_URL  = "$Url/v1"
$env:CODEX_BASE_URL   = "$Url/backend-api/codex"

# ------------------------------------------------------------ config.toml
if (-not (Test-Path $codexHome)) { New-Item -ItemType Directory -Path $codexHome -Force | Out-Null }
if (Test-Path $config) {
	$backup = "$config.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
	Copy-Item -Path $config -Destination $backup
	Say "Kopia dotychczasowej konfiguracji: $backup"
} else {
	New-Item -ItemType File -Path $config -Force | Out-Null
}

$raw = if (Test-Path $config) { Get-Content -Path $config } else { @() }
$kept = [System.Collections.Generic.List[string]]::new()
$skipBlock = $false
$dropProfile = $false
$seenTable = $false

foreach ($line in $raw) {
	if ($line -match '^# >>> codexlb') { $skipBlock = $true; continue }
	if ($line -match '^# <<< codexlb') { $skipBlock = $false; continue }
	if ($skipBlock) { continue }

	if ($line -match '^\s*\[profiles\.codexlb\]') { $dropProfile = $true; continue }
	if ($dropProfile -and $line -match '^\s*\[') { $dropProfile = $false }
	if ($dropProfile) { continue }

	if ($line -match '^\s*\[') { $seenTable = $true }

	if (-not $ProfileOnly -and -not $seenTable -and
		$line -match '^\s*(model|model_provider|model_reasoning_effort)\s*=') {
		continue
	}
	$kept.Add($line)
}

$out = [System.Collections.Generic.List[string]]::new()
if (-not $ProfileOnly) {
	$out.Add('# >>> codexlb-default >>> (zarzadzane przez codexlb-setup.ps1)')
	$out.Add("model = `"$Model`"")
	$out.Add('model_provider = "codex-lb"')
	$out.Add("model_reasoning_effort = `"$Effort`"")
	$out.Add('# <<< codexlb-default <<<')
	$out.Add('')
}
$out.AddRange($kept)
$out.Add('')
$out.Add('# >>> codexlb >>> (zarzadzane przez codexlb-setup.ps1)')
$out.Add('# Codex gada z proxy po /backend-api/codex - to inna sciezka niz /v1,')
$out.Add('# ktorej uzywaja biblioteki OpenAI. Klucz idzie ze zmiennej srodowiskowej.')
$out.Add('[model_providers.codex-lb]')
$out.Add('name = "openai"')
$out.Add("base_url = `"$Url/backend-api/codex`"")
$out.Add('wire_api = "responses"')
$out.Add("supports_websockets = $wsValue")
$out.Add('requires_openai_auth = true')
$out.Add('env_key = "CODEX_LB_API_KEY"')
$out.Add('# <<< codexlb <<<')

Set-Content -Path $config -Value $out -Encoding UTF8
Say "Zapisalem $config."

$prof = @(
	'# Profil "codexlb" - zarzadzane przez codexlb-setup.ps1.',
	'# Uzycie: codex --profile codexlb',
	"model = `"$Model`"",
	'model_provider = "codex-lb"',
	"model_reasoning_effort = `"$Effort`""
)
Set-Content -Path $profFile -Value $prof -Encoding UTF8
Say "Zapisalem profil $profFile."

# ------------------------------------------------------------------- test
if ($Test) {
	if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
		Say ''
		Say '[Uwaga] Nie znaleziono polecenia codex w PATH.'
		Say 'Konfiguracja zostala zapisana. Aby wykonac test, zainstaluj Codex CLI:'
		Say '    npm install -g @openai/codex'
	} else {
		Say 'Probne zapytanie przez proxy (moze chwile potrwac)...'
		$prevEap = $ErrorActionPreference
		$ErrorActionPreference = 'Continue'
		$outText = & codex exec --profile codexlb --skip-git-repo-check 'Odpowiedz jednym slowem: ok' 2>&1 | Out-String
		$ErrorActionPreference = $prevEap
		Write-Host ($outText.Trim())
		if ($outText -match 'No available accounts|usage limit|owner account is unavailable|429') {
			Say ''
			Say 'Uwaga: polaczenie i klucz sa dobre - to konta ChatGPT sa na limicie.'
		} elseif ($outText -match 'invalid_api_key|Missing environment variable') {
			Say ''
			Say 'Klucz nie dotarl do Codeksa - otworz nowe okno PowerShell i powtorz test.'
		}
	}
}

Say ''
Say 'Gotowe. Otworz NOWE okno terminala / zrestartuj VS Code, zeby zobaczyly klucz.'
if (-not $ProfileOnly) { Say '    codex                      # codexlb jest teraz domyslny' }
Say '    codex --profile codexlb    # jawnie przez proxy'
