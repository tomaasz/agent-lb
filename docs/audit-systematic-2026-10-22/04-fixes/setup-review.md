# Audyt konfiguratorów i supply chain — 2026-10-22

Zakres: `.github/workflows/ci.yml`, Dockerfile/Compose, manifest/lockfile, `src/updater.js`, `src/service.js`, `src/alias.js`, fragmenty CLI oraz konfiguratory `setup/`. Zastane zmiany Hermesa pominięto w implementacji. Repo nie zostało edytowane przez tego reviewera; gotowy patch znajduje się w `/tmp/agent-lb-setup-fixes.patch` i wymaga jawnej zgody wynikającej z PROJECT_CONTEXT.

## Potwierdzone findingi

| ID | Severity | Lokalizacja bazowa | Dowód i wpływ | Poprawka w przygotowanym patchu |
|---|---|---|---|---|
| SETUP-01 | HIGH przy niezaufanym źródle parametrów | setup/codexlb-setup.js:237-238,513,527-536; setup/claw-setup.sh:50-64,67-88; setup/opencode-setup.sh:56-138,140-233 | Key/URL traktowane jako kod powłoki lub JS/Python. Fallback curl z kluczem `$(printf SAFE_EXEC_PROOF >&2)` uruchamia substitution; mock curl bez sieci zwrócił marker na stderr. Heredoc pozwala zmienić serializowaną wartość kluczem zawierającym wyrażenie konkatenacji. Po zapisie ENV wykonanie może nastąpić przy otwarciu powłoki. Warunek: operator korzysta z parametrów ze źródła napastnika; nie stwierdzono zdalnego wektora bez udziału operatora. | execFileSync dla curl i PowerShell; stały kod PowerShell i heredoc, wartości w env; literalne quoting w pliku powłoki. |
| SETUP-02 | MEDIUM | setup/codexlb-setup.js:233-248 | Native 401/403 uruchamia fallback curl bez --fail; dowolna odpowiedź HTTP powoduje wynik `statusCode:200`, potem komunikat „klucz działa” i zapis złych ustawień. VM z błędem native i body unauthorized potwierdza sukces. Nie jest to obejście autoryzacji serwera. | Definitywna odmowa dla native 401/403, --fail dla fallback curl. |
| SETUP-03 | MEDIUM | setup/claw-setup.sh:64,85; setup/opencode-setup.sh:127,136,215,226 | Jawne klucze zapisywane w nowych plikach z mode 0644 przy umask 022. Odczyt możliwy przez inne lokalne konta przy dostępnych katalogach. Kopie oraz wcześniej zbyt szerokie uprawnienia nie były zacieśniane. | umask 077, chmod 0600 kopii i istniejących plików oraz jawne 0600 przy tworzeniu. |
| SETUP-04 | MEDIUM | setup/claw-setup.sh:55,75; setup/opencode-setup.sh:61,148 | Błędny JSON jest ignorowany, co resetuje cfg do {} i nadpisuje pozostałe ustawienia. Repro zachowuje plik z niedomkniętym JSON, a obecny serializer usuwa oryginalne pola. Kopia daje możliwość odzysku. | Propagowanie błędu parsera i walidacja obiektu JSON; brak zapisu błędnego wejścia. |

## Weryfikacja patchu

- 17 testów regresji: 17 FAIL przed zmianą, 17 PASS na tymczasowej kopii po zmianie; nic nie pominięto.
- Fragmenty serializatorów Node/Python są wykonywane z syntetycznymi kluczami, tymczasowymi ścieżkami i standardowym umask. Całe instalatory nie są uruchamiane.
- Fallback curl jest atrapą; nie wykonano zewnętrznych połączeń. Test powłoki używa tylko /bin/sh i printf.
- `git apply --check /tmp/agent-lb-setup-fixes.patch`, bash -n obu skryptów, node --check konfiguratora i ESLint dla nowego testu/konfiguratora: PASS.
- Dowody: `/tmp/agent-lb-setup-red.log`, `/tmp/agent-lb-setup-green.log`, `/tmp/systematic-setup.test.js`.
- Kopia do review: `/tmp/agent-lb-setup-review-kwikfbj3`.

Nie przeprowadzono obrazu Docker ani zewnętrznych SCA/Trivy/OSV. Nie potwierdza się braku CVE obrazów lub pełnej integralności rejestru. Pozostałe konfiguratory nie zostały w całości zweryfikowane dynamicznie. Nie wykonano testów Windows/PowerShell; ścieżka PowerShell została oceniona statycznie. To audyt techniczny, nie certyfikacja SOC2/ISO/GDPR.

## Niezależny review poprawek core

PASS dla aktualnego diff `src/server.js`, `src/mitm.js`, `src/provider-translator.js`, `test/systematic-{quota,relay,utf8}.test.js`, `package-lock.json`. 8/8 testów uruchomiono osobno. Nie znaleziono nowego podwójnego księgowania, regresji dekodowania UTF-8 ani utraty upstream identity wskutek filtracji nagłówków. Lockfile zmienia wyłącznie dev brace-expansion 1.1.18→1.1.21; pochodzenie artefaktu nie było sprawdzane sieciowo.
