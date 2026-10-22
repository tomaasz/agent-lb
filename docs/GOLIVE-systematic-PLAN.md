# Wdrożenie poprawek systematycznego audytu — 2026-10-22

Zgoda użytkownika: „wdróż i uporządkuj repo”. Cel: PR4 (`c6144db`), main repo
`tomaasz/agent-lb`, istniejący systemd `agentlb.service` użytkownika Tomasz,
host debian-lite, `/home/tomaasz/agent-lb`, domena `agentlb.gotova.pl`.

1. Potwierdzić zielone Verify/Security i brak zmian zdalnego main wymagających ponownego review.
2. Zachować cztery zastane zmiany lokalne w nazwanym stashu (Hermes setup/test,
   .gitignore +aider, .claude/settings.json). Stash nie jest publikowany ani usuwany.
   Nie czyścić obcych worktree ani niezmergowanych gałęzi.
3. Prywatny backup konfiguracji/stanu/zaszyfrowanych kont AGY poza repo:
   katalog0700, pliki0600, bez wyświetlania wartości. Klucz szyfrowania pozostaje oddzielnie.
4. Oznaczyć PR4 jako gotowy i scalić do main po zielonych kontrolach.
   Zsynchronizować lokalny main fast-forward; zachować rollback starego kodu509ddf1.
5. Zainicjować drain istniejącego procesu, poczekać na activeRequests0, restartować
   istniejącą usługę; w razie nieosiągnięcia bezczynności anulować drain bez zabijania żądań.
6. Zweryfikować nowy PID/start, service active/running, ready=true/draining=false,
   anonimowe401, delegowane admin403, sesję admina, katalog modeli, panel lokalnie/publicznie.
   Porównać tożsamości kont i kluczy wyłącznie wewnątrz procesu, wypisać tylko wynik bool/count.
7. Zapisać wynik, CI main i niezależnego verifiera; usunąć wyłącznie bezpiecznie
   scalone gałęzie po sprawdzeniu historii, pozostawić czyste main i odzyskiwalny stash.

Dowody wydania: 403PASS/408tests,5SKIP,0FAIL; container27/27; CI Node20/22/24/26,
Docker i Security SUCCESS. Nie zmieniać kont/CA/DNS, nie wykonywać inference/SMTP.
Pełne kryteria szablonu audytu nadal niespełnione: coverage krytycznych modułów
wymaga dalszej pracy; nie jest to bloker już zweryfikowanych poprawek bezpieczeństwa.

Rollback: uruchomienie źródeł509ddf1 i restart przy zachowaniu aktualnych danych,
bez automatycznego przywracania starych tokenów/stanu. Stary kod zawiera znane luki,
więc preferowana poprawka naprzód. Krótka przerwa restartu została objęta poleceniem wdrożenia.

Skill golive: wersja0.1.0-alpha.5/bundle zweryfikowany; dostępna aktualizacja nie
jest instalowana podczas wdrożenia. Systemd to guided workflow bez adaptera CLI;
wynik weryfikowany lokalnie przez agenta, nie przez golive. Brak nowych zasobów/kosztów.
