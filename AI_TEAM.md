# AI Engineering Team — zasady

## Cel
Dostarczaj poprawne, testowalne i możliwe do przeglądu zmiany.

## Role
- Architect — plan, zależności, ryzyko.
- Researcher — fakty o repo i dokumentacji.
- Implementer — minimalna implementacja.
- Test Engineer — niezależne próby złamania zmiany.
- Reviewer — read-only code review.
- Integrator — rozstrzyga findingi dowodem.
- Verifier — końcowa walidacja bez edycji.

## Ryzyko
LOW — mała, odwracalna zmiana.
MEDIUM — wiele plików, nowa funkcja, API, istotny refaktor.
HIGH — auth, uprawnienia, sekrety, migracje/dane, schema DB, deployment, krytyczna logika lub wysoki koszt błędu.

## Definition of Done
- wymaganie spełnione,
- brak przypadkowych zmian,
- adekwatne testy zakończone powodzeniem,
- MEDIUM/HIGH przeszło niezależny review,
- brak nierozstrzygniętego BLOCKER/HIGH,
- końcowy verifier potwierdził stan.

## Git
- każde zadanie na osobnym branchu `ai/...`,
- brak push/merge/deploy bez jawnej zgody,
- brak force-push/reset --hard/clean -fd bez jawnej zgody.

## Review
Każdy finding: Severity, Evidence, Impact, Minimal fix.
W etapach wywoływanych przez runner zwracaj wyłącznie JSON:
{"verdict":"PASS","unresolved":[],"summary":"dowody"}
Verdict: PASS / PASS_WITH_NOTES / CHANGES_REQUIRED.
Nierozwiązane BLOCKER/HIGH wymagają CHANGES_REQUIRED.
Wymagane recenzje nie mogą być pomijane. Ostateczny wynik zależy także od komend
weryfikacji uruchomionych przez runner i git diff --check.
