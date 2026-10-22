# Wdrożenie audytu — plan, 2026-10-22

Zgoda użytkownika: „wdróż i wypchnij na main”. Zakres: poprawki cde3a95,
repozytorium tomaasz/agent-lb, istniejąca usługa systemd użytkownika Tomasz
`agentlb.service` na `debian-lite`, katalog `/home/tomaasz/agent-lb`.

1. Potwierdzić CI i fast-forward względem origin/main.
2. Zapisać prywatną kopię konfiguracji/stanu poza repo (0700 katalog,0600 pliki),
   bez wyświetlania poświadczeń. Nie zmieniać konfiguracji kont i CA.
3. Wypchnąć main; zachować zastane niezacommitowane zmiany instalatora Hermesa
   i .claude/settings.json poza commitem.
4. Krótki drain, sprawdzenie liczby aktywnych żądań i restart istniejącej usługi.
   Drain wyłącznie na czas przejścia; nowy proces startuje bez drain.
5. Potwierdzić nowy PID/czas startu, gotowość, zachowanie kont i kluczy,
   logowanie głównym kluczem, odmowę admina kluczowi klienta, brak anonimowego
   dostępu oraz panel. Publiczny HTTPS sprawdzić na istniejącej domenie.
6. Zapisać wyniki i stan przekazania; niezależny verifier.

Dowody przed wdrożeniem: testy371PASS/5SKIP, lintPASS; niezależny reviewPASS;
CI39841580074SUCCESS (Node20/22/24/26+Docker). Python/bcrypt dostępny na hoście.
Ready200, draining=false, activeRequests=0; proces877 od21:03:18CEST.
Konfiguracja:4 konta,15 kluczy stacji, szyfrowanie AGY skonfigurowane.
Brak osobnego webAuth.passwordHash/email: po usunięciu ukrytego domyślnego
hasła login panelu wymaga głównego klucza. Stare sesje zostają odwołane.

Rollback kodu: poprzednia wersja9841a14 pozostaje w historii Git; w razie awarii
uruchomić poprzednie źródła i zrestartować usługę, zachowując aktualne dane.
Nie przywracać automatycznie starej kopii kont/tokenów ani wycofywać szyfrowania.
Poprzednia wersja ma znane luki audytu, więc rollback wymaga oceny ekspozycji.

Wykonanie przez lokalne git/systemctl/HTTP; skill golive nie ma adaptera
systemd. Dowody weryfikuje agent, nie CLI golive. Bez nowych zasobów, DNS,
zakupów i zmiany dostawcy. Dopuszczalna krótka przerwa podczas restartu.
