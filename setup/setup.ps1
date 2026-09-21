# setup.ps1 — konfiguracja klienta Claude i Codex pod Agent-LB na Windows / PowerShell.
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
	[switch]$Uninstall,
	[string]$Url = '',
	[string]$Key = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Url) {
	if ($env:AGENT_LB_URL) { $Url = $env:AGENT_LB_URL }
	elseif ($env:AGENTLB_URL) { $Url = $env:AGENTLB_URL }
	elseif ($env:CLAUDE_LB_URL) { $Url = $env:CLAUDE_LB_URL }
	else { $Url = 'http://localhost:3456' }
}
$Url = $Url.TrimEnd('/')

# Delegacja do node jeśli dostępny i uruchomiono z lokalnego repozytorium
if ($PSScriptRoot) {
	$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
	$jsScript = Join-Path $PSScriptRoot "setup.js"
	if ($nodeCmd -and (Test-Path $jsScript)) {
		$nodeArgs = @($jsScript, "--url", $Url)
		if ($Uninstall) { $nodeArgs += '--uninstall' }
		if ($Key) { $nodeArgs += @("--key", $Key) }
		if ($Test) { $nodeArgs += "--test" }
		& node $nodeArgs
		exit $LASTEXITCODE
	}
}

function Say($msg) { Write-Host $msg }

function Backup-ConfigFile([string]$Path) {
	if (-not (Test-Path $Path)) { return }
	$backup = "$Path.bak-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
	try { Copy-Item -LiteralPath $Path -Destination $backup -ErrorAction Stop }
	catch { Say "[Uwaga] Nie udało się utworzyć kopii ${Path}: $($_.Exception.Message)" }
}

