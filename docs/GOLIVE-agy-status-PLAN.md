# Naprawa statusów AGY — plan

Zgłoszenie: konto z zapamiętanym limitem modelu ma etykietę „ZDROWE”, a problem jest widoczny dopiero po kliknięciu Test.

Zakres: karta uwzględnia limity całego konta, limity modeli i aktywne blokady zdrowia. Bez sukcesu z ostatnich 15 minut pokazuje „Niezweryfikowane”; sukces oznacza „Ostatnio działało”, nie gwarancję dostępności wszystkich modeli. Wynik Test trafia do filtrowanej historii zdarzeń, bez treści błędu i poświadczeń, i przetrwa przeładowanie panelu. Opis Auto-Health jasno wskazuje Claude/Codex i wyłączenie AGY z automatycznych prób.

Akceptacja: limit modelu i blokada nie mogą być oznaczone jako zdrowe; stare/nieznane wyniki nie są dowodem sprawności; sukces i błąd Test pozostają widoczne po ponownym pobraniu danych. Bez automatycznych, płatnych zapytań do Google. Licznik tabeli routingu i dodanie automatycznych prób AGY poza zakresem.

Weryfikacja: testy statusu na kodzie osadzonym w HTML, integracyjne testy API (w tym ponowne otwarcie magazynu), istniejące testy dashboardu, lint, pełny npm test, niezależny review i verifier.

Wdrożenie do dotychczasowej usługi systemd, w ramach poleceń „wdróż” i „napraw”: merge po zielonym CI, drain do zera aktywnych żądań, main fast-forward, restart. Backup konfiguracji/stanu prywatnie; bez zmian sekretów, kont i konfiguracji. W razie błędu cancel drain; po restarcie smoke lokalny/publiczny, zgodność dashboardu i sprawdzenie, że nowy kod jest serwowany. Rollback: revert commita i restart po drain. Istniejące zdarzenia zgodne ze schematem, bez migracji.

Golive: workflow guided; weryfikacja systemctl i HTTP przez agenta, nie przez CLI golive.
