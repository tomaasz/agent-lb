#!/usr/bin/env node
/**
 * codexlb-setup.js — uniwersalny skrypt podpinania OpenAI Codex CLI i rozszerzenia VS Code pod proxy codexlb.gotova.pl.
 *
 * Działa na: Windows, Debian, Ubuntu, WSL, macOS.
 *
 * Co robi:
 *   1. Pyta o klucz API (ten z panelu /apis w codexlb) i weryfikuje go na żywo z /backend-api/codex/models.
 *   2. Pobiera listę aktywnych modeli z proxy i weryfikuje wybrany model.
 *   3. Zapisuje klucz w zmiennych środowiskowych (rejestr Windows / ~/.config/codexlb.env + .bashrc/.zshrc).
 *   4. Konfiguruje ~/.codex/config.toml (sekcja [model_providers.codex-lb]) z kopią zapasową.
 *   5. Tworzy profil ~/.codex/codexlb.config.toml (zgodny z Codex 0.14x+).
 *   6. Na życzenie przeprowadza test e2e (codex exec --profile codexlb ...).
 *   7. Umożliwia czyszczenie konfiguracji (--clean), sprawdzanie stanu (--status) i przywracanie kopii (--restore).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');

const isWin = process.platform === 'win32';

// Domyślne wartości
let targetUrl = (process.env.AGENT_LB_URL || process.env.CODEXLB_URL || 'https://codexlb.gotova.pl').replace(/\/+$/, '');
let apiKey = process.env.AGENT_LB_API_KEY || process.env.CODEX_LB_API_KEY || '';
let model = process.env.CODEXLB_MODEL || 'gpt-5.6-sol';
let effort = process.env.CODEXLB_EFFORT || 'xhigh';
let useWs = true;
let setDefault = true;
let runTest = false;
let isClean = false;
let isStatus = false;
let isRestore = false;
let isInsecure = false;

// Parsowanie argumentów
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--url' && args[i + 1]) {
    targetUrl = args[++i].replace(/\/+$/, '');
  } else if (arg === '--key' && args[i + 1]) {
    apiKey = args[++i].trim();
  } else if (arg === '--model' && args[i + 1]) {
    model = args[++i].trim();
  } else if (arg === '--effort' && args[i + 1]) {
    effort = args[++i].trim();
  } else if (arg === '--no-ws') {
    useWs = false;
  } else if (arg === '--profile-only') {
    setDefault = false;
  } else if (arg === '--test') {
    runTest = true;
  } else if (arg === '--clean') {
    isClean = true;
  } else if (arg === '--status' || arg === '-s') {
    isStatus = true;
  } else if (arg === '--restore' || arg === '-r') {
    isRestore = true;
  } else if (arg === '--insecure' || arg === '-k') {
    isInsecure = true;
  } else if (arg === '-h' || arg === '--help') {
    console.log(`
CodexLB Client Setup (Uniwersalny: Windows / Linux / macOS)

Użycie:
  node codexlb-setup.js [opcje]

Opcje:
  --url URL           Adres proxy (domyślnie: ${targetUrl})
  --key KLUCZ         Klucz API z panelu codexlb (zakładka /apis)
  --model MODEL       Model Codex (domyślnie: ${model})
  --effort EFFORT     Reasoning effort (domyślnie: ${effort})
  --no-ws             Wyłącz obsługę WebSocket (zalecane w sieciach z inspekcją TLS)
  --profile-only      Nie zmieniaj domyślnego modelu, utwórz tylko profil codexlb
  --test              Wykonaj testowe zapytanie przez proxy po konfiguracji
  --status, -s        Sprawdź stan konfiguracji, klucza i połączenia z proxy
  --restore, -r       Przywróć poprzednią konfigurację z najnowszej kopii zapasowej (.bak)
  --clean             Wyczyść klucz API oraz konfigurację codexlb z systemu
  --insecure, -k      Ignoruj błędy certyfikatów SSL/TLS (inspekcja SSL / proxy)
  -h, --help          Pokaż ten ekran pomocy
`);
    process.exit(0);
  }
}

function hasCommand(cmd) {
  try {
    execSync(isWin ? `where.exe ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getStoredApiKey(envFile) {
  if (process.env.CODEX_LB_API_KEY) return process.env.CODEX_LB_API_KEY.trim();
  if (isWin) {
    try {
      const out = execSync(`powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('CODEX_LB_API_KEY', 'User')"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {}
  } else if (fs.existsSync(envFile)) {
    try {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      const m = envContent.match(/^export CODEX_LB_API_KEY=["']?([^"'\r\n]+)/m);
      if (m && m[1]) return m[1].trim();
    } catch {}
  }
  return '';
}

function maskKey(key) {
  if (!key) return '(brak)';
  if (key.length <= 8) return '****';
  return key.slice(0, 7) + '...' + key.slice(-4);
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

function checkConnectionNative(urlStr, key, insecure) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL('/backend-api/codex/models', urlStr);
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
          'Authorization': `Bearer ${key}`,
          'User-Agent': 'codexlb-setup-client/1.1',
        },
        timeout: 25000,
        rejectUnauthorized: !insecure,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let models = [];
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(body);
              if (Array.isArray(json.data)) {
                models = json.data.map((m) => m.id || m.name).filter(Boolean);
              } else if (Array.isArray(json.models)) {
                models = json.models.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
              }
            } catch {}
            resolve({ statusCode: 200, models });
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`Serwer odrzucił klucz API (kod HTTP ${res.statusCode}). Wygeneruj nowy w panelu ${urlStr} (zakładka /apis).`));
          } else {
            resolve({ statusCode: res.statusCode, models });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Przekroczono limit czasu połączenia z ${urlStr}. W sieci firmowej sprawdź proxy lub VPN.`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function checkConnection(urlStr, key, insecure) {
  try {
    return await checkConnectionNative(urlStr, key, insecure);
  } catch (err) {
    // Fallback: jeśli natywne żądanie Node zawiedzie (np. specyficzne proxy systemowe), spróbuj curl
    if (hasCommand('curl')) {
      try {
        const insecureArg = insecure ? '-k ' : '';
        const curlCmd = `curl -s -m 25 ${insecureArg}-H "Authorization: Bearer ${key}" "${urlStr}/backend-api/codex/models"`;
        const body = execSync(curlCmd, { encoding: 'utf-8', timeout: 26000 });
        let models = [];
        try {
          const json = JSON.parse(body);
          if (Array.isArray(json.data)) {
            models = json.data.map((m) => m.id || m.name).filter(Boolean);
          } else if (Array.isArray(json.models)) {
            models = json.models.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
          }
        } catch {}
        return { statusCode: 200, models };
      } catch {}
    }
    throw new Error(`Błąd połączenia z ${urlStr} (${err.message}). W sieci firmowej sprawdź proxy: export https_proxy=... lub użyj flagi --insecure (-k).`);
  }
}

async function handleRestore(codexHome) {
  console.log('=== Przywracanie konfiguracji Codex z kopii zapasowej ===\n');
  if (!fs.existsSync(codexHome)) {
    console.log('[Info] Katalog ~/.codex nie istnieje.');
    return;
  }
  const files = fs.readdirSync(codexHome);
  const backups = files
    .filter((f) => f.startsWith('config.toml.bak-'))
    .sort((a, b) => b.localeCompare(a));

  if (backups.length === 0) {
    console.log('[Info] Nie znaleziono żadnych plików kopii zapasowej (config.toml.bak-*) w ' + codexHome);
    return;
  }

  const latest = backups[0];
  const target = path.join(codexHome, 'config.toml');
  fs.copyFileSync(path.join(codexHome, latest), target);
  console.log(`[OK] Przywrócono konfigurację z kopii: ${latest}`);
}

async function handleStatus(envFile, codexHome) {
  console.log('=== Stan konfiguracji CodexLB ===\n');

  // 1. Klucz API
  const storedKey = getStoredApiKey(envFile);
  console.log(`1. Klucz API:          ${maskKey(storedKey)}`);

  // 2. config.toml
  const configPath = path.join(codexHome, 'config.toml');
  let currentModel = '(brak)';
  let currentProvider = '(brak)';
  let currentBaseUrl = '(brak)';
  let currentWs = '(brak)';

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const mModel = content.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const mProv = content.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/m);
    const mUrl = content.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m);
    const mWs = content.match(/^\s*supports_websockets\s*=\s*([a-zA-Z]+)/m);

    if (mModel) currentModel = mModel[1];
    if (mProv) currentProvider = mProv[1];
    if (mUrl) currentBaseUrl = mUrl[1];
    if (mWs) currentWs = mWs[1];

    console.log(`2. Konfiguracja:       ${configPath}`);
    console.log(`   - Domyślny model:   ${currentModel}`);
    console.log(`   - Model provider:   ${currentProvider}`);
    console.log(`   - Base URL:         ${currentBaseUrl}`);
    console.log(`   - WebSockets:       ${currentWs}`);
  } else {
    console.log(`2. Konfiguracja:       ${configPath} (brak pliku)`);
  }

  // 3. Profil codexlb.config.toml
  const profilePath = path.join(codexHome, 'codexlb.config.toml');
  console.log(`3. Profil dedykowany:  ${fs.existsSync(profilePath) ? '[OK] ' + profilePath : '(brak)'}`);

  // 4. Codex CLI w PATH
  const hasCodex = hasCommand('codex');
  let codexVer = '(nie znaleziono)';
  if (hasCodex) {
    try {
      codexVer = execSync('codex --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
      codexVer = 'znaleziono w PATH';
    }
  }
  console.log(`4. Codex CLI w PATH:   ${hasCodex ? '[OK] ' + codexVer : '[Brak] zainstaluj via npm install -g @openai/codex'}`);

  // 5. Test połączenia z proxy
  if (storedKey) {
    process.stdout.write(`5. Test proxy (${targetUrl})... `);
    const start = Date.now();
    try {
      const res = await checkConnection(targetUrl, storedKey, isInsecure);
      const elapsed = Date.now() - start;
      console.log(`OK (${elapsed} ms, HTTP ${res.statusCode})`);
      if (res.models && res.models.length > 0) {
        console.log(`   - Dostępne modele (${res.models.length}): ${res.models.join(', ')}`);
      }
    } catch (err) {
      console.log('BŁĄD');
      console.log(`   - ${err.message}`);
    }
  } else {
    console.log(`5. Test proxy:         Pominięto (brak zapisanego klucza)`);
  }
}

async function handleClean(envFile, codexHome) {
  console.log('=== Czyszczenie konfiguracji i kluczy CodexLB ===\n');

  // 1. Usunięcie zmiennej środowiskowej
  if (isWin) {
    try {
      execSync(`powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $null, 'User')"`);
      console.log('[OK] Usunięto zmienną CODEX_LB_API_KEY z profilu użytkownika Windows.');
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się usunąć zmiennej z rejestru Windows: ${err.message}`);
    }
  } else {
    if (fs.existsSync(envFile)) {
      try {
        fs.unlinkSync(envFile);
        console.log(`[OK] Usunięto plik ${envFile}.`);
      } catch (err) {
        console.warn(`[Ostrzeżenie] Nie udało się usunąć ${envFile}: ${err.message}`);
      }
    }
    for (const rcName of ['.bashrc', '.zshrc']) {
      const rcPath = path.join(os.homedir(), rcName);
      if (fs.existsSync(rcPath)) {
        try {
          const rcContent = fs.readFileSync(rcPath, 'utf-8');
          if (rcContent.includes('# codexlb')) {
            const newContent = rcContent
              .split(/\r?\n/)
              .filter((line) => !line.includes('# codexlb'))
              .join('\n');
            fs.writeFileSync(rcPath, newContent);
            console.log(`[OK] Usunięto wpis codexlb z ~/${rcName}.`);
          }
        } catch (err) {
          console.warn(`[Ostrzeżenie] Błąd podczas modyfikacji ~/${rcName}: ${err.message}`);
        }
      }
    }
  }

  // 2. Czyszczenie ~/.codex/config.toml
  const configPath = path.join(codexHome, 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const backupPath = `${configPath}.bak-${Date.now()}`;
      fs.copyFileSync(configPath, backupPath);
      console.log(`[OK] Kopia dotychczasowej konfiguracji: ${path.basename(backupPath)}`);

      const configLines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
      const filtered = [];
      let skipBlock = false;
      let dropProfile = false;

      for (const line of configLines) {
        if (/^# >>> codexlb/.test(line)) {
          skipBlock = true;
          continue;
        }
        if (/^# <<< codexlb/.test(line)) {
          skipBlock = false;
          continue;
        }
        if (skipBlock) continue;

        if (/^\s*\[profiles\.codexlb\]/.test(line)) {
          dropProfile = true;
          continue;
        }
        if (dropProfile && /^\s*\[/.test(line)) {
          dropProfile = false;
        }
        if (dropProfile) continue;

        filtered.push(line);
      }

      const cleanedContent = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      fs.writeFileSync(configPath, cleanedContent);
      console.log(`[OK] Usunięto sekcje codexlb z ${configPath}.`);
    } catch (err) {
      console.warn(`[Ostrzeżenie] Błąd podczas czyszczenia ${configPath}: ${err.message}`);
    }
  }

  // 3. Usunięcie profilu codexlb.config.toml
  const profilePath = path.join(codexHome, 'codexlb.config.toml');
  if (fs.existsSync(profilePath)) {
    try {
      fs.unlinkSync(profilePath);
      console.log(`[OK] Usunięto profil ${profilePath}.`);
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się usunąć ${profilePath}: ${err.message}`);
    }
  }

  console.log('\n=== Czyszczenie zakończone! ===');
  if (isWin) {
    console.log('Zrestartuj terminale lub VS Code, aby odświeżyć zmienne środowiskowe.');
  } else {
    console.log('Otwórz nową powłokę lub wykonaj: unset CODEX_LB_API_KEY');
  }
}

async function main() {
  const envFile = process.env.CODEXLB_ENV_FILE || path.join(os.homedir(), '.config', 'codexlb.env');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  if (isRestore) {
    await handleRestore(codexHome);
    return;
  }

  if (isStatus) {
    await handleStatus(envFile, codexHome);
    return;
  }

  if (isClean) {
    await handleClean(envFile, codexHome);
    return;
  }

  console.log('=== Konfigurator klienta CodexLB dla Codex CLI i VS Code ===\n');

  // 1. Klucz API
  if (!apiKey) {
    apiKey = getStoredApiKey(envFile);
    if (apiKey) {
      console.log(`Używam zapisanego wcześniej klucza: ${maskKey(apiKey)}`);
    }
  }

  if (!apiKey) {
    apiKey = await promptHidden(`Klucz API z panelu ${targetUrl} (zakładka /apis), wklej i Enter: `);
    console.log('');
  }

  if (!apiKey) {
    console.error('BŁĄD: Nie podano klucza API.');
    process.exit(1);
  }

  // 2. Weryfikacja klucza na żywo i pobranie modeli
  process.stdout.write(`Sprawdzam klucz na ${targetUrl}... `);
  let availableModels = [];
  try {
    const conn = await checkConnection(targetUrl, apiKey, isInsecure);
    console.log('OK — klucz działa, proxy odpowiada!\n');
    availableModels = conn.models || [];
    if (availableModels.length > 0) {
      console.log(`Dostępne modele na proxy (${availableModels.length}): ${availableModels.join(', ')}`);
      if (!availableModels.includes(model)) {
        console.warn(`[Ostrzeżenie] Model "${model}" nie widnieje na liście modeli proxy.`);
      }
    }
  } catch (err) {
    console.log('BŁĄD!');
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  // 3. Zmienne środowiskowe
  if (isWin) {
    try {
      // Bezpieczne przekazanie wartości przez zmienną środowiskową procesu potomnego
      execSync(`powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('CODEX_LB_API_KEY', $env:TMP_KEY, 'User')"`, {
        env: { ...process.env, TMP_KEY: apiKey },
      });
      console.log('[OK] Zapisano CODEX_LB_API_KEY w profilu użytkownika Windows.');
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się zapisać zmiennej w rejestrze Windows: ${err.message}`);
    }
  } else {
    // Linux / macOS
    try {
      const configDir = path.dirname(envFile);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, `export CODEX_LB_API_KEY="${apiKey}"\n`, { mode: 0o600 });
      console.log(`[OK] Klucz zapisany w ${envFile} (chmod 600).`);

      const srcLine = `. "${envFile}"  # codexlb`;
      for (const rcName of ['.bashrc', '.zshrc']) {
        const rcPath = path.join(os.homedir(), rcName);
        if (fs.existsSync(rcPath)) {
          const rcContent = fs.readFileSync(rcPath, 'utf-8');
          if (!rcContent.includes('# codexlb')) {
            fs.appendFileSync(rcPath, `\n${srcLine}\n`);
            console.log(`[OK] Dopisano ładowanie klucza do ~/${rcName}.`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Ostrzeżenie] Nie udało się zapisać ${envFile}: ${err.message}`);
    }
  }

  // 4. Konfiguracja ~/.codex/config.toml
  if (!fs.existsSync(codexHome)) fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(codexHome, 'config.toml');

  let configLines = [];
  if (fs.existsSync(configPath)) {
    const backupPath = `${configPath}.bak-${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    console.log(`[OK] Kopia dotychczasowej konfiguracji: ${path.basename(backupPath)}`);
    configLines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
  }

  // Filtruj linie starego bloku codexlb oraz ewentualnych starych profili
  const filtered = [];
  let skipBlock = false;
  let dropProfile = false;
  let seenTable = false;

  for (const line of configLines) {
    if (/^# >>> codexlb/.test(line)) {
      skipBlock = true;
      continue;
    }
    if (/^# <<< codexlb/.test(line)) {
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;

    if (/^\s*\[profiles\.codexlb\]/.test(line)) {
      dropProfile = true;
      continue;
    }
    if (dropProfile && /^\s*\[/.test(line)) {
      dropProfile = false;
    }
    if (dropProfile) continue;

    if (/^\s*\[/.test(line)) {
      seenTable = true;
    }

    if (setDefault && !seenTable && /^\s*(model|model_provider|model_reasoning_effort)\s*=/.test(line)) {
      continue;
    }

    filtered.push(line);
  }

  const newLines = [];
  if (setDefault) {
    newLines.push('# >>> codexlb-default >>> (zarzadzane przez codexlb-setup)');
    newLines.push(`model = "${model}"`);
    newLines.push('model_provider = "codex-lb"');
    newLines.push(`model_reasoning_effort = "${effort}"`);
    newLines.push('# <<< codexlb-default <<<\n');
  }

  newLines.push(...filtered);

  newLines.push('');
  newLines.push('# >>> codexlb >>> (zarzadzane przez codexlb-setup)');
  newLines.push('# Codex CLI gada z proxy po /backend-api/codex — to inna sciezka niz /v1,');
  newLines.push('# ktorej uzywaja biblioteki OpenAI. Klucz idzie ze zmiennej srodowiskowej.');
  newLines.push('[model_providers.codex-lb]');
  newLines.push('name = "openai"');
  newLines.push(`base_url = "${targetUrl}/backend-api/codex"`);
  newLines.push('wire_api = "responses"');
  newLines.push(`supports_websockets = ${useWs}`);
  newLines.push('requires_openai_auth = true');
  newLines.push('env_key = "CODEX_LB_API_KEY"');
  newLines.push('# <<< codexlb <<<');

  fs.writeFileSync(configPath, newLines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', { mode: 0o600 });
  console.log(`[OK] Zapisano ${configPath}.`);

  // 5. Profil ~/.codex/codexlb.config.toml (dla codex --profile codexlb)
  const profilePath = path.join(codexHome, 'codexlb.config.toml');
  const profileContent = `# Profil "codexlb" — zarzadzane przez codexlb-setup.
# Uzycie: codex --profile codexlb
model = "${model}"
model_provider = "codex-lb"
model_reasoning_effort = "${effort}"
`;
  fs.writeFileSync(profilePath, profileContent, { mode: 0o600 });
  console.log(`[OK] Zapisano profil ${profilePath}.`);

  // 6. Test e2e (opcjonalny)
  if (runTest) {
    if (!hasCommand('codex')) {
      console.log('\n[Uwaga] Polecenie "codex" nie zostało znalezione w PATH.');
      console.log('Konfiguracja została pomyślnie zapisana. Aby uruchomić test, zainstaluj Codex CLI:');
      console.log('    npm install -g @openai/codex');
    } else {
      console.log('\nPróbne zapytanie przez proxy (może chwilę potrwać)...');
      try {
        const env = { ...process.env, CODEX_LB_API_KEY: apiKey };
        const out = execSync('codex exec --profile codexlb --skip-git-repo-check "Odpowiedz jednym slowem: ok"', {
          env,
          encoding: 'utf-8',
          timeout: 180000,
        });
        console.log(out.trim());
      } catch (err) {
        const text = (err.stdout || '') + (err.stderr || '') + err.message;
        if (/No available accounts|429|usage limit|owner account is unavailable/.test(text)) {
          console.log('\nUwaga: Połączenie i klucz są poprawne — konta ChatGPT osiągnęły limit.');
          console.log(`Zużycie i reset limitów sprawdzisz w panelu ${targetUrl}.`);
        } else if (/401|invalid_api_key/.test(text)) {
          console.log('\nSerwer odrzucił klucz przy zapytaniu — wygeneruj nowy w /apis.');
        } else {
          console.log(`\nWynik testu: ${text.trim()}`);
        }
      }
    }
  }

  console.log('\n=== Gotowe! ===');
  if (isWin) {
    console.log('Zrestartuj terminale lub VS Code, aby wczytały nowy klucz CODEX_LB_API_KEY.');
  } else {
    console.log(`W nowej powłoce (albo po: . "${envFile}") uruchamiaj:`);
  }
  if (setDefault) {
    console.log('    codex                      # codexlb jest teraz domyślny');
  }
  console.log('    codex --profile codexlb    # jawnie przez profil proxy');
}

main().catch((err) => {
  console.error('\nNieoczekiwany błąd:', err);
  process.exit(1);
});
