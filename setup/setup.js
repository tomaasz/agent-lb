#!/usr/bin/env node
/**
 * teamclaude-setup.js — uniwersalny skrypt konfiguracji klienta Claude dla Windows, Debian, Ubuntu i macOS.
 *
 * Konfiguruje:
 *  1. Claude Code CLI (~/.claude/settings.json -> sekcja env)
 *  2. Oficjalne rozszerzenie Claude Code w VS Code (settings.json -> claudeCode.environmentVariables)
 *  3. Zmienne środowiskowe systemowe (Rejestr Windows User / ~/.config/teamclaude.env + .bashrc/.zshrc na Linux)
 *  4. Bezpiecznie usuwa/backupuje starą sesję OAuth (~/.claude/.credentials.json), zapobiegając błędowi "Auth conflict".
 *
 * Użycie:
 *   node setup.js
 *   node setup.js --url https://your-server.com
 *   node setup.js --key tc-...
 *   node teamclaude-setup.js --test
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { execSync, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isWsl = process.platform === 'linux' && (
  Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME)
  || (() => {
    try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; }
  })()
);

// Domyślne wartości
let targetUrl = process.env.CLAUDE_LB_URL || process.env.TEAMCLAUDE_URL || 'http://localhost:3456';
let apiKey = process.env.CLAUDE_LB_API_KEY || process.env.TEAMCLAUDE_API_KEY
  || process.env.CODEX_LB_API_KEY || keyFromCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS)
  || process.env.ANTHROPIC_API_KEY || '';
let runTest = false;
let skipVscode = false;
let skipEnv = false;
let setupCodex = false;
let uninstall = false;

// Parsowanie argumentów
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--url' && args[i + 1]) {
    targetUrl = args[++i].replace(/\/+$/, '');
  } else if (arg === '--key' && args[i + 1]) {
    apiKey = args[++i].trim();
  } else if (arg === '--test') {
    runTest = true;
  } else if (arg === '--codex') {
    setupCodex = true;
  } else if (arg === '--skip-vscode') {
    skipVscode = true;
  } else if (arg === '--skip-env') {
    skipEnv = true;
  } else if (arg === '--uninstall') {
    uninstall = true;
  } else if (arg === '-h' || arg === '--help') {
    console.log(`
Claude-LB / TeamClaude Client Setup (Universal: Windows / Linux / macOS)

Użycie:
  node setup.js [opcje]

Opcje:
  --url URL        Adres serwera proxy (domyślnie: ${targetUrl})
  --key KLUCZ      Klucz API proxy (tc-...)
  --codex          Skonfiguruj również klienta OpenAI Codex CLI (~/.codex/config.json)
  --test           Wykonaj próbne uruchomienie claude po konfiguracji
  --skip-vscode    Pomiń konfigurację oficjalnego rozszerzenia VS Code
  --skip-env       Pomiń konfigurację zmiennych powłoki / systemu
  --uninstall      Usuń ustawienia Claude-LB z profilu klienta (bez kasowania sesji OAuth)
  -h, --help       Pokaż ten ekran pomocy
`);
    process.exit(0);
  }
}

function promptHidden(query) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(query, (ans) => { rl.close(); resolve(ans.trim()); });
      return;
    }
    process.stdout.write(query);
    let input = '';
    const oldRaw = process.stdin.isRaw;
    const finish = (value) => {
      process.stdin.setRawMode?.(Boolean(oldRaw));
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\n' || char === '\r' || char === '\u0004') return finish(input);
        if (char === '\u0003') { process.exit(130); return; }
        if (char === '\u0008' || char === '\x7f') input = input.slice(0, -1);
        else input += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function checkUrlOnce(urlPath, urlStr, key) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlPath, urlStr);
    } catch (e) {
      return reject(new Error(`Niepoprawny format URL: ${urlStr}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'User-Agent': 'claude-lb-setup/2.0',
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode === 200) {
          resolve(200);
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Serwer odrzucił klucz API (kod HTTP ${res.statusCode}). Sprawdź poprawność klucza proxy.`));
        } else {
          resolve(res.statusCode);
        }
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Przekroczono limit czasu połączenia z ${urlStr}. Sprawdź, czy serwer działa i maszyna ma połączenie z siecią.`));
    });

    req.on('error', (err) => {
      reject(new Error(`Błąd połączenia z ${urlStr} (${err.message}). Upewnij się, że masz połączenie z adresem serwera.`));
    });

    req.end();
  });
}

async function checkConnection(urlStr, key) {
  const code = await checkUrlOnce('/teamclaude/status', urlStr, key);
  if (code === 404) {
    const code2 = await checkUrlOnce('/status', urlStr, key);
    return code2 === 200 || code2 < 500;
  }
  return true;
}

function stripJsonComments(str) {
  // VS Code settings are JSONC.  Regexes remove the `//` in a URL or a
  // credential value as if it were a comment, which silently discards user
  // settings.  Scan strings and comments separately, then remove trailing
  // commas in a second string-aware pass.
  let out = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const n = str[i + 1];
    if (lineComment) { if (c === '\n' || c === '\r') { lineComment = false; out += c; } continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } else if (c === '\n' || c === '\r') out += c; continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    out += c;
  }
  let cleaned = '';
  inString = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      cleaned += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; cleaned += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (/\s/.test(out[j] || '')) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    cleaned += c;
  }
  return cleaned;
}

function backupPath(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backup = `${filePath}.bak-${Date.now()}`;
  try {
    fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
    // The source may predate this installer and be world-readable.  Backups
    // contain the API key after the write, so never inherit that loose mode.
    fs.chmodSync(backup, 0o600);
    return backup;
  } catch (err) {
    console.warn(`[Ostrzeżenie] Nie udało się utworzyć kopii ${filePath}: ${err.message}`);
    return null;
  }
}

function writeTextAtomic(filePath, content, mode = 0o600) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); fs.renameSync(tmp, filePath); }
  catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
}

function writeJsonSafe(filePath, value, mode = 0o600) {
  backupPath(filePath);
  writeTextAtomic(filePath, JSON.stringify(value, null, 2) + '\n', mode);
}

function shQuote(value) {
  const single = String.fromCharCode(39);
  const double = String.fromCharCode(34);
  return single + String(value).replaceAll(single, single + double + single + double + single) + single;
}

function proxyCustomHeaders(key) {
  return `x-api-key: ${key}`;
}

function keyFromCustomHeaders(value) {
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = /^x-api-key\s*:\s*(.+?)\s*$/i.exec(line);
    if (match) return match[1];
  }
  return '';
}

function removeMarkedSource(rcPath) {
  if (!fs.existsSync(rcPath)) return;
  const text = fs.readFileSync(rcPath, 'utf8');
  const cleaned = text.replace(/\n?[^\n]*# (?:claude-lb|teamclaude)[^\n]*\n?/gi, '\n');
  if (cleaned !== text) writeTextAtomic(rcPath, cleaned, fs.statSync(rcPath).mode & 0o777);
}

function uninstallClientSettings() {
  const home = os.homedir();
  const claudePath = path.join(home, '.claude', 'settings.json');
  const settings = safeReadJson(claudePath);
  if (settings) {
    if (settings.env && typeof settings.env === 'object') {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_API_KEY;
      delete settings.env.ANTHROPIC_CUSTOM_HEADERS;
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }
    writeJsonSafe(claudePath, settings);
  }
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const vscodeDir = isWin ? path.join(appData, 'Code', 'User') : isMac
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
    : path.join(home, '.config', 'Code', 'User');
  const vscodePath = path.join(vscodeDir, 'settings.json');
  const vs = safeReadJson(vscodePath);
  if (vs) {
    delete vs['claudeCode.environmentVariables'];
    delete vs['claudeCode.disableLoginPrompt'];
    writeJsonSafe(vscodePath, vs);
  }
  const codexPath = path.join(home, '.codex', 'config.json');
  const codex = safeReadJson(codexPath);
  if (codex && Object.hasOwn(codex, 'base_url')) {
    delete codex.base_url;
    writeJsonSafe(codexPath, codex, 0o600);
  }
  for (const file of [path.join(home, '.config', 'claude-lb.env'), path.join(home, '.config', 'teamclaude.env')]) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (err) { console.warn(`[Ostrzeżenie] Nie udało się usunąć ${file}: ${err.message}`); }
  }
  for (const rc of ['.bashrc', '.zshrc', '.profile']) removeMarkedSource(path.join(home, rc));
  if (isWin) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', "'ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_CUSTOM_HEADERS','CODEX_LB_API_KEY','CODEX_BASE_URL','OPENAI_BASE_URL' | ForEach-Object { [Environment]::SetEnvironmentVariable($_, $null, 'User') }"]);
    } catch (err) { console.warn(`[Ostrzeżenie] Nie udało się usunąć zmiennych Windows: ${err.message}`); }
  }
  console.log('Usunięto ustawienia Claude-LB. Plik .credentials.json pozostawiono bez zmian.');
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(stripJsonComments(raw));
  } catch (err) {
    console.warn(`[Ostrzeżenie] Nie można sparsować ${filePath}: ${err.message}. Zostanie utworzona kopia zapasowa.`);
    return null;
  }
}

// ANTHROPIC_API_KEY switches Claude Code to API-key authentication and takes
// precedence over the OAuth session in .credentials.json.  That also changes
// which model catalogue and compaction/auth flow Claude Code uses.  Keep the
// subscription session active when it is present. Pass the LB credential as a
// custom x-api-key header so the remote proxy can authenticate the client
// without making Claude Code treat it as an Anthropic API key.
function hasOAuthSession(credentialsPath) {
  const data = safeReadJson(credentialsPath);
  const oauth = data?.claudeAiOauth || data?.oauth || data;
  return Boolean(oauth && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0);
}

async function main() {
  console.log('=== Konfigurator klienta Claude-LB / TeamClaude dla Claude Code i IDE ===\n');

  if (isWsl) {
    console.warn('[Ostrzeżenie] Wykryto WSL. Ten proces zapisuje konfigurację w linuksowym profilu WSL, nie w C:\\Users\\... Windows. W PowerShell uruchom setup.ps1 bez potoku do bash.');
  }

  if (uninstall) {
    uninstallClientSettings();
    return;
  }

  // 1. Sprawdzenie / zapytanie o klucz API
  if (!apiKey) {
    // Sprawdź czy nie ma zapisanego w ~/.claude/settings.json
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const existingClaudeSettings = safeReadJson(claudeSettingsPath);
    const savedKey = existingClaudeSettings?.env?.ANTHROPIC_API_KEY
      || keyFromCustomHeaders(existingClaudeSettings?.env?.ANTHROPIC_CUSTOM_HEADERS);
    if (savedKey) {
      console.log(`Wykryto wcześniej zapisany klucz w ${claudeSettingsPath}.`);
      apiKey = savedKey;
    }
  }

  if (!apiKey) {
    // Sprawdź pliki env
    for (const envName of ['claude-lb.env', 'teamclaude.env']) {
      const p = path.join(os.homedir(), '.config', envName);
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          const match = content.match(/export (?:CODEX_LB_API_KEY|ANTHROPIC_API_KEY)=["']?([^"'\r\n]+)/);
          if (match && match[1]) {
            console.log(`Wykryto wcześniej zapisany klucz w ${p}.`);
            apiKey = match[1];
            break;
          }
        } catch {}
      }
    }
  }

  if (!apiKey) {
    apiKey = await promptHidden(`Wklej klucz API z Claude-LB / TeamClaude (${targetUrl}): `);
    console.log('');
  }

  if (!apiKey) {
    console.error('BŁĄD: Nie podano klucza API.');
    process.exit(1);
  }
  if (/[\r\n]/.test(apiKey)) {
    console.error('BŁĄD: Klucz API nie może zawierać znaku nowej linii.');
    process.exit(1);
  }

  // 2. Weryfikacja połączenia na żywo
  process.stdout.write(`Sprawdzam połączenie i poprawność klucza na ${targetUrl}... `);
  try {
    await checkConnection(targetUrl, apiKey);
    console.log('OK!\n');
  } catch (err) {
    console.log('BŁĄD!');
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  // 3. Zabezpieczenie sesji OAuth
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const oauthSession = hasOAuthSession(credsPath);
  if (fs.existsSync(credsPath)) {
    try {
      const credsContent = fs.readFileSync(credsPath, 'utf-8');
      if (credsContent.includes('accessToken') || credsContent.includes('claude.ai')) {
        const bakPath = `${credsPath}.bak-${Date.now()}`;
        fs.copyFileSync(credsPath, bakPath);
        console.log(`[OK] Wykryto sesję logowania OAuth w .credentials.json — utworzono kopię zapasową (${path.basename(bakPath)}).`);
      }
    } catch (e) {
      // Ignoruj jeśli nie udało się skopiować
    }
  }
  if (oauthSession) {
    console.log('[OK] Zachowuję tryb OAuth Claude Code; klucz proxy przekazuję przez ANTHROPIC_CUSTOM_HEADERS.');
  }

  // 4. Konfiguracja ~/.claude/settings.json (CLI Claude Code)
  const claudeDir = path.join(os.homedir(), '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  try {
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    }
    let claudeSettings = safeReadJson(claudeSettingsPath) || {};
    claudeSettings.env = claudeSettings.env || {};
    claudeSettings.env.ANTHROPIC_BASE_URL = targetUrl;
    if (oauthSession) {
      delete claudeSettings.env.ANTHROPIC_API_KEY;
      claudeSettings.env.ANTHROPIC_CUSTOM_HEADERS = proxyCustomHeaders(apiKey);
    } else {
      claudeSettings.env.ANTHROPIC_API_KEY = apiKey;
      delete claudeSettings.env.ANTHROPIC_CUSTOM_HEADERS;
    }
    writeJsonSafe(claudeSettingsPath, claudeSettings, 0o600);
    console.log(`[OK] Zaktualizowano ${claudeSettingsPath} (CLI Claude Code).`);
  } catch (err) {
    console.warn(`[Ostrzeżenie] Nie udało się zaktualizować ~/.claude/settings.json: ${err.message}`);
  }

  // 5. Konfiguracja oficjalnego rozszerzenia Claude Code w VS Code
  if (!skipVscode) {
    let vscodeSettingsDir = null;
    if (isWin) {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      vscodeSettingsDir = path.join(appData, 'Code', 'User');
    } else if (isMac) {
      vscodeSettingsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
    } else {
      vscodeSettingsDir = path.join(os.homedir(), '.config', 'Code', 'User');
    }

    const vscodeSettingsFile = path.join(vscodeSettingsDir, 'settings.json');
    if (fs.existsSync(vscodeSettingsDir)) {
      try {
        let vsSettings = safeReadJson(vscodeSettingsFile) || {};
        vsSettings['claudeCode.disableLoginPrompt'] = true;
        const claudeEnvironmentVariables = [{ name: 'ANTHROPIC_BASE_URL', value: targetUrl }];
        if (oauthSession) claudeEnvironmentVariables.push({ name: 'ANTHROPIC_CUSTOM_HEADERS', value: proxyCustomHeaders(apiKey) });
        else claudeEnvironmentVariables.push({ name: 'ANTHROPIC_API_KEY', value: apiKey });
        vsSettings['claudeCode.environmentVariables'] = claudeEnvironmentVariables;

        writeJsonSafe(vscodeSettingsFile, vsSettings, 0o600);
        console.log(`[OK] Skonfigurowano oficjalne rozszerzenie Claude Code w VS Code (${vscodeSettingsFile}).`);
      } catch (err) {
        console.warn(`[Ostrzeżenie] Nie udało się zaktualizować VS Code: ${err.message}`);
      }
    } else {
      console.log(`[INFO] Nie wykryto katalogu VS Code (${vscodeSettingsDir}) — pominięto konfigurację rozszerzenia IDE.`);
    }
  }

  // 5b. Konfiguracja OpenAI Codex CLI (~/.codex/config.json)
  const codexDir = path.join(os.homedir(), '.codex');
  if (setupCodex || fs.existsSync(codexDir)) {
    const codexConfigFile = path.join(codexDir, 'config.json');
    try {
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
      }
      let codexConfig = safeReadJson(codexConfigFile) || {};
      codexConfig.base_url = `${targetUrl}/backend-api/codex`;
      writeJsonSafe(codexConfigFile, codexConfig, 0o600);
      console.log(`[OK] Skonfigurowano ${codexConfigFile} (Codex CLI przekierowane na Claude-LB).`);
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się zaktualizować konfiguracji Codex CLI: ${err.message}`);
    }
  }

  // 6. Zmienne systemowe / powłoki
  if (!skipEnv) {
    if (isWin) {
      try {
        const psQuote = (value) => String(value).replaceAll("'", "''");
        let winCmd = `[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', '${psQuote(targetUrl)}', 'User'); `
          + (oauthSession
            ? `[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User'); [Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', '${psQuote(proxyCustomHeaders(apiKey))}', 'User')`
            : `[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', '${psQuote(apiKey)}', 'User'); [Environment]::SetEnvironmentVariable('ANTHROPIC_CUSTOM_HEADERS', $null, 'User')`);
        if (setupCodex || fs.existsSync(codexDir)) {
          winCmd += `; [Environment]::SetEnvironmentVariable('CODEX_BASE_URL', '${targetUrl}/backend-api/codex', 'User'); [Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', '${targetUrl}/v1', 'User')`;
        }
        execFileSync('powershell.exe', ['-NoProfile', '-Command', winCmd]);
        console.log(`[OK] Zapisano zmienne środowiskowe w profilu użytkownika Windows.`);
      } catch (err) {
        console.warn(`[Ostrzeżenie] Nie udało się ustawić zmiennych w Windows: ${err.message}`);
      }
    } else {
      // Linux / macOS
      const configDir = path.join(os.homedir(), '.config');
      const envFile = path.join(configDir, 'claude-lb.env');
      const legacyEnvFile = path.join(configDir, 'teamclaude.env');
      try {
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        let envContent = `# Claude-LB / TeamClaude environment configuration\nexport ANTHROPIC_BASE_URL=${shQuote(targetUrl)}\n`;
        if (oauthSession) {
          envContent += 'unset ANTHROPIC_API_KEY  # preserve Claude Code OAuth session\n';
          envContent += `export ANTHROPIC_CUSTOM_HEADERS=${shQuote(proxyCustomHeaders(apiKey))}\n`;
        } else {
          envContent += `export ANTHROPIC_API_KEY=${shQuote(apiKey)}\n`;
          envContent += 'unset ANTHROPIC_CUSTOM_HEADERS\n';
        }
        envContent += `export CODEX_LB_API_KEY=${shQuote(apiKey)}\n`;
        if (setupCodex || fs.existsSync(codexDir)) {
          envContent += `export CODEX_BASE_URL=${shQuote(`${targetUrl}/backend-api/codex`)}\nexport OPENAI_BASE_URL=${shQuote(`${targetUrl}/v1`)}\n`;
        }
        backupPath(envFile); backupPath(legacyEnvFile);
        writeTextAtomic(envFile, envContent, 0o600);
        writeTextAtomic(legacyEnvFile, envContent, 0o600);
        console.log(`[OK] Zapisano plik środowiskowy ${envFile} (oraz ${legacyEnvFile}).`);

        // Podepnij pod .bashrc i .zshrc
        const srcLine = `. "${envFile}"  # claude-lb`;
        for (const rcName of ['.bashrc', '.zshrc']) {
            const rcPath = path.join(os.homedir(), rcName);
            if (fs.existsSync(rcPath)) {
              const rcContent = fs.readFileSync(rcPath, 'utf-8');
              if (!rcContent.includes('# claude-lb') && !rcContent.includes('# teamclaude')) {
              backupPath(rcPath);
              writeTextAtomic(rcPath, `${rcContent}${rcContent.endsWith('\n') ? '' : '\n'}${srcLine}\n`, fs.statSync(rcPath).mode & 0o777);
              console.log(`[OK] Dopisano ładowanie zmiennych do ~/${rcName}.`);
              }
          }
        }
      } catch (err) {
        console.warn(`[Ostrzeżenie] Nie udało się zapisać zmiennych powłoki: ${err.message}`);
      }
    }
  }

  // 7. Próbne wywołanie claude (opcjonalne)
  if (runTest) {
    console.log('\nUruchamiam testowe sprawdzenie claude --version...');
    try {
      const testEnv = { ...process.env, ANTHROPIC_BASE_URL: targetUrl };
      if (oauthSession) {
        delete testEnv.ANTHROPIC_API_KEY;
        testEnv.ANTHROPIC_CUSTOM_HEADERS = proxyCustomHeaders(apiKey);
      } else {
        testEnv.ANTHROPIC_API_KEY = apiKey;
        delete testEnv.ANTHROPIC_CUSTOM_HEADERS;
      }
      const output = execSync('claude --version', {
        env: testEnv,
        encoding: 'utf-8',
        timeout: 15000,
      });
      console.log(`Wynik: ${output.trim()}`);
    } catch (err) {
      console.warn(`[Test] Uwaga: polecenie 'claude' zwróciło błąd lub nie jest w PATH: ${err.message}`);
    }
  }

  console.log('\n=== Konfiguracja zakończona sukcesem! ===');
  console.log('1. Claude Code CLI: będzie automatycznie łączyć się przez Claude-LB w każdym terminalu.');
  console.log('2. Rozszerzenie VS Code: po zrestartowaniu okna VS Code będzie używać Twojego proxy i klucza.');
  console.log('3. Inne narzędzia (Cursor, Cline, Continue, Roo Code): jako Base URL ustaw ' + targetUrl + ', a jako klucz swój tc-...');
  if (setupCodex || fs.existsSync(codexDir)) {
    console.log('4. OpenAI Codex CLI: skonfigurowano bazowy URL na ' + targetUrl + '/backend-api/codex.');
  }
}

main().catch((err) => {
  console.error('\nNieoczekiwany błąd:', err);
  process.exit(1);
});