function Set-CustomHeader([string]$existing, [string]$name, [string]$value) {
	$lines = @()
	if ($existing) {
		$lines = @($existing -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" -and -not $_.ToLower().StartsWith("$($name.ToLower()):") })
	}
	$lines += "$name`: $value"
	return ($lines -join "`n")
}

function Remove-CustomHeader([string]$existing, [string]$name) {
	if (-not $existing) { return $null }
	$lines = @($existing -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" -and -not $_.ToLower().StartsWith("$($name.ToLower()):") })
	if ($lines.Count -gt 0) { return ($lines -join "`n") }
	return $null
}

if ($Uninstall) {
	$homeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { '.' }
	foreach ($p in @(
		(Join-Path $homeDir '.config\agent-lb.env'),
		(Join-Path $homeDir '.config\claude-lb.env')
	)) { try { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } catch { Say "[Uwaga] Nie udało się usunąć $p" } }
	$settingsPath = Join-Path $homeDir '.claude\settings.json'
	if (Test-Path $settingsPath) {
		try {
			$data = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json -AsHashtable
			if ($data.env -is [hashtable]) { $data.env.Remove('ANTHROPIC_BASE_URL'); $data.env.Remove('ANTHROPIC_API_KEY'); $data.env.Remove('ANTHROPIC_CUSTOM_HEADERS') }
			if ($data.env -is [hashtable]) {
				$data.env.Remove('ANTHROPIC_BASE_URL')
				$data.env.Remove('ANTHROPIC_API_KEY')
				$existingHdr = if ($data.env.ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $data.env['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
				$rem = Remove-CustomHeader $existingHdr 'x-api-key'
				if ($rem) { $data.env['ANTHROPIC_CUSTOM_HEADERS'] = $rem }
				else { $data.env.Remove('ANTHROPIC_CUSTOM_HEADERS') }
			}
			Backup-ConfigFile $settingsPath
			$data | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding utf8
		} catch { Say "[Uwaga] Nie udało się zaktualizować $settingsPath" }
	}
	$vsAppData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $homeDir 'AppData\Roaming' }
	$vsPath = Join-Path $vsAppData 'Code\User\settings.json'
	if (Test-Path $vsPath) {
		try {
			$vs = Get-Content -Raw -Path $vsPath | ConvertFrom-Json -AsHashtable
			$vs.Remove('claudeCode.environmentVariables')
			if ($vs.ContainsKey('claudeCode.environmentVariables')) {
				$envVars = @($vs['claudeCode.environmentVariables']) | Where-Object { $_.name -ne 'ANTHROPIC_BASE_URL' -and $_.name -ne 'ANTHROPIC_API_KEY' }
				$existingHdr = ($vs['claudeCode.environmentVariables'] | Where-Object { $_.name -eq 'ANTHROPIC_CUSTOM_HEADERS' }).value
				$rem = Remove-CustomHeader $existingHdr 'x-api-key'
				$envVars = @($envVars | Where-Object { $_.name -ne 'ANTHROPIC_CUSTOM_HEADERS' })
				if ($rem) { $envVars += @{ name = 'ANTHROPIC_CUSTOM_HEADERS'; value = $rem } }
				if ($envVars.Count -gt 0) { $vs['claudeCode.environmentVariables'] = $envVars }
				else { $vs.Remove('claudeCode.environmentVariables') }
			}
			$vs.Remove('claudeCode.disableLoginPrompt')
			Backup-ConfigFile $vsPath
			$vs | ConvertTo-Json -Depth 20 | Set-Content -Path $vsPath -Encoding utf8
		} catch { Say "[Uwaga] Nie udało się zaktualizować $vsPath" }
	}
	try {
		[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
		[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')
		[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $null, 'User')
		$currentWinHdr = [Environment]::GetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', 'User')
		$remWin = Remove-CustomHeader $currentWinHdr 'x-api-key'
		[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $remWin, 'User')
		[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $null, 'User')
		[Environment]::SetEnvironmentVariable('CODEX_BASE_URL', $null, 'User')
		[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', $null, 'User')
		[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $null, 'User')
		[Environment]::SetEnvironmentVariable('AGENT_LB_API_KEY', $null, 'User')
	} catch { Say '[Uwaga] Nie udało się usunąć zmiennych środowiskowych Windows.' }
	Say 'Usunięto ustawienia Agent-LB. Plik .credentials.json pozostawiono bez zmian.'
	exit 0
}

# ---------------------------------------------------------------- klucz API
if (-not $Key) {
	if ($env:AGENT_LB_API_KEY) { $Key = $env:AGENT_LB_API_KEY }
	elseif ($env:AGENTLB_API_KEY) { $Key = $env:AGENTLB_API_KEY }
	elseif ($env:CLAUDE_LB_API_KEY) { $Key = $env:CLAUDE_LB_API_KEY }
	elseif ($env:CODEX_LB_API_KEY) { $Key = $env:CODEX_LB_API_KEY }
	elseif ($env:ANTHROPIC_CUSTOM_HEADERS) {
		foreach ($line in ($env:ANTHROPIC_CUSTOM_HEADERS -split "`r?`n")) {
			if ($line -match '^\s*x-api-key\s*:\s*(.+?)\s*$') { $Key = $Matches[1]; break }
		}
	}
	elseif ($env:ANTHROPIC_API_KEY) { $Key = $env:ANTHROPIC_API_KEY }
}
if (-not $Key) {
	$secure = Read-Host -Prompt "Klucz API z Agent LB ($Url), wklej i Enter" -AsSecureString
	$Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
		[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($Key) { $Key = $Key.Trim() }
if (-not $Key) { throw 'Nie podano klucza.' }
if ($Key -match '[\r\n]') { throw 'Klucz API nie może zawierać znaku nowej linii.' }

# ------------------------------------------------------- sprawdzenie klucza
Say "Sprawdzam połączenie i klucz na $Url ..."
try {
	$statusUri = "$Url/agent-lb/status"
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
	Say 'OK — klucz działa, proxy Agent-LB odpowiada.'
} catch {
	$code = $null
	if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
	switch ($code) {
		401 { throw 'Serwer odrzucił klucz (401). Sprawdź klucz w Agent-LB.' }
		403 { throw 'Serwer odrzucił klucz (403). Sprawdź klucz w Agent-LB.' }
		default {
			throw "Brak połączenia z $Url ($($_.Exception.Message)). Sprawdź połączenie sieciowe."
		}
	}
}

# -------------------------------------------------- zabezpieczenie OAuth
$homeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { '.' }
$credsPath = Join-Path $homeDir ".claude\.credentials.json"
$oauthSession = $false
if (Test-Path $credsPath) {
	try {
		$cred = Get-Content -Raw -Path $credsPath | ConvertFrom-Json
		$oauth = if ($cred.claudeAiOauth) { $cred.claudeAiOauth } elseif ($cred.oauth) { $cred.oauth } else { $cred }
		$oauthSession = [bool]($oauth.accessToken -is [string] -and $oauth.accessToken.Length -gt 0)
	} catch { $oauthSession = $false }
	$bak = "$credsPath.bak-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
	try {
		Copy-Item -Path $credsPath -Destination $bak -Force -ErrorAction Stop
		Say "[OK] Wykryto sesję logowania OAuth. Zrobiono kopię zapasową ($([System.IO.Path]::GetFileName($bak)))."
	} catch { Say '[Uwaga] Nie udało się utworzyć kopii .credentials.json; plik pozostawiono bez zmian.' }
}
if ($oauthSession) { Say '[OK] Zachowuję tryb OAuth Claude Code; klucz proxy przekazuję przez ANTHROPIC_CUSTOM_HEADERS.' }

# -------------------------------------------------- ~/.claude/settings.json
$claudeDir = Join-Path $homeDir ".claude"
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
if ($oauthSession) {
	$claudeSettings["env"].Remove('ANTHROPIC_API_KEY')
	$claudeSettings["env"]["ANTHROPIC_CUSTOM_HEADERS"] = "x-api-key: $Key"
	$existingHdr = if ($claudeSettings["env"].ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
	$claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] = Set-CustomHeader $existingHdr 'x-api-key' $Key
} else {
	$claudeSettings["env"]["ANTHROPIC_API_KEY"] = $Key
	$claudeSettings["env"].Remove('ANTHROPIC_CUSTOM_HEADERS')
	$claudeSettings["env"]['ANTHROPIC_API_KEY'] = $Key
	$existingHdr = if ($claudeSettings["env"].ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
	$rem = Remove-CustomHeader $existingHdr 'x-api-key'
	if ($rem) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] = $rem }
	else { $claudeSettings["env"].Remove('ANTHROPIC_CUSTOM_HEADERS') }
}
$null = Backup-ConfigFile $claudeSettingsPath
$claudeSettings | ConvertTo-Json -Depth 10 | Set-Content -Path $claudeSettingsPath -Encoding utf8
Say "[OK] Zaktualizowano $claudeSettingsPath (CLI Claude Code)."

# -------------------------------------------------- VS Code settings.json
$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $homeDir "AppData\Roaming" }
$vsCodeDir = Join-Path $appData "Code\User"
$vsCodeSettingsPath = Join-Path $vsCodeDir "settings.json"
if (Test-Path $vsCodeDir) {
	try {
		$vsSettings = @{}
		if (Test-Path $vsCodeSettingsPath) {
			$vsSettings = Get-Content -Raw -Path $vsCodeSettingsPath | ConvertFrom-Json -AsHashtable
		}
		$vsSettings["claudeCode.disableLoginPrompt"] = $true
		$claudeEnvironmentVariables = @(@{ name = "ANTHROPIC_BASE_URL"; value = $Url })
		if ($oauthSession) { $claudeEnvironmentVariables += @{ name = "ANTHROPIC_CUSTOM_HEADERS"; value = "x-api-key: $Key" } }
		else { $claudeEnvironmentVariables += @{ name = "ANTHROPIC_API_KEY"; value = $Key } }
		$claudeEnvironmentVariables = if ($vsSettings.ContainsKey("claudeCode.environmentVariables")) {
			@($vsSettings["claudeCode.environmentVariables"]) | Where-Object { $_.name -ne "ANTHROPIC_BASE_URL" }
		} else { @() }
		$claudeEnvironmentVariables += @{ name = "ANTHROPIC_BASE_URL"; value = $Url }
		if ($oauthSession) {
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_API_KEY" })
			$existingHdr = ($claudeEnvironmentVariables | Where-Object { $_.name -eq "ANTHROPIC_CUSTOM_HEADERS" }).value
			$updatedHdr = Set-CustomHeader $existingHdr "x-api-key" $Key
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_CUSTOM_HEADERS" })
			$claudeEnvironmentVariables += @{ name = "ANTHROPIC_CUSTOM_HEADERS"; value = $updatedHdr }
		} else {
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_API_KEY" })
			$claudeEnvironmentVariables += @{ name = "ANTHROPIC_API_KEY"; value = $Key }
			$existingHdr = ($claudeEnvironmentVariables | Where-Object { $_.name -eq "ANTHROPIC_CUSTOM_HEADERS" }).value
			$rem = Remove-CustomHeader $existingHdr "x-api-key"
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_CUSTOM_HEADERS" })
			if ($rem) { $claudeEnvironmentVariables += @{ name = "ANTHROPIC_CUSTOM_HEADERS"; value = $rem } }
		}
		$vsSettings["claudeCode.environmentVariables"] = $claudeEnvironmentVariables
		$null = Backup-ConfigFile $vsCodeSettingsPath
		$vsSettings | ConvertTo-Json -Depth 10 | Set-Content -Path $vsCodeSettingsPath -Encoding utf8
		Say "[OK] Zaktualizowano ustawienia oficjalnego rozszerzenia Claude Code w VS Code ($vsCodeSettingsPath)."
	} catch {
		Say "[Uwaga] Nie udało się zaktualizować VS Code: $($_.Exception.Message)"
	}
}

# -------------------------------------------------- ~/.codex/config.toml (Codex CLI)
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $homeDir '.codex' }
if (-not (Test-Path $codexHome)) { New-Item -ItemType Directory -Path $codexHome -Force | Out-Null }
$codexToml = Join-Path $codexHome 'config.toml'
$existingToml = if (Test-Path $codexToml) { Get-Content -Raw -Path $codexToml } else { '' }
if ($existingToml -notmatch 'model_providers\.codex-lb') {
	$tomlAppend = @"

# >>> codexlb >>> (zarzadzane przez setup.ps1)
[model_providers.codex-lb]
name = "openai"
base_url = "$Url/backend-api/codex"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = true
env_key = "CODEX_LB_API_KEY"

[profiles.codexlb]
model = "gpt-5.6-sol"
model_provider = "codex-lb"
model_reasoning_effort = "xhigh"
# <<< codexlb <<<
"@
	Add-Content -Path $codexToml -Value $tomlAppend -Encoding utf8
	Say "[OK] Zaktualizowano $codexToml (profil codexlb dla Codex CLI)."
}

# --------------------------------------------------- zmienne środowiskowe
Say "Ustawiam zmienne środowiskowe użytkownika Windows..."
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $Url, 'User')
if ($oauthSession) {
	[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')
	[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', "x-api-key: $Key", 'User')
	$currentWinHdr = [Environment]::GetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', 'User')
	$newWinHdr = Set-CustomHeader $currentWinHdr "x-api-key" $Key
	[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $newWinHdr, 'User')
} else {
	[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $Key, 'User')
	[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $null, 'User')
	$currentWinHdr = [Environment]::GetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', 'User')
	$remWin = Remove-CustomHeader $currentWinHdr "x-api-key"
	[Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $remWin, 'User')
}
[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('AGENT_LB_API_KEY', $Key, 'User')
[Environment]::SetEnvironmentVariable('CODEX_BASE_URL', "$Url/backend-api/codex", 'User')
[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', "$Url/v1", 'User')
$env:ANTHROPIC_BASE_URL = $Url
if ($oauthSession) {
	Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
	$env:ANTHROPIC_CUSTOM_HEADERS = "x-api-key: $Key"
	$env:ANTHROPIC_CUSTOM_HEADERS = Set-CustomHeader $env:ANTHROPIC_CUSTOM_HEADERS "x-api-key" $Key
} else {
	$env:ANTHROPIC_API_KEY = $Key
	Remove-Item Env:ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue
	$remProcessHdr = Remove-CustomHeader $env:ANTHROPIC_CUSTOM_HEADERS "x-api-key"
	if ($remProcessHdr) { $env:ANTHROPIC_CUSTOM_HEADERS = $remProcessHdr }
	else { Remove-Item Env:ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue }
}
$env:CODEX_LB_API_KEY   = $Key
$env:OPENAI_API_KEY     = $Key
$env:AGENT_LB_API_KEY   = $Key
$env:CODEX_BASE_URL     = "$Url/backend-api/codex"
$env:OPENAI_BASE_URL    = "$Url/v1"
Say "[OK] Zapisano zmienne środowiskowe w profilu użytkownika."

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
