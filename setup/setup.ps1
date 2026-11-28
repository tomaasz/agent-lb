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
	[switch]$NoInstall,
	[switch]$WithAgylb,
	[string]$Url = '',
	[string]$Key = '',
	[string]$Lang = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Lang) {
	if ($env:AGENT_LB_LANG) { $Lang = $env:AGENT_LB_LANG }
	elseif ((Get-Culture).TwoLetterISOLanguageName -eq 'pl') { $Lang = 'pl' }
	else { $Lang = 'en' }
}

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
		$nodeArgs = @($jsScript, "--url", $Url, "--lang", $Lang)
		if ($Uninstall) { $nodeArgs += '--uninstall' }
		if ($NoInstall) { $nodeArgs += '--no-install' }
		if ($WithAgylb) { $nodeArgs += '--with-agylb' }
		if ($Key) { $nodeArgs += @("--key", $Key) }
		if ($Test) { $nodeArgs += "--test" }
		& node $nodeArgs
		exit $LASTEXITCODE
	}
}

function Say($msg) { Write-Host $msg }

function Check-And-Ensure-Node {
	if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
		$nv = try { & node --version 2>$null } catch { "" }
		Say "[OK] Node.js $nv i npm są dostępne w systemie."
		return
	}

	Say "[Wykryto brak] Node.js lub npm nie są zainstalowane w systemie Windows."
	if ($NoInstall) {
		Say "  -> Pominięto instalację Node.js (-NoInstall)."
		return
	}

	if (Get-Command winget -ErrorAction SilentlyContinue) {
		Say "  -> Wykryto winget. Próbuję zainstalować Node.js LTS automatycznie..."
		try {
			& winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
			Say "[OK] Pomyślnie zainstalowano Node.js. Zrestartuj terminal, aby odświeżyć zmienne PATH."
		} catch {
			Say "  [Uwaga] Nie udało się zainstalować przez winget: $($_.Exception.Message)"
		}
	} else {
		Say "  [Instrukcja] Pobierz i zainstaluj Node.js ze strony: https://nodejs.org/"
	}
}

function Ensure-CliPackage([string]$cmdName, [string]$pkgName, [string]$title) {
	if (Get-Command $cmdName -ErrorAction SilentlyContinue) {
		$ver = try { & $cmdName --version 2>$null } catch { "OK" }
		Say "[OK] $title ($cmdName) jest zainstalowany: $ver"
		return
	}

	Say "[Wykryto brak] $title ($cmdName) nie jest zainstalowany."
	if ($NoInstall) {
		Say "  -> Pominięto instalację ($title) (-NoInstall). Zainstaluj ręcznie: npm install -g $pkgName"
		return
	}

	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		Say "  [Uwaga] Brak npm w PATH. Nie można automatycznie zainstalować $pkgName."
		return
	}

	Say "  -> Instaluję $title ($pkgName)..."
	try {
		& npm install -g $pkgName
		if (Get-Command $cmdName -ErrorAction SilentlyContinue) {
			Say "[OK] Pomyślnie zainstalowano $title ($cmdName)."
		} else {
			Say "[OK] Instalacja zakończona (jeśli polecenie nie jest widoczne, zrestartuj okno PowerShell)."
		}
	} catch {
		Say "  [Uwaga] Błąd instalacji $pkgName`: $($_.Exception.Message)"
	}
}

