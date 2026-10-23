<div align="right">
  <strong>🌐 Język:</strong>
  <a href="README.md">English</a> |
  <a href="README.pl.md"><strong>Polski</strong></a>
</div>

# ⚖️ agent-lb

> **Uniwersalny Load Balancer wielu kont, rotator limitów i nowoczesny Dashboard Webowy dla Claude Code oraz OpenAI Codex CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](docker/Dockerfile)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

`agent-lb` działa jako inteligentne proxy pomiędzy Twoimi narzędziami programistycznymi ([Claude Code](https://claude.ai/claude-code), [rozszerzenie VS Code Claude](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code), OpenAI Codex CLI, Cursor, Roo Code, OpenCode, Hermes, Aider) a dostawcami modeli AI (Anthropic, OpenAI). Łączy wiele kont Claude (Max, Pro, Team, klucze API) oraz OpenAI Codex w jedną wspólną pulę i automatycznie rotuje ruch przed osiągnięciem limitów — zapobiegając przerwom w pracy programistów i błędom 429 quota exhaustion.

---

## 🌟 Główne zalety i możliwości

- **⚡ Pula wielu kont i adaptacyjna rotacja**: Obsługuje jednocześnie wiele kont Anthropic i OpenAI Codex, automatycznie przełączając na kolejne konto przed wyczerpaniem limitu sesyjnego (okno 5h) lub tygodniowego (7 dni). Domyślny próg to 98% (konfigurowalny).
- **🧠 Podwójne wsparcie dla Claude i OpenAI Codex**: Pełne wsparcie dla zapytań Anthropic Claude (`/v1/messages`) oraz OpenAI Codex / ChatGPT (`/backend-api/codex`, `/backend-api/wham`, `/v1/responses`, `/v1/chat/completions`) z automatyczną obsługą OAuth PKCE i kluczy API.
- **⚖️ Sprawiedliwy podział pasma (Max-Min Fair Share)**: Zapobiega blokowaniu interaktywnych sesji kodowania przez ciężkie zadania wsadowe lub działające w tle autonomiczne agenty (np. Hermes), dynamicznie dławiąc najbardziej agresywne strumienie.
- **⏰ Inteligentny harmonogram i podgrzewanie sesji (Keep-Warm)**: Utrzymuje gotowość i ciepłą pamięć podręczną modeli w godzinach pracy, automatycznie wstrzymując zapytania w nocy i w weekendy, oszczędzając limity kont.
- **🛡️ Deduplikacja wywołań narzędzi i ochrona przed powtórzeniami (Replay Safety)**: Śledzi operacje o skutkach ubocznych (edycje plików, polecenia bash) przy użyciu deterministycznych sygnatur, chroniąc przed podwójnym wykonaniem w przypadku chwilowych problemów z siecią lub automatycznych ponowień klienta.
- **📊 Interaktywny panel webowy w czasie rzeczywistym**: Responsywny Dashboard (`/dashboard`) w języku polskim i angielskim, prezentujący stan kont, zużycie tokenów, aktywne połączenia, salda przedpłat i stacje robocze, odświeżany na żywo przez WebSocket i SSE.
- **🔄 Ponowne logowanie 1-kliknięciem w Dashboardzie**: Wygodne odnawianie wygasłych sesji OAuth kont Anthropic lub OpenAI Codex bezpośrednio w przeglądarce bez konieczności logowania na serwer przez SSH.
- **🛠️ Błyskawiczne instalatory stacji roboczych (All-in-One)**: Jednolinijkowe polecenia instalacyjne dla systemów Linux, macOS, WSL oraz Windows PowerShell, które automatycznie instalują pakiety CLI, konfigurują profile powłoki, rozszerzenia VS Code oraz tworzą kopie zapasowe konfiguracji OAuth.
- **👥 Niezależne klucze stacji roboczych (Multi-Tenant)**: Generowanie osobnych kluczy dostępowych (`tc-...`) dla członków zespołu i agentów, z osobnymi statystykami tokenów, limitami dziennymi/miesięcznymi i ograniczeniami dostawców (`allowedProviders`).
- **🪶 Zero zewnętrznych zależności**: Projekt oparty w 100% na wbudowanych modułach Node.js (`http`, `https`, `crypto`, `net`). Wyjątkowo lekki, startuje w ułamku sekundy.
- **🔒 Bezpieczeństwo od pierwszego uruchomienia**: Automatyczne omijanie bramki dla ruchu lokalnego (loopback) oraz sieci Tailscale, porównania kluczy odporne na ataki czasowe (constant-time), restrykcyjna polityka Content Security Policy (CSP) i zero sekretów w repozytorium.
- **🐳 Gotowy do pracy w Dockerze i pod systemd**: Gotowy plik `Dockerfile`, `docker-compose.yml` oraz prosta integracja jako usługa `systemd`.

---

## 🏗️ Architektura systemu

```mermaid
flowchart TD
    subgraph Klienci["Stacje robocze programistów i agenci"]
        C1["Claude Code CLI (Linux/macOS)"]
        C2["Rozszerzenie VS Code (Windows)"]
        C3["OpenAI Codex CLI"]
        C4["Agenci w tle / Batch (Hermes, OpenCode)"]
    end

    subgraph Proxy["AgentLB Proxy & Dashboard (Port 3456)"]
        Gate["Bramka API Key & Tailscale"]
        FairShare["Max-Min Fair Share Admission"]
        Dedupe["Deduplikacja Tool Call & Replay Guard"]
        Router["Inteligentny Rotator Kont"]
        Warmer["Harmonogram Keep-Warm (Godziny pracy)"]
        Dash["Web Dashboard & Admin API"]
        Gate --> FairShare
        FairShare --> Dedupe
        Dedupe --> Router
        Warmer -.->|Pre-warm| Router
        Gate --> Dash
    end

    subgraph Upstream["Dostawcy Upstream"]
        A1["Konto 1 (Claude Max - Aktywne)"]
        A2["Konto 2 (Claude Pro - Zapasowe)"]
        A3["Konto 3 (Klucz API Prepaid)"]
        A4["Konto 4 (OpenAI Codex OAuth / API)"]
    end

    C1 -->|ANTHROPIC_BASE_URL| Gate
    C2 -->|Adres Proxy| Gate
    C3 -->|CODEX_BASE_URL| Gate
    C4 -->|x-api-key / Bearer| Gate
    Router -->|Wstrzyknięcie tokenu| A1
    Router -.->|Przełączenie po limicie| A2
    Router -.->|Fallback awaryjny| A3
    Router -.->|Ruch Codex| A4
```

---

## 🚀 Szybki start (Instalacja serwera)

### Opcja 1: Uruchomienie z repozytorium Git (Zalecane)

Wymagane środowisko: **Node.js 20+**:

```bash
git clone https://github.com/tomaasz/agent-lb.git
cd agent-lb

# Uruchomienie z interaktywnym interfejsem TUI w konsoli
npm start

# Lub uruchomienie w trybie usługi w tle (headless daemon — zalecane dla serwerów)
node src/index.js headless
```

Podczas pierwszego startu, `agent-lb` automatycznie wygeneruje główny klucz administratora i wyświetli adres panelu:

```text
Agent-LB proxy listening on 0.0.0.0:3456
Web Dashboard: http://localhost:3456/dashboard
Admin Key: tc-adm_xxxxxxxxxxxxxxxx
```

---

### Opcja 2: Kontener Docker & Docker Compose

```bash
git clone https://github.com/tomaasz/agent-lb.git
cd agent-lb/docker

# Uruchomienie kontenera w tle
docker compose up -d
```

Konfiguracja i konta są trwale zachowywane w katalogu wolumenu `docker/data/agent-lb.json`.

---

### Opcja 3: Usługa systemowa systemd (Linux)

Instalacja jako usługa użytkownika w `systemd`:

```bash
mkdir -p ~/.config/systemd/user
cat << 'EOF' > ~/.config/systemd/user/agentlb.service
[Unit]
Description=AgentLB Multi-Account Proxy Service
Documentation=https://github.com/tomaasz/agent-lb
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/agent-lb
ExecStart=/usr/bin/node %h/agent-lb/src/index.js headless
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agentlb
```

---

## 💻 Podłączanie klientów (Stacji programistów)

Podłączenie komputera programisty wymaga tylko **jednego polecenia**. Serwer dynamicznie serwuje skrypt instalacyjny dostosowany do Twojego serwera:

### Zunifikowany instalator All-in-One (Claude Code + OpenAI Codex + VS Code)

#### Linux / macOS / WSL:

```bash
# Tryb interaktywny (zapyta o klucz stacji w terminalu):
curl -fsSL http://twoj-serwer:3456/setup.sh | bash

# Tryb natychmiastowy z podaniem klucza:
curl -fsSL http://twoj-serwer:3456/setup.sh | bash -s -- --key tc-KLUCZ_STACJI
```

#### Windows (PowerShell):

```powershell
# Tryb interaktywny:
& ([scriptblock]::Create((irm http://twoj-serwer:3456/setup.ps1)))

# Tryb natychmiastowy z podaniem klucza:
& ([scriptblock]::Create((irm http://twoj-serwer:3456/setup.ps1))) -Key tc-KLUCZ_STACJI
```

> **Wykrywanie WSL na Windowsie**: Skrypt `setup.ps1` uruchomiony w PowerShell automatycznie wykrywa zainstalowane dystrybucje WSL (np. Debian, Ubuntu) i wyświetla gotową komendę, którą możesz wkleić do konsoli WSL, by skonfigurować oba środowiska jednocześnie.

#### Opcje i parametry instalatora:

- `--key <KLUCZ>` / `-Key <KLUCZ>`: Bezpośrednie podanie klucza stacji roboczej.
- `--url <URL>` / `-Url <URL>`: Wskazanie adresu serwera proxy (np. `https://agentlb.twojadomena.pl`).
- `--lang <pl|en>` / `-Lang <pl|en>`: Wymuszenie języka komunikatów instalatora.
- `--test` / `-Test`: Wykonanie testu diagnostycznego połączenia i autoryzacji bez modyfikacji plików.
- `--no-install`: Pominięcie automatycznej instalacji pakietów npm (`@anthropic-ai/claude-code`, `@openai/codex`).
- `--with-agy`: Dodatkowo instaluje agybridge (lokalny AGY, patrz niżej).
- `--uninstall` / `-Uninstall`: Usunięcie zmiennych proxy ze środowiska i przywrócenie kopii zapasowych konfiguracji.

---

### Co instalator wykonuje w pełni automatycznie:

1. **Weryfikacja środowiska**: Sprawdza dostępność Node.js oraz npm; w razie braku narzędzi CLI automatycznie instaluje globalnie `@anthropic-ai/claude-code` i `@openai/codex`.
2. **Autoryzacja na żywo**: Sprawdza poprawność klucza i komunikację z endpointami serwera (`/v1/models` oraz `/backend-api/codex/models`).
3. **Czysta konfiguracja bez konfliktów OAuth**: Tworzy bezpieczną kopię zapasową istniejących plików (`.bak`) i zapobiega błędom kolizji autoryzacji.
4. **Konfiguracja narzędzi**: Aktualizuje pliki `~/.claude/settings.json` oraz `~/.codex/config.json` / `config.toml`.
5. **Wsparcie dla VS Code**: Automatycznie konfiguruje oficjalne rozszerzenia VS Code dla Claude Code i OpenAI Codex.
6. **Trwałość konfiguracji**: Zapisuje zmienne proxy w profilach powłoki (`~/.bashrc`, `~/.zshrc`, `~/.config/agent-lb.env`) lub w Rejestrze Użytkownika Windows. W przypadku sesji OAuth w `~/.claude/.credentials.json`, instalator zachowuje tryb subskrypcji Claude Code, ustawiając nagłówek `ANTHROPIC_CUSTOM_HEADERS=x-api-key: <klucz-proxy>`. Proxy transparentnie przejmuje ten nagłówek i podmienia dane uwierzytelniające na aktywne konto z puli.

---

### AGY (Antigravity CLI) przez agybridge

AGY (modele Gemini) działa teraz przez proxy, dla każdego klienta i z tym samym kluczem co Claude/Codex. Serwer agent-lb potrzebuje zainstalowanego [agybridge](https://github.com/tomaasz/agybridge) (domyślna komenda `agybridge`; inną ścieżkę ustawia `config.agy.bridgeCommand`; opcjonalnie `config.agy.homesDir` i `config.agy.accountsPath`). Konta Google dodajesz w panelu (Konta → AGY → *Zaloguj konto Google*); pula wybiera konto i przełącza się na następne, gdy limit się wyczerpie przed pierwszym tokenem odpowiedzi. Modele są listowane na żywo z `agy models` (tylko Gemini), każdy poziom wysiłku to osobny model w `/v1/models`; aliasy `agy` i `agy-fast` są nadal przyjmowane, ale ukryte na liście. `hermes-setup.sh` dopisuje te modele `gemini-*` do providera `agentlb`.

Uczciwie o kosztach: każde żądanie uruchamia jeden proces `agy` (ok. 10 s, ok. 13 tys. tokenów promptu), na jedno konto przypadają maks. 2 żądania naraz, a pierwsza odpowiedź przychodzi jako jeden kawałek po komentarzach keep-alive.

**Tryb stacji (bez zmian).** Możesz też nadal uruchamiać AGY lokalnie na stacji, na koncie Google zalogowanym tam w `agy`, przez agybridge:

```bash
curl -fsSL https://agentlb.twojadomena.pl/agy-setup.sh | bash
# albo razem z głównym instalatorem:
curl -fsSL https://agentlb.twojadomena.pl/setup.sh | bash -s -- --key <KLUCZ> --with-agy
```

Skrypt sprawdza Pythona 3.11+ i `agy`, instaluje agybridge we własnym virtualenvie (używa istniejącej kopii w `~/projekty/agybridge` lub `~/agybridge`, w przeciwnym razie `~/.local/share/agybridge`), generuje token lokalnego serwera w `~/.config/agybridge/agybridge.env` (uprawnienia 600, nigdy nie jest wypisywany), uruchamia `agybridge serve` na `127.0.0.1:8791` jako usługę systemd użytkownika i podłącza to, co jest zainstalowane: wtyczkę AGY Hermesa (dowiązanie; potem uruchom `hermes-setup.sh`, żeby dodać providery `agy` / `agy-fast`), provider `agy` w OpenCode i OpenClaw oraz serwer MCP `agybridge` w Claude Code. Jest idempotentny — ponowne uruchomienie aktualizuje. Opcje: `--dir`, `--ref`, `--port`, `--no-service`, `--no-hermes`, `--no-opencode`, `--no-claw`, `--no-claude`. Samo zalogowanie do `agy` to jednorazowy krok ręczny.


**Pula kont Google.** Konta Google dla AGY logujesz w panelu (Konta → AGY → *Zaloguj konto Google*): proxy uruchamia `agy` w tymczasowym katalogu, pokazuje link zgody Google z wyborem konta i przyjmuje kod ze strony `antigravity.google` (AGY czeka na niego 60 s). Konta są zapisywane w `agent-lb.agy-accounts.json` obok konfiguracji (uprawnienia 600, tokeny nigdy nie trafiają do panelu). Stacje z agybridge i kluczem stacji (`agy-setup.sh --key`) pobierają konto z `GET /agy/credential` i zgłaszają wyczerpany limit do `POST /agy/quota`; proxy wydaje wtedy następne konto z wolnym limitem. W panelu można przypiąć, wyłączyć, przestawić kolejność albo wyczyścić limit. Dane logowania dostają tylko nieograniczone klucze stacji.

---

## 🖥️ Panel Webowy (Web Dashboard)

Panel zarządzania dostępny jest pod adresem:

```text
http://twoj-serwer:3456/dashboard
```

### Możliwości panelu:

- **🌐 Dwujęzyczność (PL / EN)**: Szybki przełącznik języka w prawym górnym rogu zapamiętywany w przeglądarce.
- **🎨 Tryb ciemny / jasny**: Wygodne dopasowanie motywu graficznego.
- **🤖 Zarządzanie kontami**: Podgląd wykorzystania limitów 5h i 7d, salda prepaid, kolejności priorytetów (metoda przeciągnij-i-upuść ⠿) oraz stanu zdrowia kont.
- **🔐 Logowanie OAuth 1-kliknięciem**: Dodawanie i odnawianie kont Claude oraz Codex bezpośrednio z poziomu przeglądarki (w tym logowanie kodem urządzenia Device Code na serwerach bez GUI).
- **💻 Zarządzanie stacjami**: Generowanie kluczy stacji, limity tokenów, podgląd gotowych komend instalacyjnych z listą wyboru stacji.
- **💬 Test Chat & Playground**: Wbudowany komunikator do bezpośredniego testowania odpowiedzi modeli Claude i Codex na żywo przez proxy.
- **📊 Szczegółowe raporty zużycia (Kto i Na co)**: Raporty tokenów w podziale na stacje, sesje, projekty i modele.

---

## ⚙️ Zaawansowana konfiguracja (`agent-lb.json`)

Konfiguracja przechowywana jest w pliku `agent-lb.json` (lub `~/.config/agent-lb.json`):

```json
{
  "port": 3456,
  "bind": "0.0.0.0",
  "proxy": {
    "apiKey": "tc-adm_twoj_klucz_administratora",
    "thresholdPercent": 98,
    "maxBodyBytes": 67108864,
    "allowedHosts": ["agentlb.twojadomena.pl"]
  },
  "sessions": {
    "mode": "adaptive"
  },
  "expiryRouting": {
    "enabled": true
  },
  "crossProviderFallback": true,
  "autoHealthCheck": {
    "enabled": true,
    "intervalSeconds": 900
  },
  "accounts": [
    {
      "name": "Konto-Claude-Glowne",
      "provider": "anthropic",
      "type": "oauth",
      "priority": 10
    }
  ]
}
```

---

## 🧪 Testy i weryfikacja

Uruchomienie wbudowanego zestawu testów jednostkowych i integracyjnych:

```bash
npm test
```

Projekt posiada ponad 140 rygorystycznych testów sprawdzających routing, autoryzację, deduplikację narzędzi, strumieniowanie SSE oraz obsługę błędów upstream.

---

## 📄 Licencja

Projekt udostępniany na warunkach licencji [MIT](LICENSE).
Możesz go swobodnie wdrażać, modyfikować i hostować we własnej infrastrukturze.

### Diagnostyka kont AGY

W panelu AGY przycisk 🔎 odczytuje dostęp, plan, modele i pozostałe limity bez
wywoływania generacji. „Sprawdź pulę” wymusza odczyt wszystkich włączonych kont.
Historia partii (20) i zmian stanu (100) przeżywa restart. Ostatnie poprawne
pomiary pozostają widoczne jako nieaktualne po błędzie; nieznany plan nie jest
klasyfikowany jako Free. Lista modeli nie potwierdza działania generacji.

Automatyczne sprawdzanie działa co 6 godzin, dla kont z restrykcjami co najmniej
co 24 godziny, po maksymalnie 5 kont na turę. Błędy mają narastającą przerwę
15 min–6 h; odroczenie Google `Retry-After` jest respektowane. Wyłączenie:
`agy.checksEnabled: false`. Ręczne sprawdzenie może objąć wyłączone konto.

Do odświeżania OAuth skonfiguruj `AGY_GOOGLE_CLIENT_SECRET` oraz opcjonalnie
`AGY_GOOGLE_CLIENT_ID` w prywatnym środowisku usługi, zgodnie z klientem OAuth
użytym przez zainstalowany CLI. Bez sekretu można użyć wyłącznie niewygasłego
access tokena. Diagnostyka nie zmienia tokena zapisanego dla stacji.

Potwierdzone wymaganie weryfikacji/subskrypcji, naruszenie TOS, odmowa dostępu
modeli lub nieważny refresh token wykluczają konto z przydziału. Sam błąd
metadanych lub quota summary tego nie robi. Błąd sieci nie kasuje uprzednio
potwierdzonej restrykcji; usuwa ją poprawne sprawdzenie albo ponowne logowanie.
Istniejące blokady zgłoszone przez faktyczne żądania mają własny cykl życia.

API administratora: `POST /api/agy/accounts/check` (`{id}` lub `{}`),
`GET /api/agy/history`. Nakładająca się partia zwraca 409. Magazyn zachowuje
szyfrowanie, zapis atomowy 0600, fsync i blokady między procesami. Blokada
osierocona po martwym PID jest odzyskiwana. Nieczytelna blokada albo przerwany
proces odzyskiwania (`.recovery`) wymagają ręcznego usunięcia blokad po
zatrzymaniu wszystkich procesów używających magazynu; nie usuwać ich w trakcie
aktywnego sprawdzania. Uszkodzony plik danych nigdy nie jest zastępowany pustym.
