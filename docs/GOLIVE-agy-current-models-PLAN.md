# Limity używanych modeli AGY — poprawka

Kontynuacja zgłoszonej i zatwierdzonej aktualizacji panelu. Tomasza interesują
wyłącznie Gemini 3.8 Flash, Gemini 4 Argon i Gemini 4 Carbon.

Każda karta ma te same trzy sekcje. Procenty pochodzą wyłącznie z odczytu
pasującego do danej rodziny. Google raportuje `gemini-3.8-flash-tiered`;
odczyt jest opisany jako grupa Flash 3.8, bez założenia osobnych pul High/Low.
Dla Argona/Carbona brak odczytu oznacza „Brak danych o limicie”. Dostęp z
katalogu jest osobną informacją; brak katalogu oznacza dostęp niepotwierdzony.
Blokada konkretnej odmiany jest pokazana oddzielnie. Dawne modele i nieprzypisane
limity Google są tylko w zwiniętych szczegółach. Usunięto zbiorczą listę,
która mylnie zaliczała konto z samym dostępem do katalogu jako konto z zapasem.

Walidacja: testy braku danych vs0, oddzielnych odmian/resetów, nowszych
odczytów i niewykorzystywania starych modeli ani 3p-weekly/3p-5h do Gemini.
Pełne testy, lint, review, CI. Potem PR/merge i dotychczasowy drain/restart
systemd na debian-lite, sprawdzenie lokalnego/publicznego HTML i gotowości.
Bez zmian kont, sekretów, routingu, DNS i wywołań modeli. Powrót: revert
poprawki i restart po drain. Hosting systemd weryfikuje agent, nie CLI golive.