function Check-WslIntegration([string]$serverUrl) {
	$wslCmd = Get-Command wsl -ErrorAction SilentlyContinue
	if (-not $wslCmd) { return }
	try {
		$wslOutput = & wsl.exe -l -q 2>$null
		$distros = @($wslOutput | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
		if ($distros.Count -gt 0) {
			$distroStr = $distros -join ', '
			Say ""
			Say "----------------------------------------------------------------------"
			Say "💡 [WSL] Wykryto podsystem WSL w systemie Windows: $distroStr"
			Say "   Aby wdrożyć Claude i Codex również wewnątrz WSL (np. Debian/Ubuntu):"
			Say "   Otwórz terminal WSL i uruchom (instalator zapyta o klucz stacji):"
			Say "   curl -fsSL $serverUrl/setup.sh | bash -s -- --url $serverUrl"
			Say "----------------------------------------------------------------------"
		}
	} catch {}
}

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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
	$enc = [System.Text.UTF8Encoding]::new($false)
	[System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Strip-JsonComments([string]$Text) {
	if (-not $Text) { return '' }
	$sb = [System.Text.StringBuilder]::new($Text.Length)
	$inStr = $false; $esc = $false
	for ($i = 0; $i -lt $Text.Length; $i++) {
		$c = $Text[$i]
		$n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }
		if ($inStr) {
			[void]$sb.Append($c)
			if ($esc) { $esc = $false }
			elseif ($c -eq '\') { $esc = $true }
			elseif ($c -eq '"') { $inStr = $false }
			continue
		}
		if ($c -eq '"') { $inStr = $true; [void]$sb.Append($c); continue }
		if ($c -eq '/' -and $n -eq '/') {
			$i += 2
			while ($i -lt $Text.Length -and $Text[$i] -ne "`n" -and $Text[$i] -ne "`r") { $i++ }
			$i--
			continue
		}
		if ($c -eq '/' -and $n -eq '*') {
			$i += 2
			while ($i + 1 -lt $Text.Length -and -not ($Text[$i] -eq '*' -and $Text[$i + 1] -eq '/')) {
				if ($Text[$i] -eq "`n" -or $Text[$i] -eq "`r") { [void]$sb.Append($Text[$i]) }
				$i++
			}
			$i++
			continue
		}
		[void]$sb.Append($c)
	}
	$s2 = $sb.ToString()
	$out = [System.Text.StringBuilder]::new($s2.Length)
	$inStr = $false; $esc = $false
	for ($i = 0; $i -lt $s2.Length; $i++) {
		$c = $s2[$i]
		if ($inStr) {
			[void]$out.Append($c)
			if ($esc) { $esc = $false }
			elseif ($c -eq '\') { $esc = $true }
			elseif ($c -eq '"') { $inStr = $false }
			continue
		}
		if ($c -eq '"') { $inStr = $true; [void]$out.Append($c); continue }
		if ($c -eq ',') {
			$j = $i + 1
			while ($j -lt $s2.Length -and [char]::IsWhiteSpace($s2[$j])) { $j++ }
			if ($j -lt $s2.Length -and ($s2[$j] -eq '}' -or $s2[$j] -eq ']')) { continue }
		}
		[void]$out.Append($c)
	}
	return $out.ToString()
}

function ConvertTo-HashtableRecursive($Obj) {
	if ($null -eq $Obj) { return $null }
	if ($Obj -is [System.Collections.IDictionary]) {
		$ht = @{}
		foreach ($k in $Obj.Keys) { $ht[$k] = ConvertTo-HashtableRecursive $Obj[$k] }
		return $ht
	}
	if ($Obj -is [pscustomobject]) {
		$ht = @{}
		foreach ($prop in $Obj.PSObject.Properties) { $ht[$prop.Name] = ConvertTo-HashtableRecursive $prop.Value }
		return $ht
	}
	if ($Obj -is [System.Collections.IEnumerable] -and -not ($Obj -is [string])) {
		$arr = @()
		foreach ($item in $Obj) { $arr += ,(ConvertTo-HashtableRecursive $item) }
		return ,$arr
	}
	return $Obj
}

function Read-JsonHashtable([string]$Path) {
	$raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
	if (-not $raw.Trim()) { return @{} }
	$parsed = (Strip-JsonComments $raw) | ConvertFrom-Json
	$ht = ConvertTo-HashtableRecursive $parsed
	if (-not ($ht -is [hashtable])) { throw "Plik $Path nie zawiera obiektu JSON." }
	return $ht
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
			$data = Read-JsonHashtable $settingsPath
			if ($data.env -is [hashtable]) {
				$data.env.Remove('ANTHROPIC_BASE_URL')
				$data.env.Remove('ANTHROPIC_API_KEY')
				$existingHdr = if ($data.env.ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $data.env['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
				$rem = Remove-CustomHeader $existingHdr 'x-api-key'
				if ($rem) { $data.env['ANTHROPIC_CUSTOM_HEADERS'] = $rem }
				else { $data.env.Remove('ANTHROPIC_CUSTOM_HEADERS') }
			}
			Write-Utf8NoBom $settingsPath (($data | ConvertTo-Json -Depth 20) + "`n")
		} catch { Say "[Uwaga] Nie udało się zaktualizować $settingsPath" }
	}
	$vsAppData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $homeDir 'AppData\Roaming' }
	foreach ($ideDir in @('Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Antigravity')) {
		$vsPath = Join-Path $vsAppData "$ideDir\User\settings.json"
		if (-not (Test-Path $vsPath)) { continue }
		try {
			$vs = Read-JsonHashtable $vsPath
			if ($vs.ContainsKey('claudeCode.environmentVariables')) {
				$envVars = @($vs['claudeCode.environmentVariables'] | Where-Object { $_ -and $_.name -ne 'ANTHROPIC_BASE_URL' -and $_.name -ne 'ANTHROPIC_API_KEY' -and $_.name -ne 'ANTHROPIC_AUTH_TOKEN' })
				$existingHdr = ($envVars | Where-Object { $_.name -eq 'ANTHROPIC_CUSTOM_HEADERS' } | Select-Object -First 1).value
				$rem = Remove-CustomHeader $existingHdr 'x-api-key'
				$envVars = @($envVars | Where-Object { $_.name -ne 'ANTHROPIC_CUSTOM_HEADERS' })
				if ($rem) { $envVars += @{ name = 'ANTHROPIC_CUSTOM_HEADERS'; value = $rem } }
				if ($envVars.Count -gt 0) { $vs['claudeCode.environmentVariables'] = $envVars }
				else { $vs.Remove('claudeCode.environmentVariables') }
			}
			$vs.Remove('claudeCode.disableLoginPrompt')
			$vs.Remove('claudeCode.hideOnboarding')
			Write-Utf8NoBom $vsPath (($vs | ConvertTo-Json -Depth 20) + "`n")
		} catch { Say "[Uwaga] Nie udało się zaktualizować $vsPath" }
	}
	$codexTomlPath = Join-Path (if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $homeDir '.codex' }) 'config.toml'
	if (Test-Path $codexTomlPath) {
		try {
			$rawToml = [System.IO.File]::ReadAllText($codexTomlPath, [System.Text.Encoding]::UTF8)
			$cleanToml = [regex]::Replace($rawToml, '(?ms)^# >>> codexlb.*?^# <<< codexlb[^\r\n]*\r?\n?', '').Trim()
			Write-Utf8NoBom $codexTomlPath $(if ($cleanToml) { "$cleanToml`n" } else { '' })
		} catch { Say "[Uwaga] Nie udało się wyczyścić $codexTomlPath" }
	}
	$aiderPath = Join-Path $homeDir '.aider.conf.yml'
	if (Test-Path $aiderPath) {
		try {
			$rawAider = [System.IO.File]::ReadAllText($aiderPath, [System.Text.Encoding]::UTF8)
			$cleanAider = [regex]::Replace($rawAider, '(?ms)^# >>> agentlb.*?^# <<< agentlb[^\r\n]*\r?\n?', '').Trim()
			Write-Utf8NoBom $aiderPath $(if ($cleanAider) { "$cleanAider`n" } else { '' })
		} catch { Say "[Uwaga] Nie udało się wyczyścić $aiderPath" }
	}
	$ocCfgPath = Join-Path $homeDir '.config\opencode\opencode.json'
	if (Test-Path $ocCfgPath) {
		try {
			$oc = Read-JsonHashtable $ocCfgPath
			$changed = $false
			if ($oc.ContainsKey('provider') -and ($oc['provider'] -is [hashtable]) -and $oc['provider'].ContainsKey('agentlb')) { $oc['provider'].Remove('agentlb'); $changed = $true }
			if ($oc.ContainsKey('providers') -and ($oc['providers'] -is [hashtable]) -and $oc['providers'].ContainsKey('agentlb')) { $oc['providers'].Remove('agentlb'); $changed = $true }
			if ($changed) { Write-Utf8NoBom $ocCfgPath (($oc | ConvertTo-Json -Depth 20) + "`n") }
		} catch { Say "[Uwaga] Nie udało się wyczyścić $ocCfgPath" }
	}
	foreach ($ocAuthPath in @((Join-Path $homeDir '.local\share\opencode\auth.json'), (Join-Path $vsAppData 'opencode\auth.json'))) {
		if (-not (Test-Path $ocAuthPath)) { continue }
		try {
			$ocA = Read-JsonHashtable $ocAuthPath
			if ($ocA.ContainsKey('agentlb')) {
				$ocA.Remove('agentlb')
				Write-Utf8NoBom $ocAuthPath (($ocA | ConvertTo-Json -Depth 20) + "`n")
			}
		} catch { Say "[Uwaga] Nie udało się wyczyścić $ocAuthPath" }
	}
	$clawPath = Join-Path $homeDir '.openclaw\openclaw.json'
	if (Test-Path $clawPath) {
		try {
			$claw = Read-JsonHashtable $clawPath
			if ($claw.ContainsKey('models') -and ($claw['models'] -is [hashtable]) -and $claw['models'].ContainsKey('providers') -and ($claw['models']['providers'] -is [hashtable]) -and $claw['models']['providers'].ContainsKey('agentlb')) {
				$claw['models']['providers'].Remove('agentlb')
				Write-Utf8NoBom $clawPath (($claw | ConvertTo-Json -Depth 20) + "`n")
			}
		} catch { Say "[Uwaga] Nie udało się wyczyścić $clawPath" }
	}
	$hermesEnv = Join-Path $homeDir '.hermes\.env'
	if (Test-Path $hermesEnv) {
		try {
			$hLines = @([System.IO.File]::ReadAllLines($hermesEnv, [System.Text.Encoding]::UTF8) | Where-Object { $_ -notmatch '^\s*(?:export\s+)?(AGENT_LB_URL|AGENT_LB_API_KEY)=' })
			Write-Utf8NoBom $hermesEnv $(if ($hLines.Count -gt 0) { ($hLines -join "`n") + "`n" } else { '' })
		} catch { Say "[Uwaga] Nie udało się wyczyścić $hermesEnv" }
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
if ($Key -and ($Key -match '^<.*>$' -or $Key -eq '<KLUCZ_STACJI>' -or $Key -eq '<KEY>' -or $Key -eq '<TWÓJ_KLUCZ>')) {
	$Key = ''
}
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
if ($Key -and ($Key -match '^<.*>$' -or $Key -eq '<KLUCZ_STACJI>' -or $Key -eq '<KEY>' -or $Key -eq '<TWÓJ_KLUCZ>')) {
	$Key = ''
}
if (-not $Key) {
	$secure = Read-Host -Prompt "Klucz API z Agent LB ($Url), wklej i Enter" -AsSecureString
	$Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
		[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($Key) { $Key = $Key.Trim() }
if (-not $Key) { throw 'Nie podano klucza.' }
if ($Key -match '^<.*>$' -or $Key -eq '<KLUCZ_STACJI>' -or $Key -eq '<KEY>' -or $Key -eq '<TWÓJ_KLUCZ>') {
	throw "Podano placeholder zamiast rzeczywistego klucza stacji. Podaj prawidłowy klucz wygenerowany w panelu $Url."
}
if ($Key -match '[\r\n]') { throw 'Klucz API nie może zawierać znaku nowej linii.' }

# ------------------------------------------------------- sprawdzenie klucza
Say "Sprawdzam połączenie i autoryzację klucza na $Url ..."
try {
	$statusUri = "$Url/v1/models"
	try {
		$resp = Invoke-WebRequest -Uri $statusUri -Method Get `
			-Headers @{ "Authorization" = "Bearer $Key"; "x-api-key" = $Key } -TimeoutSec 15 -UseBasicParsing
	} catch {
		if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
			$resp = Invoke-WebRequest -Uri "$Url/backend-api/codex/models" -Method Get `
				-Headers @{ "Authorization" = "Bearer $Key"; "x-api-key" = $Key } -TimeoutSec 15 -UseBasicParsing
		} else {
			throw $_
		}
	}
	if ($resp.StatusCode -ne 200) { throw "nieoczekiwana odpowiedz $($resp.StatusCode)" }
	Say 'OK — klucz poprawny, proxy autoryzowało dostęp.'
} catch {
	$code = $null
	if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
	switch ($code) {
		401 { throw "Serwer odrzucił klucz (401). Podaj prawidłowy klucz stacji roboczej (znajdziesz go w panelu $Url)." }
		403 { throw "Serwer odrzucił klucz (403). Podaj prawidłowy klucz stacji roboczej (znajdziesz go w panelu $Url)." }
		default {
			throw "Brak połączenia z $Url ($($_.Exception.Message)). Sprawdź połączenie sieciowe."
		}
	}
}

# -------------------------------------------------- weryfikacja i instalacja CLI
Say ""
Say "--- Weryfikacja środowiska i instalacja narzędzi CLI ---"
Check-And-Ensure-Node
Ensure-CliPackage "claude" "@anthropic-ai/claude-code" "Claude Code CLI"
Ensure-CliPackage "codex" "@openai/codex" "OpenAI Codex CLI"
Check-WslIntegration $Url
Say "--------------------------------------------------------"
Say ""

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
$claudeOk = $true
if (Test-Path $claudeSettingsPath) {
	try {
		$claudeSettings = Read-JsonHashtable $claudeSettingsPath
	} catch {
		Say "[Uwaga] Nie można sparsować ${claudeSettingsPath}: $($_.Exception.Message). Pomijam, aby nie nadpisać pliku."
		$claudeOk = $false
	}
}
if ($claudeOk) {
	if (-not $claudeSettings.ContainsKey("env") -or -not ($claudeSettings["env"] -is [hashtable])) { $claudeSettings["env"] = @{} }
	$claudeSettings["env"]["ANTHROPIC_BASE_URL"] = $Url
	if ($oauthSession) {
		$claudeSettings["env"].Remove('ANTHROPIC_API_KEY')
		$existingHdr = if ($claudeSettings["env"].ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
		$claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] = Set-CustomHeader $existingHdr 'x-api-key' $Key
	} else {
		$claudeSettings["env"]['ANTHROPIC_API_KEY'] = $Key
		$existingHdr = if ($claudeSettings["env"].ContainsKey('ANTHROPIC_CUSTOM_HEADERS')) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] } else { "" }
		$rem = Remove-CustomHeader $existingHdr 'x-api-key'
		if ($rem) { $claudeSettings["env"]['ANTHROPIC_CUSTOM_HEADERS'] = $rem }
		else { $claudeSettings["env"].Remove('ANTHROPIC_CUSTOM_HEADERS') }
	}
	$null = Backup-ConfigFile $claudeSettingsPath
	Write-Utf8NoBom $claudeSettingsPath (($claudeSettings | ConvertTo-Json -Depth 10) + "`n")
	Say "[OK] Zaktualizowano $claudeSettingsPath (CLI Claude Code)."
}

# -------------------------------------------------- VS Code & pokrewne edytory IDE settings.json
$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $homeDir "AppData\Roaming" }
$configuredIdes = @()
foreach ($ide in @(
	@{ dir = 'Code'; label = 'VS Code' },
	@{ dir = 'Code - Insiders'; label = 'VS Code Insiders' },
	@{ dir = 'Cursor'; label = 'Cursor' },
	@{ dir = 'Windsurf'; label = 'Windsurf' },
	@{ dir = 'VSCodium'; label = 'VSCodium' },
	@{ dir = 'Antigravity'; label = 'Antigravity IDE' }
)) {
	$ideDir = Join-Path $appData "$($ide.dir)\User"
	$ideSettingsPath = Join-Path $ideDir "settings.json"
	if (-not (Test-Path $ideDir)) { continue }
	try {
		$vsSettings = @{}
		if (Test-Path $ideSettingsPath) {
			$vsSettings = Read-JsonHashtable $ideSettingsPath
		}
		$vsSettings["claudeCode.disableLoginPrompt"] = $true
		$vsSettings["claudeCode.hideOnboarding"] = $true
		$claudeEnvironmentVariables = @(
			if ($vsSettings.ContainsKey("claudeCode.environmentVariables")) {
				@($vsSettings["claudeCode.environmentVariables"]) | Where-Object { $_ -and $_.name -ne "ANTHROPIC_BASE_URL" }
			}
		)
		$claudeEnvironmentVariables += @{ name = "ANTHROPIC_BASE_URL"; value = $Url }
		if ($oauthSession) {
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_API_KEY" -and $_.name -ne "ANTHROPIC_AUTH_TOKEN" })
			$existingHdr = ($claudeEnvironmentVariables | Where-Object { $_.name -eq "ANTHROPIC_CUSTOM_HEADERS" } | Select-Object -First 1).value
			$updatedHdr = Set-CustomHeader $existingHdr "x-api-key" $Key
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_CUSTOM_HEADERS" })
			$claudeEnvironmentVariables += @{ name = "ANTHROPIC_CUSTOM_HEADERS"; value = $updatedHdr }
		} else {
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_API_KEY" -and $_.name -ne "ANTHROPIC_AUTH_TOKEN" })
			$claudeEnvironmentVariables += @{ name = "ANTHROPIC_API_KEY"; value = $Key }
			$claudeEnvironmentVariables += @{ name = "ANTHROPIC_AUTH_TOKEN"; value = $Key }
			$existingHdr = ($claudeEnvironmentVariables | Where-Object { $_.name -eq "ANTHROPIC_CUSTOM_HEADERS" } | Select-Object -First 1).value
			$rem = Remove-CustomHeader $existingHdr "x-api-key"
			$claudeEnvironmentVariables = @($claudeEnvironmentVariables | Where-Object { $_.name -ne "ANTHROPIC_CUSTOM_HEADERS" })
			if ($rem) { $claudeEnvironmentVariables += @{ name = "ANTHROPIC_CUSTOM_HEADERS"; value = $rem } }
		}
		$vsSettings["claudeCode.environmentVariables"] = $claudeEnvironmentVariables
		$null = Backup-ConfigFile $ideSettingsPath
		Write-Utf8NoBom $ideSettingsPath (($vsSettings | ConvertTo-Json -Depth 10) + "`n")
		Say "[OK] Zaktualizowano ustawienia rozszerzenia Claude Code w $($ide.label) ($ideSettingsPath)."
		$configuredIdes += $ide.label
	} catch {
		Say "[Uwaga] Nie udało się zaktualizować $($ide.label): $($_.Exception.Message)"
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

if ($WithAgylb) {
	Say ""
	Say "Instaluję agylb i agylb-yolo (wspólna pula kont Google)..."
	$prevAgylbKey = $env:AGENT_LB_API_KEY
	$prevAgylbUrl = $env:AGENT_LB_URL
	try {
		$env:AGENT_LB_API_KEY = $Key
		$env:AGENT_LB_URL = $Url
		$localAgylb = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'agylb-setup.ps1' } else { '' }
		if ($localAgylb -and (Test-Path $localAgylb)) {
			& $localAgylb -Url $Url
		} else {
			& ([scriptblock]::Create((Invoke-RestMethod "$Url/agylb-setup.ps1"))) -Url $Url
		}
	} finally {
		$env:AGENT_LB_API_KEY = $prevAgylbKey
		$env:AGENT_LB_URL = $prevAgylbUrl
	}
}

# -------------------------------------------------- Auto-wykrywanie popularnych aplikacji
$extraApps = @()

# OpenCode
$ocConfigDir = Join-Path $homeDir '.config\opencode'
$ocAppDataDir = Join-Path $appData 'opencode'
if ((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path $ocConfigDir) -or (Test-Path $ocAppDataDir)) {
	try {
		$ocConfigPath = Join-Path $ocConfigDir 'opencode.json'
		$ocAuthDir = Join-Path $homeDir '.local\share\opencode'
		$ocAuthPath = Join-Path $ocAuthDir 'auth.json'

		$ocCfg = if (Test-Path $ocConfigPath) { Read-JsonHashtable $ocConfigPath } else { @{} }
		$ocAuth = if (Test-Path $ocAuthPath) { Read-JsonHashtable $ocAuthPath } else { @{} }
		$winAuthPath = Join-Path $ocAppDataDir 'auth.json'
		$winAuth = if ((Test-Path $ocAppDataDir) -and (Test-Path $winAuthPath)) { Read-JsonHashtable $winAuthPath } else { @{} }

		$ocModels = [ordered]@{
			'claude-fable-5-1' = @{ name = 'Claude Fable 5.1' }
			'claude-fable-5' = @{ name = 'Claude Fable 5' }
			'claude-opus-5-5' = @{ name = 'Claude Opus 5.5' }
			'claude-opus-5' = @{ name = 'Claude Opus 5' }
			'claude-opus-4-8' = @{ name = 'Claude Opus 4.8' }
			'claude-opus-4-7' = @{ name = 'Claude Opus 4.7' }
			'claude-opus-4-6' = @{ name = 'Claude Opus 4.6' }
			'claude-sonnet-5-5' = @{ name = 'Claude Sonnet 5.5' }
			'claude-sonnet-5' = @{ name = 'Claude Sonnet 5' }
			'claude-sonnet-4-6' = @{ name = 'Claude Sonnet 4.6' }
			'claude-haiku-5-5' = @{ name = 'Claude Haiku 5.5' }
			'claude-haiku-4-5-20251001' = @{ name = 'Claude Haiku 4.5' }
			'codex' = @{ name = 'OpenAI Codex (GPT-5.6 Sol)' }
			'gpt-5.6-sol' = @{ name = 'GPT-5.6 Sol' }
			'gpt-6-astra' = @{ name = 'GPT-6 Astra' }
			'gpt-6-sol' = @{ name = 'GPT-6 Sol' }
			'gpt-6-luna' = @{ name = 'GPT-6 Luna' }
			'gpt-5.6-terra' = @{ name = 'GPT-5.6 Terra' }
			'gpt-5.6-luna' = @{ name = 'GPT-5.6 Luna' }
			'gpt-5.3-codex' = @{ name = 'GPT-5.3-Codex' }
			'gpt-5.2-codex' = @{ name = 'GPT-5.2-Codex' }
			'gpt-5.5' = @{ name = 'GPT-5.5' }
			'gpt-4.1' = @{ name = 'GPT-4.1' }
			'gpt-4o' = @{ name = 'GPT-4o' }
		}
		try {
			$mResp = Invoke-RestMethod -Uri "$Url/v1/models" -Headers @{ 'x-api-key' = $Key; 'Authorization' = "Bearer $Key" } -MaximumRedirection 0 -TimeoutSec 8
			if ($mResp -and $mResp.data) {
				foreach ($m in $mResp.data) {
					if ($m.id -and ($m.id -match '^[A-Za-z0-9._:-]{1,100}$') -and (-not $ocModels.Contains($m.id))) {
						$ocModels[$m.id] = @{ name = $(if ($m.name) { $m.name } else { $m.id }) }
					}
				}
			}
		} catch {}

		if (-not $ocCfg.ContainsKey('provider') -or -not ($ocCfg['provider'] -is [hashtable])) { $ocCfg['provider'] = @{} }
		$ocCfg['provider']['agentlb'] = @{
			npm = '@ai-sdk/openai-compatible'
			name = 'AgentLB (All Models)'
			options = @{ baseURL = "$Url/v1"; apiKey = $Key }
			models = $ocModels
		}
		if (-not $ocCfg.ContainsKey('providers') -or -not ($ocCfg['providers'] -is [hashtable])) { $ocCfg['providers'] = @{} }
		$ocCfg['providers']['agentlb'] = @{
			npm = '@ai-sdk/openai-compatible'
			name = 'AgentLB (All Models)'
			package = '@opencode/ai/providers/openai-compatible'
			settings = @{ baseURL = "$Url/v1" }
			options = @{ baseURL = "$Url/v1"; apiKey = $Key }
			apiKey = $Key
			models = $ocModels
		}
		$ocAuth['agentlb'] = @{ type = 'api'; key = $Key }

		if (-not (Test-Path $ocConfigDir)) { New-Item -ItemType Directory -Path $ocConfigDir -Force | Out-Null }
		if (-not (Test-Path $ocAuthDir)) { New-Item -ItemType Directory -Path $ocAuthDir -Force | Out-Null }
		$null = Backup-ConfigFile $ocConfigPath
		Write-Utf8NoBom $ocConfigPath (($ocCfg | ConvertTo-Json -Depth 10) + "`n")
		$null = Backup-ConfigFile $ocAuthPath
		Write-Utf8NoBom $ocAuthPath (($ocAuth | ConvertTo-Json -Depth 10) + "`n")
		if (Test-Path $ocAppDataDir) {
			$winAuth['agentlb'] = @{ type = 'api'; key = $Key }
			$null = Backup-ConfigFile $winAuthPath
			Write-Utf8NoBom $winAuthPath (($winAuth | ConvertTo-Json -Depth 10) + "`n")
		}
		Say "[OK] Skonfigurowano OpenCode ($ocConfigPath)."
		$extraApps += 'OpenCode'
	} catch {
		Say "[Uwaga] Nie udało się skonfigurować OpenCode: $($_.Exception.Message)"
	}
}

# Aider
$aiderConfPath = Join-Path $homeDir '.aider.conf.yml'
if ((Get-Command aider -ErrorAction SilentlyContinue) -or (Test-Path $aiderConfPath) -or (Test-Path (Join-Path $homeDir '.aider'))) {
	try {
		$existingAider = if (Test-Path $aiderConfPath) { [System.IO.File]::ReadAllText($aiderConfPath, [System.Text.Encoding]::UTF8) } else { '' }
		$restAider = [regex]::Replace($existingAider, '(?ms)^# >>> agentlb.*?^# <<< agentlb[^\r\n]*\r?\n?', '').Trim()
		$hasModel = $restAider -match '(?m)^\s*model\s*:'
		$qUrl = ConvertTo-Json "$Url/v1"
		$qKey = ConvertTo-Json $Key
		$aiderBlock = "# >>> agentlb >>> (zarzadzane przez setup AgentLB)`nopenai-api-base: $qUrl`nopenai-api-key: $qKey`n"
		if (-not $hasModel) { $aiderBlock += "model: `"openai/gpt-5.6-sol`"`n" }
		$aiderBlock += "# <<< agentlb <<<`n"
		$newAider = if ($restAider) { "$restAider`n`n$aiderBlock" } else { $aiderBlock }
		$null = Backup-ConfigFile $aiderConfPath
		Write-Utf8NoBom $aiderConfPath $newAider
		Say "[OK] Skonfigurowano Aider ($aiderConfPath)."
		$extraApps += 'Aider'
	} catch {
		Say "[Uwaga] Nie udało się skonfigurować Aider: $($_.Exception.Message)"
	}
}

# OpenClaw
$clawDir = Join-Path $homeDir '.openclaw'
if ((Get-Command openclaw -ErrorAction SilentlyContinue) -or (Test-Path $clawDir)) {
	try {
		$clawPath = Join-Path $clawDir 'openclaw.json'
		$clawCfg = if (Test-Path $clawPath) { Read-JsonHashtable $clawPath } else { @{} }
		if (-not $clawCfg.ContainsKey('models') -or -not ($clawCfg['models'] -is [hashtable])) { $clawCfg['models'] = @{} }
		if (-not $clawCfg['models'].ContainsKey('providers') -or -not ($clawCfg['models']['providers'] -is [hashtable])) { $clawCfg['models']['providers'] = @{} }
		$clawCfg['models']['providers']['agentlb'] = @{
			baseUrl = "$Url/v1"
			api = 'openai-completions'
			apiKey = $Key
		}
		if (-not (Test-Path $clawDir)) { New-Item -ItemType Directory -Path $clawDir -Force | Out-Null }
		$null = Backup-ConfigFile $clawPath
		Write-Utf8NoBom $clawPath (($clawCfg | ConvertTo-Json -Depth 10) + "`n")
		Say "[OK] Skonfigurowano OpenClaw ($clawPath)."
		$extraApps += 'OpenClaw'
	} catch {
		Say "[Uwaga] Nie udało się skonfigurować OpenClaw: $($_.Exception.Message)"
	}
}

# Hermes Agent
$hermesDir = Join-Path $homeDir '.hermes'
if ((Get-Command hermes -ErrorAction SilentlyContinue) -or (Test-Path $hermesDir)) {
	try {
		if (-not (Test-Path $hermesDir)) { New-Item -ItemType Directory -Path $hermesDir -Force | Out-Null }
		$hermesEnv = Join-Path $hermesDir '.env'
		$lines = @()
		if (Test-Path $hermesEnv) {
			$lines = @([System.IO.File]::ReadAllLines($hermesEnv, [System.Text.Encoding]::UTF8) | Where-Object { $_ -and ($_ -notmatch '^\s*(?:export\s+)?(AGENT_LB_URL|AGENT_LB_API_KEY)=') })
		}
		$lines += "AGENT_LB_URL=$Url"
		$lines += "AGENT_LB_API_KEY=$Key"
		$null = Backup-ConfigFile $hermesEnv
		Write-Utf8NoBom $hermesEnv (($lines -join "`n") + "`n")
		Say "[OK] Zaktualizowano $hermesEnv (Hermes Agent)."
		$extraApps += 'Hermes Agent'
	} catch {
		Say "[Uwaga] Nie udało się skonfigurować Hermes Agent: $($_.Exception.Message)"
	}
}

# Herdr
$herdrDir = Join-Path $appData 'herdr'
$herdrCmd = Get-Command herdr -ErrorAction SilentlyContinue
if ($herdrCmd -or (Test-Path $herdrDir)) {
	$herdrDone = @()
	if ($herdrCmd) {
		$candidates = @(
			@{ name = 'claude'; ok = [bool]((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $homeDir '.claude'))) },
			@{ name = 'codex'; ok = [bool]((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $homeDir '.codex'))) },
			@{ name = 'opencode'; ok = [bool]((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path $ocConfigDir)) },
			@{ name = 'agy'; ok = [bool]((Get-Command agy -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $homeDir '.local\bin\agylb.cmd'))) }
		)
		foreach ($c in $candidates) {
			if (-not $c.ok) { continue }
			try {
				& $herdrCmd.Source integration install $c.name 2>$null | Out-Null
				if ($LASTEXITCODE -eq 0) { $herdrDone += $c.name }
			} catch {}
		}
	}
	if ($herdrDone.Count -gt 0) {
		$hList = $herdrDone -join ', '
		Say "[OK] Zintegrowano Herdr dla wykrytych agentów: $hList."
		$extraApps += "Herdr ($hList)"
	} else {
		$extraApps += 'Herdr'
	}
}

