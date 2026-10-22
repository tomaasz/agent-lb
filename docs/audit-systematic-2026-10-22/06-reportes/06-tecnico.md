# Raport techniczny

## BUG-001 — Poświadczenia panelu i proxy przekazywane do upstream

**High / Security / CWE-200 / Verified**. Baza: `509ddf1`, src/server.js:6876, src/server.js:7059.

HTTP/WS relay kopiował cookie sesji i Bearer klucza proxy. Przejęcie sesji/klucza przez operatora upstream; zależy od użycia ścieżek relay.

Przyczyna: Brak rozdzielenia poświadczeń obu hopów. Poprawka: Filtrowanie agentlb_session i Bearer odpowiadającego master/client key; zachowanie upstream cookies/Bearer.

Oczekiwane: Upstream otrzymuje wyłącznie własną tożsamość klienta.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-relay.test.js`. Dowody: 05-validacion/relay-red.log, 05-validacion/relay-green.log.

## BUG-002 — Strumieniowy fallback pomijał limity tokenów

**High / Functional / CWE-840 / Verified**. Baza: `509ddf1`, src/server.js:9414, src/server.js:9463.

Dwa żądania po 150 tokenów zwracały 200 przy limicie dobowym 1; licznik pozostawał 0. Nieograniczone wydatki/zużycie kont przez delegowany klucz.

Przyczyna: Pipeline translacji nie wywoływał księgowania SSE. Poprawka: Pomiar surowego SSE przed translacją; jeden scalony zapis w finally.

Oczekiwane: Drugie żądanie otrzymuje 429; pierwsze księguje 150 tokenów raz.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-quota.test.js`. Dowody: 05-validacion/quota-red.log, 05-validacion/quota-green.log.

## BUG-003 — JSON OpenAI nie naliczał limitu klienta

**High / Functional / CWE-840 / Verified**. Baza: `509ddf1`, src/server.js:9930.

Dwa żądania JSON po 150 tokenów zwracały 200 przy limicie 1. Obejście limitów klienta w natywnym OpenAI JSON.

Przyczyna: Parser rozumiał wyłącznie input_tokens/output_tokens. Poprawka: Normalizacja aliasów z operatorem ?? bez podwójnego księgowania.

Oczekiwane: Standardowe prompt_tokens/completion_tokens obciążają limit i sesję.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-quota.test.js`. Dowody: 05-validacion/quota-red.log, 05-validacion/quota-green.log.

## BUG-004 — Uszkadzanie Unicode na granicach fragmentów SSE

**Medium / Integration / CWE-176 / Verified**. Baza: `509ddf1`, src/provider-translator.js:298, src/provider-translator.js:665, src/provider-translator.js:881.

Oddzielne dekodowanie fragmentów TCP zmieniało polskie znaki/emoji w znaki zastępcze. Uszkodzenie odpowiedzi i potencjalnie argumentów narzędzi.

Przyczyna: chunk.toString(utf8) bez stanu dekodera. Poprawka: StringDecoder osobno dla każdego z trzech transformatorów.

Oczekiwane: Tekst pozostaje identyczny niezależnie od podziału bajtów.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-utf8.test.js`. Dowody: 05-validacion/utf8-red.log, 05-validacion/utf8-green.log.

## BUG-005 — Podatny brace-expansion w narzędziach deweloperskich

**High / SupplyChain / CWE-674 / Verified**. Baza: `509ddf1`, package-lock.json:319.

npm audit zgłaszał high dla brace-expansion 1.1.18. DoS narzędzi przy spreparowanym wzorcu; brak tej zależności w runtime proxy.

Przyczyna: Stary lockfile zależności ESLint. Poprawka: Aktualizacja tylko lockfile do 1.1.21.

Oczekiwane: Brak znanych high/critical w grafie npm.

Odtworzenie: `npm audit --json`. Dowody: 05-validacion/npm-audit-before.json, 05-validacion/npm-audit-after.json.

## BUG-006 — Wykonywanie kodu z parametrów instalatora

**High / Security / CWE-78 / Verified**. Baza: `509ddf1`, setup/codexlb-setup.js:237, setup/codexlb-setup.js:527, setup/claw-setup.sh:51, setup/opencode-setup.sh:57.

Klucz/URL trafiały do komendy curl, kodu JS/Python i sourced pliku powłoki. Lokalne wykonanie kodu w kontekście instalacji; wymaga przekazania danych kontrolowanych przez napastnika, nie zdalne anonymous RCE.

Przyczyna: Interpolowanie wejścia w kod wykonywalny. Poprawka: execFileSync, quoted heredoc z env, quoting pliku środowiskowego i stały kod PowerShell.

Oczekiwane: Dane pozostają literalnymi wartościami.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-setup.test.js`. Dowody: 05-validacion/setup-red.log, 05-validacion/setup-green.log.

## BUG-007 — Fallback instalatora akceptował odrzucony klucz

**Medium / Functional / CWE-754 / Verified**. Baza: `509ddf1`, setup/codexlb-setup.js:233.

401/403 przechodziło do curl, który ignorował status i raportował 200. Instalator zapisywał niedziałającą konfigurację; nie omijało to auth serwera.

Przyczyna: Brak rozróżnienia błędu auth/transportu, brak --fail. Poprawka: Propagacja statusu native i curl --fail.

Oczekiwane: Odrzucenie poświadczeń zatrzymuje konfigurację.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-setup.test.js`. Dowody: 05-validacion/setup-red.log, 05-validacion/setup-green.log.

