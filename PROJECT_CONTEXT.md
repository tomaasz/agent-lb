# Project Context: agent-lb (AgentLB)

## Cel projektu
Uniwersalny load balancer, rotator kont, zarządca limitów (quota rotator) oraz panel webowy (dashboard) i interfejs TUI dla narzędzi Claude Code oraz OpenAI / Codex. Projekt umożliwia transparentne przekierowywanie ruchu przez lokalny serwer proxy, rotację wielu kont po wyczerpaniu limitów zapytań, sprawiedliwe kolejkowanie (fair-share), deduplikację wywołań narzędzi (tool-call deduplication), śledzenie sesji i planowanie podtrzymywania gotowości (warmup schedule).

## Stack
- Runtime: Node.js (>= 20.0.0, format modułów ESM `"type": "module"`)
- Serwer / Proxy: Wbudowane moduły Node.js `http`, `https`, `tls`, `net`, `stream` (brak zewnętrznych frameworków webowych)
- Frontend Panelu: Czysty JavaScript / HTML / CSS osadzony w `src/dashboard.js`
- Interfejs terminalowy: `src/tui.js`, `src/tui-remote.js`
- Skrypty instalacyjne klienta: Node.js CJS (`setup/setup.js`, `setup/package.json`), Bash (`setup/setup.sh`), PowerShell (`setup/setup.ps1`)
- Test runner: Wbudowany `node:test` oraz `node:assert`
- Konteneryzacja: Docker (`docker/Dockerfile`, `docker/docker-compose.yml`)

## Główne komendy
- install: `npm install` (cwd: `.`, wymagania: Node.js >=20, źródło: `package.json`, status: nieuruchomione w ramach audytu)
- start: `npm start` / `node src/index.js` (cwd: `.`, wymagania: Node.js >=20, źródło: `package.json`, status: potwierdzona w konfiguracji)
- test: `npm test` / `node --test --test-timeout=120000` (cwd: `.`, wymagania: Node.js >=20, źródło: `package.json`, status: potwierdzona i uruchomiona — 78 testów bazowych audytu przechodzi pomyślnie; dodatkowe regresje w test/audit-hardening.test.js)
- lint: `npm run lint` / `eslint .` (cwd: `.`, wymagania: eslint, status: zweryfikowana i pomyślna — ESLint v9 flat config `eslint.config.js`)
- typecheck: brak w repozytorium (projekt nie używa TypeScript)
- build: brak (projekt to czysty kod JavaScript ESM wykonywany bezpośrednio przez środowisko Node.js)

## Krytyczne obszary
- `src/oauth.js`, `src/codex-auth.js`, `src/account-manager.js`: Zarządzanie tokenami OAuth, poświadczeniami i profilami użytkowników.
- `src/x509.js`, `src/mitm.js`: Generowanie certyfikatów TLS, inspekcja i przechwytywanie połączeń HTTPS.
- `src/server.js`, `src/upstream-proxy.js`, `src/upstream-fetch.js`, `src/provider.js`: Logika przekierowywania ruchu, obsługa strumieni SSE i translacja nagłówków.
- `src/backend-quota.js`, `src/codex-quota.js`, `src/fair-share.js`: Śledzenie limitów tokenów, estymacja wyczerpania i dławienie żądań.
- `setup/setup.sh`, `setup/setup.js`, `setup/setup.ps1`: Skrypty modyfikujące konfiguracje środowiska i powłok użytkownika.

## Obszary wymagające jawnej zgody przed zmianą
- Pliki poświadczeń, tokenów, struktury przechowywania kluczy i certyfikatów CA.
- Modyfikacje reguł `.gitignore` chroniących sekrety (`.env`, `*.credentials.json`, `config.json`).
- Zmiany w logice proxy MITM wpływające na bezpieczeństwo połączeń szyfrowanych.
- Skrypty automatycznej konfiguracji powłoki (`setup/*`).
- Wszelkie operacje sieciowe, deploy oraz publikacja obrazów Docker na środowiska zewnętrzne.
- **Zasada Git:** Po pomyślnej weryfikacji i testach ZAWSZE twórz commity i pushuj zmiany na `origin`. Samowolny merge do chronionych/produkcyjnych gałęzi oraz deploy nadal wymagają zgody.

## Konwencje
- Nowy kod w `src/` oraz `test/` pisany wyłącznie jako standardowe moduły ECMAScript (ESM) z jawnymi rozszerzeniami `.js`.
- Skrypty pomocnicze w `setup/` zachowują CommonJS (`setup/package.json`), aby działać w różnych środowiskach bootstrapu.
- Zero zewnętrznych zależności runtime poza wbudowanymi bibliotekami Node.js (lekka, samowystarczalna architektura).
- Zasada ZERO SEKRETÓW: absolutny zakaz umieszczania tokenów, kluczy prywatnych i danych logowania w repozytorium.

## Komponenty monorepo
Nie dotyczy (pojedyncze repozytorium).

## Definition of Done
- Wymaganie spełnione, adekwatne testy zakończone powodzeniem (`node --test --test-timeout=120000`).
- Brak naruszeń bezpieczeństwa, wycieków tokenów ani niejawnych zmian certyfikatów.
- Wymagane recenzje agentów zakończone bez nierozwiązanych uwag `CHANGES_REQUIRED`.
- Zgodność ze standardem ESM i brak nieudokumentowanych zależności zewnętrznych.
- Zmiany zatwierdzone w commicie i wypchnięte (`git push`) do repozytorium zdalnego.
