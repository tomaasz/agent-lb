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
const { execSync } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Domyślne wartości
let targetUrl = process.env.CLAUDE_LB_URL || process.env.TEAMCLAUDE_URL || 'http://localhost:3456';
let apiKey = process.env.CLAUDE_LB_API_KEY || process.env.TEAMCLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
let runTest = false;
let skipVscode = false;
let skipEnv = false;
let setupCodex = false;

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
  -h, --help       Pokaż ten ekran pomocy
`);
    process.exit(0);
  }
}

function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (process.stdin.isTTY) {
      process.stdout.write(query);
      let input = '';
      const onData = (char) => {
        char = char + '';
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdin.removeListener('data', onData);
            break;
          case '\u0003': // Ctrl+C
            process.exit(1);
            break;
          case '\u0008': // Backspace
          case '\x7f':
            input = input.slice(0, -1);
            break;
          default:
            input += char;
            break;
        }
      };
      process.stdin.on('data', onData);
      rl.question('', () => {
        rl.close();
        resolve(input.trim());
      });
    } else {
      rl.question(query, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
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
  return str
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
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

async function main() {
  console.log('=== Konfigurator klienta Claude-LB / TeamClaude dla Claude Code i IDE ===\n');

  // 1. Sprawdzenie / zapytanie o klucz API
  if (!apiKey) {
    // Sprawdź czy nie ma zapisanego w ~/.claude/settings.json
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const existingClaudeSettings = safeReadJson(claudeSettingsPath);
    if (existingClaudeSettings?.env?.ANTHROPIC_API_KEY) {
      const savedKey = existingClaudeSettings.env.ANTHROPIC_API_KEY;
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
          const match = fs.readFileSync(p, 'utf-8').match(/export ANTHROPIC_API_KEY=["']?([^"'\r\n]+)/);
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

  // 3. Zabezpieczenie przed "Auth conflict" (OAuth vs API Key)
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credsPath)) {
    try {
      const credsContent = fs.readFileSync(credsPath, 'utf-8');
      if (credsContent.includes('accessToken') || credsContent.includes('claude.ai')) {
        const bakPath = `${credsPath}.bak-${Date.now()}`;
        fs.renameSync(credsPath, bakPath);
        console.log(`[OK] Wykryto starą sesję logowania OAuth w .credentials.json.`);
        console.log(`     Zrobiono kopię (${path.basename(bakPath)}) i wyczyszczono sesję, aby uniknąć błędu 'Auth conflict'.`);
      }
    } catch (e) {
      // Ignoruj jeśli nie udało się przenieść
    }
  }

  // 4. Konfiguracja ~/.claude/settings.json (CLI Claude Code)
  const claudeDir = path.join(os.homedir(), '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  try {
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    }
    let settings = safeReadJson(claudeSettingsPath) || {};
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = targetUrl;
    settings.env.ANTHROPIC_API_KEY = apiKey;

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    console.log(`[OK] Skonfigurowano ${claudeSettingsPath} (CLI automatycznie używa proxy).`);
  } catch (err) {
    console.error(`[Błąd] Nie udało się zapisać ${claudeSettingsPath}: ${err.message}`);
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
        vsSettings['claudeCode.environmentVariables'] = [
          { name: 'ANTHROPIC_BASE_URL', value: targetUrl },
          { name: 'ANTHROPIC_API_KEY', value: apiKey },
        ];

        fs.writeFileSync(vscodeSettingsFile, JSON.stringify(vsSettings, null, 2) + '\n');
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
      fs.writeFileSync(codexConfigFile, JSON.stringify(codexConfig, null, 2) + '\n', { mode: 0o600 });
      console.log(`[OK] Skonfigurowano ${codexConfigFile} (Codex CLI przekierowane na Claude-LB).`);
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się zaktualizować konfiguracji Codex CLI: ${err.message}`);
    }
  }

  // 6. Zmienne systemowe / powłoki
  if (!skipEnv) {
    if (isWin) {
      try {
        let winCmd = `[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', '${targetUrl}', 'User'); [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', '${apiKey}', 'User')`;
        if (setupCodex || fs.existsSync(codexDir)) {
          winCmd += `; [Environment]::SetEnvironmentVariable('CODEX_BASE_URL', '${targetUrl}/backend-api/codex', 'User'); [Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', '${targetUrl}/v1', 'User')`;
        }
        execSync(`powershell.exe -NoProfile -Command "${winCmd}"`);
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
        let envContent = `# Claude-LB / TeamClaude environment configuration\nexport ANTHROPIC_BASE_URL="${targetUrl}"\nexport ANTHROPIC_API_KEY="${apiKey}"\n`;
        if (setupCodex || fs.existsSync(codexDir)) {
          envContent += `export CODEX_BASE_URL="${targetUrl}/backend-api/codex"\nexport OPENAI_BASE_URL="${targetUrl}/v1"\n`;
        }
        fs.writeFileSync(envFile, envContent, { mode: 0o600 });
        fs.writeFileSync(legacyEnvFile, envContent, { mode: 0o600 });
        console.log(`[OK] Zapisano plik środowiskowy ${envFile} (oraz ${legacyEnvFile}).`);

        // Podepnij pod .bashrc i .zshrc
        const srcLine = `. "${envFile}"  # claude-lb`;
        for (const rcName of ['.bashrc', '.zshrc']) {
          const rcPath = path.join(os.homedir(), rcName);
          if (fs.existsSync(rcPath)) {
            const rcContent = fs.readFileSync(rcPath, 'utf-8');
            if (!rcContent.includes('# claude-lb') && !rcContent.includes('# teamclaude')) {
              fs.appendFileSync(rcPath, `\n${srcLine}\n`);
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
      const output = execSync('claude --version', {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: targetUrl,
          ANTHROPIC_API_KEY: apiKey,
        },
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