## BUG-008 — Pliki z kluczami mogły być odczytywane przez innych użytkowników

**Medium / Security / CWE-732 / Verified**. Baza: `509ddf1`, setup/claw-setup.sh:64, setup/opencode-setup.sh:127, setup/codexlb-setup.js:531.

Nowe pliki miały 0644 przy umask 022; istniejący env zachowywał 0644. Odczyt klucza przez lokalne inne UID.

Przyczyna: Domyślny mode i błędne założenie, że writeFile(mode) zmienia istniejące uprawnienia. Poprawka: umask 077, jawne mode 0600 i chmod istniejących plików/backupów.

Oczekiwane: Pliki konfiguracji, auth, env i backupy mają 0600.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-setup.test.js`. Dowody: 05-validacion/setup-red.log, 05-validacion/setup-green.log.

## BUG-009 — Niepoprawna konfiguracja była nadpisywana lub ignorowana

**Medium / Functional / CWE-703 / Verified**. Baza: `509ddf1`, setup/claw-setup.sh:55, setup/opencode-setup.sh:61, setup/opencode-setup.sh:130.

Błąd JSON skutkował pustym obiektem i nadpisaniem konfiguracji; błąd auth był ukrywany. Utrata ustawień, częściowa konfiguracja i fałszywy sukces; backup pozwalał na odzyskanie.

Przyczyna: Puste catch i brak walidacji shape dokumentów. Poprawka: Walidacja config/auth przed zapisami; jawny błąd; zachowanie obcych pól.

Oczekiwane: Błędne dokumenty pozostają bez zmian i kończą setup błędem.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-setup.test.js`. Dowody: 05-validacion/setup-red.log, 05-validacion/setup-green.log.

## BUG-010 — Podatne składniki bazowego obrazu Docker

**High / SupplyChain / CWE-1104 / Verified**. Baza: `509ddf1`, docker/Dockerfile:1, docker/Dockerfile:9, docker/Dockerfile:18.

Trivy: 1 CRITICAL, 26 HIGH, 27 MEDIUM, 35 LOW, 2 UNKNOWN. Warunkowy DoS/odczyt/zapis przez podatne narzędzia; brak dowodu osiągalności krytycznego tar przez API proxy.

Przyczyna: Node20 Alpine i podatne składniki npm/global tooling oraz OpenSSL. Poprawka: Node24 Alpine, aktualizacja pakietów systemowych, usunięcie npm/yarn niewymaganych przez runtime.

Oczekiwane: Brak wykrytych znanych podatności w końcowym obrazie.

Odtworzenie: `docker build -f docker/Dockerfile -t agent-lb:audit .; docker save agent-lb:audit -o /tmp/image.tar; trivy image --input /tmp/image.tar --scanners vuln --severity HIGH,CRITICAL --exit-code 1`. Dowody: 05-validacion/trivy-image-before.json, 05-validacion/trivy-image-after.json.

## BUG-011 — Klucze instalatora ujawniane przez argv i stdout

**Medium / Security / CWE-214 / Verified**. Baza: `509ddf1`, setup/codexlb-setup.js:238, setup/opencode-setup.sh:275.

Curl otrzymywał klucz przez argv, OpenCode wypisywał go na stdout. Ekspozycja przez ps/logi sesji/CI.

Przyczyna: Brak rozdzielenia danych wrażliwych od argumentów i komunikatów. Poprawka: Curl --header @- z stdin; odrzucenie CR/LF; usunięcie echo klucza.

Oczekiwane: Sekret nie trafia do argumentów procesów ani logu instalacji.

Odtworzenie: `node --import ./test/support/isolate-config.js --test test/systematic-setup.test.js`. Dowody: 05-validacion/setup-secrets-red.log, 05-validacion/setup-secrets-green.log.

## Ograniczenia

- Brak gwarancji wykrycia wszystkich błędów; audyt iteracyjny.
- Bez realnego Windows/PowerShell, browser E2E, SMTP i inference.
- Brak ZAP/Burp, AFL/libFuzzer, CodeQL/SonarQube, Grype/Dockle i podpisu tożsamością organizacji. Zastosowano lokalne testy HTTP/WS/CONNECT, deterministyczną fragmentację UTF-8, Semgrep, Checkov, Gitleaks, npm audit, Trivy.
- Źródła Node coverage obejmują moduły załadowane przez testy; nie dowodzi to pokrycia całego repo.
- Nie zmieniano magazynu sekretów, CA, polityki MITM ani zastanych zmian Hermesa/.gitignore/.claude/settings.json.
- Zadanie ma wspólną gałąź i PR; współdzielone zmiany relay/quota pozostają rozdzielone w dowodach i testach, nie w osobnych checkoutach.
