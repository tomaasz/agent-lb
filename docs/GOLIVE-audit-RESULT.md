# Wdrożenie audytu — wynik, 2026-10-22

Zrealizowano polecenie użytkownika „wdróż i wypchnij na main”.
Poprawki cde3a95 scalono fast-forward do main razem z planem22af363
w repozytorium tomaasz/agent-lb. Bez zmian CA, kont, kluczy ani ustawień DNS.

## Dowody wykonania

- Istniejąca usługa: `agentlb.service`, użytkownik Tomasz, host `debian-lite`.
- Restart22 października o21:41:05CEST: PID877 →48025, active/running,
  NRestarts=0. Kod wykonywany z `/home/tomaasz/agent-lb`.
- Przed restartem: krótkotrwały drain, potwierdzone activeRequests=0.
- Po restarcie: ready=true, draining=false; aktywne żądania podczas kontroli0.
- Zachowane4 konta,15 kluczy klientów, tożsamości kont i wartości kluczy bez zmian.
- AGY: plik nadal agentlb-agy-encrypted; poprawne odszyfrowanie5 kont.
- Backup3 plików poza repo: konfiguracja, stan, zaszyfrowane konta AGY;
  katalog0700, pliki0600. Klucz szyfrowania pozostał oddzielnie.

## Smoke po wdrożeniu

| Kontrola | Wynik |
|---|---|
| Lokalny `/dashboard` i publiczny `https://agentlb.gotova.pl/dashboard` | 200, zgodne SHA256 HTML, obecny nowy kod i CSP. |
| Lokalny i publiczny `/ready` z kluczem administratora | 200, ready=true, draining=false. |
| Lokalny i publiczny `/ready` bez poświadczeń | 401. |
| Login kluczem stacji | 401; eskalacja do sesji admina zamknięta. |
| Dostęp stacji do `/api/keys` | 403. |
| Login głównym kluczem i odczyt administracyjny przez cookie | 200. |
| `/v1/models` z kluczem administratora | 200, niepusta lista modeli. |
| Status usługi | 200,4 konta, czas startu nowego procesu. |

Dowody z lokalnych git/systemctl/HTTP i publicznego HTTPS zebrał agent.
Nie są weryfikacją CLI golive: hosting systemd jest poza jego adapterami;
`golive status` nie działa bez golive.yaml. Nie tworzono zastępczej konfiguracji
ani zasobów chmurowych tylko w celu uzyskania zielonego raportu narzędzia.

## Walidacja wydania i granice

CI poprawki39841580074: SUCCESS, Node20/22/24/26 i Docker.
Testy lokalne371PASS/5SKIP, lintPASS; testy obrazu Node20 19/19PASS;
niezależny review koduPASS. CI main i verifier wdrożenia zapisano w stanie
przekazania projektu po ich zakończeniu.

Nie wykonywano rzeczywistego wnioskowania modeli ani resetu hasła przez SMTP.
Nie testowano interakcji w prawdziwej przeglądarce. Konfiguracja nie ma osobnego
hasła ani e-maila webAuth, więc panel wymaga głównego klucza; nie przywracano
ukrytego domyślnego hasła. Stare sesje wymagają ponownego logowania.
Zastane zmiany Hermesa oraz .claude/settings.json zachowano poza commitem.

Nie ma otwartego kroku infrastrukturalnego wymagającego działania użytkownika.
Monitorowanie codziennej pracy i ewentualna konfiguracja resetu e-mail pozostają
oddzielnymi zadaniami. Raport dowodzi wdrożenia i wskazanych kontroli, a nie
pełnego testu dostawców modeli i poczty.