Say ""
Say "=== Wdrożenie i konfiguracja zakończona sukcesem! ==="
if (Get-Command claude -ErrorAction SilentlyContinue) {
	$cv = try { & claude --version 2>$null } catch { "gotowy" }
	Say "✔ Claude Code CLI: $cv -> uruchom 'claude'"
}
if (Get-Command codex -ErrorAction SilentlyContinue) {
	$cxv = try { & codex --version 2>$null } catch { "gotowy" }
	Say "✔ OpenAI Codex CLI: $cxv -> uruchom 'codex --profile codexlb' lub 'codex'"
}
if ($WithAgylb) {
	Say "✔ AGY (pula Google): uruchom 'agylb' (standardowo) lub 'agylb-yolo' (bez pytań o akceptację)"
}
if ($configuredIdes.Count -gt 0) {
	Say "✔ Edytory IDE: $($configuredIdes -join ', ') (rozszerzenie Claude Code skonfigurowane pod proxy)"
}
if ($extraApps.Count -gt 0) {
	Say "✔ Wykryte i skonfigurowane aplikacje: $($extraApps -join ', ')"
}
Say "✔ Zmienne środowiskowe: zapisane w rejestrze użytkownika Windows"
Say "✔ Serwer proxy: $Url"
Say ""
Say "Zrestartuj otwarte okna VS Code lub terminale, aby wczytały nowe zmienne środowiskowe."
