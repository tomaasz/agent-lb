# Audyt systematyczny AgentLB — 2026-10-22

Wynik: [podsumowanie](06-reportes/06-ejecutivo.md), [szczegóły](06-reportes/06-tecnico.md), [walidacja](05-validacion/validation.json). Baza `509ddf1`, gałąź `ai/systematic-audit-2026-10-22`. To kolejna partia po wcześniejszym audycie z tego dnia. Nie wdrażano zmian.

## Zakres i kryteria

Własne wnioski read-only sformułowano przed poprawkami; oddzielni agenci sprawdzili implementację. Zmapowano źródła/instalatory/CI/Docker, poddano historii Git skanowi sekretów, wykonano testy lokalne z atrapami i analizę zależności/obrazu. Znaleziono 11 potwierdzonych usterek. Nie skanowano aktywnej produkcji. Cel: brak nierozwiązanych potwierdzonych High/Critical w tej partii, wszystkie nowe regresje i lint zielone, jawne luki w pokryciu i metodzie. Cel szablonu 80% linii/70% gałęzi krytycznych modułów pozostaje niespełniony.

## Materiały

- `01-reconocimiento.*`: mapa, STRIDE i inwentarz; hashe plików śledzonych w lokalnym workspace podczas audytu, nie podpis kompletnego drzewa commita.
- `02-hallazgos-raw.*` i `03-hallazgos-priorizados.*`: 11 usterek, bazowe lokalizacje, PoC, stan i priorytety. Score roboczy: severity × impact × exploitability / effort; High=3×3×2/1=18, Medium=2×2×2/1=8. To orientacyjny ranking, nie wynik CVSS.
- `04-fixes/verified.patch`: poprawki kodu względem bazy; testy regresji są w `test/systematic-*.test.js`. `setup-fixes.patch` to **pierwotny patch przedstawiony do zgody**, później uzupełniony po review; nie jest końcowym diffem.
- `05-validacion/`: testy red/green, końcowe JUnit/coverage, skany, SBOM i mikrobenchmark.
- `06-reportes/`: zsynchronizowane MD/JSON/YAML/CSV. JSON jest strukturą źródłową eksportów.
- `07-mejora-continua.md`, `RUNBOOK.md`, `ADR-001.md`: plan dalszych kontroli i ograniczenia operacyjne.

## Odtworzenie

Z repo i Node24 uruchom `npm ci --ignore-scripts`, `npm run lint`, `npm test`, `npm audit --json` i `npm sbom --sbom-format cyclonedx`. Testy same izolują konfigurację; nie wskazuj rzeczywistego pliku kont. Aby odtworzyć coverage: `node --import ./test/support/isolate-config.js --test --test-timeout=120000 --experimental-test-coverage --test-coverage-include='src/**'`.

Skany: Gitleaks8.30.1 `gitleaks git --redact --log-opts=--all`; Semgrep1.182.1 `semgrep scan --config p/javascript --metrics off src setup` oraz blokująca regresja `semgrep scan --config security/semgrep.yml --metrics off --error src setup`. Nie zmieniono kodu kryptografii na podstawie false positive: `src/agy-storage.js` sprawdza tag16bajtów przed odszyfrowaniem. Checkov3.3.30: `checkov -d docker --framework dockerfile` i `checkov -d .github --framework github_actions`. Checkov nie pokrywa wszystkich polityk Compose ani ustawień GitHuba.

Docker: `docker build --pull -f docker/Dockerfile -t agent-lb:audit .`, `docker save agent-lb:audit -o /tmp/image.tar`; Trivy image `--input /tmp/image.tar --scanners vuln --severity HIGH,CRITICAL --exit-code 1`. CI przypina digest Trivy. Skan bazowy i końcowy mają pełne identyfikatory obrazu w JSON. Bazy advisory zmieniają się w czasie, więc przyszły skan może zwrócić nowe wyniki. `npm/yarn` usunięto tylko z końcowego runtime obrazu; poza kontenerem wymaganie Node>=20 pozostaje bez zmiany.

Podpis: `openssl dgst -sha256 -verify 05-validacion/sbom-signing-public.pem -signature 05-validacion/sbom.cdx.sig 05-validacion/sbom.cdx.json` z katalogu audytu. Prywatny klucz tymczasowy usunięto. Podpis lokalny bez organizacyjnej tożsamości.

Mikrobenchmark: zapisz `git show 509ddf1:src/provider-translator.js` jako `/tmp/bench/baseline.mjs`, obok utwórz symlink `tool-pair-sanitize.js` do źródła repo, uruchom `node --expose-gc 05-validacion/benchmark.mjs /tmp/bench/baseline.mjs`. Wynik to pojedynczy przebieg 1000 krótkich SSE bez sieci; p50/p95/p99/CPU/heap nie dowodzą SLO ani przewagi wydajnościowej, są wrażliwe na kolejność/JIT i obciążenie hosta.

## Ograniczenia

Nie wykonano CodeQL/SonarQube, ZAP/Burp/AFL, długiego profilu, realnego Windows/browser/SMTP/inference ani audytu retencji na produkcji. Zastosowane zamienniki i pominięcia są jawne w walidacji; nie deklarujemy wykonania wszystkich narzędzi wymienionych w szablonie. Nie zmieniano branch protection ani konfiguracji kont/CA. Nie przeprowadzono sesji lessons-learned z człowiekiem. Zastane Hermes, `.gitignore` i `.claude/settings.json` są poza commitami audytu.

Semgrep: początkowy skan miał 9 timeoutów reguł w 4 dużych modułach. Powtórzenie tych 4 plików z limitem 60 s/regułę zakończyło się bez timeoutów i nowych dopasowań (68 reguł). Dowody: `05-validacion/semgrep-retry.*` (ścieżka względem katalogu audytu).

Uwaga o JUnit: stopka zawiera ten sam wynik node:test 408/403/0/5 i czas 67787.700064 ms co log spec. XML ma 406 elementów testcase i 6 skipped (m.in. skipped suite). Hierarchia reporterów nie mapuje się 1:1; obie reprezentacje zachowano bez ręcznej korekty.
