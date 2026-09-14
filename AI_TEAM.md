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
Pliki sterujące pracą zespołu (`ai-team.config.json`, `AI_TEAM.md`, `PROJECT_CONTEXT.md`,
`.agents/`, `.claude/`) zawsze są HIGH. Nie zmieniaj ich przy okazji innego zadania.

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
Kolejność oceny: correctness > security > data loss > regressions > compatibility >
maintainability > style. Poza poprawnością oceniaj samą zmianę: czy jest minimalna wobec
wymagania, czy nie wprowadza abstrakcji przed drugim użyciem, czy nazewnictwo i struktura
są spójne z sąsiadującym kodem, czy nie zostawia martwego lub zduplikowanego kodu.
Działający, ale niepotrzebnie złożony kod to nadal finding.
Każdy finding: Severity, Evidence (plik:linia), Impact, Minimal fix.
W etapach wywoływanych przez runner zwracaj wyłącznie JSON:
{"verdict":"PASS","unresolved":[],"summary":"dowody"}
Verdict: PASS / PASS_WITH_NOTES / CHANGES_REQUIRED.
Nierozwiązane BLOCKER/HIGH wymagają CHANGES_REQUIRED.
Wymagane recenzje nie mogą być pomijane. Ostateczny wynik zależy także od komend
weryfikacji uruchomionych przez runner i git diff --check.

## Skille
- Orkiestrator i agenci w pełni automatycznie i proaktywnie dołączają potrzebne skille z katalogu szablonów po wykryciu odpowiednich technologii lub wymagań zadania.
- Agenci mają uprawnienie do proaktywnego tworzenia i aktualizowania wytycznych architektonicznych specyficznych dla projektu w `.agents/skills/project/<nazwa>/SKILL.md` (i odpowiedniku w `.claude/skills/project/`). Skille projektowe są chronione przed nadpisaniem przy aktualizacjach frameworka.
