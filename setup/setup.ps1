# setup.ps1 — konfiguracja klienta Claude pod Claude-LB / TeamClaude na Windows / PowerShell.
#
# Jeśli w systemie jest Node.js, deleguje zadanie do uniwersalnego setup.js.
# W przeciwnym wypadku wykonuje natywne kroki w PowerShellu (CLI, VS Code, rejestr zmiennych).
#
# Użycie (PowerShell, zwykły użytkownik):
#   .\setup.ps1
#   .\setup.ps1 -Test
#   .\setup.ps1 -Url https://your-server.com
#   .\setup.ps1 -Key tc-...

[CmdletBinding()]
param(
	[switch]$Test,
	[string]$Url = '',
	[string]$Key = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Url) {
	if ($env:CLAUDE_LB_URL) { $Url = $env:CLAUDE_LB_URL }
	elseif ($env:TEAMCLAUDE_URL) { $Url = $env:TEAMCLAUDE_URL }
	else { $Url = 'http://localhost:3456' }
}
$Url = $Url.TrimEnd('/')

# Delegacja do node jeśli dostępny
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$jsScript = Join-Path $PSScriptRoot "setup.js"
if (-not (Test-Path $jsScript)) {
	$jsScript = Join-Path $PSScriptRoot "teamclaude-setup.js"
}
if ($nodeCmd -and (Test-Path $jsScript)) {
	$nodeArgs = @($jsScript, "--url", $Url)
	if ($Key) { $nodeArgs += @("--key", $Key) }
	if ($Test) { $nodeArgs += "--test" }
	& node $nodeArgs
	exit $LASTEXITCODE
}

function Say($msg) { Write-Host $msg }

# ---------------------------------------------------------------- klucz API
if (-not $Key) {
	if ($env:CLAUDE_LB_API_KEY) { $Key = $env:CLAUDE_LB_API_KEY }
	elseif ($env:TEAMCLAUDE_API_KEY) { $Key = $env:TEAMCLAUDE_API_KEY }
	elseif ($env:ANTHROPIC_API_KEY) { $Key = $env:ANTHROPIC_API_KEY }
}
if (-not $Key) {
	$secure = Read-Host -Prompt "Klucz API z Claude-LB / TeamClaude ($Url), wklej i Enter" -AsSecureString
	$Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
		[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $Key) { throw 'Nie podano klucza.' }

# ------------------------------------------------------- sprawdzenie klucza
Say "Sprawdzam połączenie i klucz na $Url ..."
try {
	$statusUri = "$Url/teamclaude/status"
	try {
		$resp = Invoke-WebRequest -Uri $statusUri -Method Get `
			-Headers @{ "x-api-key" = $Key } -TimeoutSec 15 -UseBasicParsing
	} catch {
		if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
			$resp = Invoke-WebRequest -Uri "$Url/status" -Method Get `
				-Headers @{ "x-api-key" = $Key } -TimeoutSec 15 -UseBasicParsing
		} else {
			throw $_
		}
	}
	if ($resp.StatusCode -ne 200) { throw "nieoczekiwana odpowiedz $($resp.StatusCode)" }
	Say 'OK — klucz działa, proxy Claude-LB odpowiada.'
} catch {
	$code = $null
	if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
	switch ($code) {
		401 { throw 'Serwer odrzucił klucz (401). Sprawdź klucz w Claude-LB.' }
		403 { throw 'Serwer odrzucił klucz (403). Sprawdź klucz w Claude-LB.' }
		default {
			throw "Brak połączenia z $Url ($($_.Exception.Message)). Sprawdź połączenie sieciowe."
		}
	}
}

# -------------------------------------------------- zabezpieczenie OAuth
$credsPath = Join-Path $HOME ".claude\.credentials.json"
if (Test-Path $credsPath) {
	$bak = "$credsPath.bak-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
	Move-Item -Path $credsPath -Destination $bak -Force
	Say "[OK] Wykryto starą sesję logowania OAuth. Zrobiono kopię ($([System.IO.Path]::GetFileName($bak))) i wyczyszczono sesję (brak błędu 'Auth conflict')."
}

# -------------------------------------------------- ~/.claude/settings.json
$claudeDir = Join-Path $HOME ".claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }
$claudeSettingsPath = Join-Path $claudeDir "settings.json"
$claudeSettings = @{}
if (Test-Path $claudeSettingsPath) {
	try {
		$claudeSettings = Get-Content -Raw -Path $claudeSettingsPath | ConvertFrom-Json -AsHashtable
	} catch {}
}
if (-not $claudeSettings.ContainsKey("env")) { $claudeSettings["env"] = @{} }
$claudeSettings["env"]["ANTHROPIC_BASE_URL"] = $Url
$claudeSettings["env"]["ANTHROPIC_API_KEY"]  = $Key
$claudeSettings | ConvertTo-Json -Depth 10 | Set-Content -Path $claudeSettingsPath -Encoding utf8
Say "[OK] Zaktualizowano $claudeSettingsPath (CLI Claude Code)."

# -------------------------------------------------- VS Code settings.json
$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\Roaming" }
$vsCodeDir = Join-Path $appData "Code\User"
$vsCodeSettingsPath = Join-Path $vsCodeDir "settings.json"
if (Test-Path $vsCodeDir) {
	try {
		$vsSettings = @{}
		if (Test-Path $vsCodeSettingsPath) {
			$vsSettings = Get-Content -Raw -Path $vsCodeSettingsPath | ConvertFrom-Json -AsHashtable
		}
		$vsSettings["claudeCode.environmentVariables"] = @(
			@{ name = "ANTHROPIC_BASE_URL"; value = $Url },
			@{ name = "ANTHROPIC_API_KEY";  value = $Key }
		)
		$vsSettings | ConvertTo-Json -Depth 10 | Set-Content -Path $vsCodeSettingsPath -Encoding utf8
		Say "[OK] Zaktualizowano ustawienia oficjalnego rozszerzenia Claude Code w VS Code ($vsCodeSettingsPath)."
	} catch {
		Say "[Uwaga] Nie udało się zaktualizować VS Code: $($_.Exception.Message)"
	}
}

# --------------------------------------------------- zmienne środowiskowe
Say "Ustawiam zmienne środowiskowe użytkownika Windows..."
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $Url, 'User')
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $Key, 'User')
$env:ANTHROPIC_BASE_URL = $Url
$env:ANTHROPIC_API_KEY  = $Key
Say "[OK] Zapisano zmienne ANTHROPIC_BASE_URL i ANTHROPIC_API_KEY w profilu użytkownika."

# ------------------------------------------------------------------- test
if ($Test) {
	Say "Próbne wywołanie claude --version..."
	try {
		$oldPref = $ErrorActionPreference
		$ErrorActionPreference = 'Continue'
		& claude --version
		$ErrorActionPreference = $oldPref
	} catch {
		Say "[Uwaga] Nie można uruchomić 'claude': $($_.Exception.Message)"
	}
}

Say ""
Say "=== Gotowe! ==="
Say "Zrestartuj otwarte okna VS Code lub terminale, aby wczytały nowe zmienne środowiskowe."
