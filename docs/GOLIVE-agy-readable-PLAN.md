# Czytelne limity AGY — wdrożenie

Zgoda Tomasza: „oczywiście” po pytaniu o wdrożenie gotowej poprawki.

Cel: istniejąca usługa użytkownika `agentlb.service` na `debian-lite`, katalog
`/home/tomaasz/agent-lb`, panel `https://agentlb.gotova.pl/dashboard`.
Zakres: polskie opisy limitów, paski pozostałego zapasu, podpisane terminy,
zwijane grupy identycznych odczytów i listy modeli. Identyczne odczyty nie
potwierdzają wspólnej puli. Stan rozwinięcia przetrwa odświeżanie.

Walidacja przed wydaniem: pełne testy 504 PASS / 5 SKIP / 0 FAIL, lint PASS,
niezależny review i verifier PASS. Aktualny origin/main zawiera dodatkowe
commity scalające; poza poprawką brak różnic plików roboczych.

Kroki: aktualizacja gałęzi względem origin/main, PR i zielone CI, scalenie,
drain do zera aktywnych zapytań, prywatna kopia istniejącego stanu,
aktualizacja lokalnego main i restart dotychczasowej usługi.
Sprawdzenie po restarcie: active/running, ready=true, draining=false,
lokalny i publiczny HTML zawierają nowe opisy i mają zgodną sumę SHA256.
Bez nowych zasobów, kosztów, zmian kont, sekretów, DNS i zapytań do modeli.

Powrót: revert poprawki i restart po drain; przy przerwaniu przed restartem
anulować drain. Cudze pliki nieśledzone pozostawić nietknięte.
Weryfikacja przez git/systemctl/HTTP; hosting systemd nie ma adaptera golive.
