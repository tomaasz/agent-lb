# Widoczny wynik ręcznego sprawdzania AGY

Problem: kontrola wywołuje API, ale przycisk nie pokazuje postępu ani potwierdzenia,
a szczegóły pozostają zwinięte. Odświeżenie panelu może wyglądać jak brak reakcji.

Zakres: wyłącznie panel — stan trwającej kontroli konta/puli, blokada ponownego
kliknięcia, komunikat powodzenia/błędu (w tym sieć i409), rozwinięty wynik oraz
etykieta dostępu do katalogu odróżniona od dowodu skutecznej generacji.
Bez zmian diagnostyki, tokenów ani zasad przydziału.

Akceptacja: kliknięcie wywołuje pojedynczy POST, widoczny postęp utrzymuje się
przy odświeżaniu listy, sukces/błąd kończy postęp, szczegóły zostają otwarte,
kontrola całej puli ma ten sam feedback. Testy VM dla opóźnionych odpowiedzi,
błędów sieci/409, konta/puli; smoke prawdziwej przeglądarki przed i po zmianie.
Walidacja: testy dashboard/AGY, lint, diff --check, niezależny review, CI.
Wdrożenie do istniejącej usługi po drain0; rollback wcześniejszym kodem panelu.
