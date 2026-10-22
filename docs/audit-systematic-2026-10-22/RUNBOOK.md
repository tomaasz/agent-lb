# Runbook po audycie

## Podejrzenie ujawnienia poświadczeń

1. Ogranicz dostęp do panelu/proxy. Nie wklejaj sekretu do zgłoszenia ani logu.
2. Ustal użyte ścieżki relay i wersję kodu. Wersja sprzed BUG-001 mogła przekazać cookie/klucz do upstream.
3. Administrator rotuje podejrzane klucze i odwołuje sesje. Sama aktualizacja filtra nie odwołuje już ujawnionych kluczy.
4. Zweryfikuj lokalnym syntetycznym testem relay, następnie zatwierdzonym smoke na wdrożeniu.

## Nieprawidłowe limity tokenów

Sprawdź protokół, stream/fallback i wersję. Uruchom `node --import ./test/support/isolate-config.js --test test/systematic-quota.test.js`. Nie zeruj rzeczywistych liczników jako sposobu naprawy. Historyczne zużycie pominięte przez stary kod nie jest odtwarzane tą poprawką.

## Błąd instalatora

Zachowaj oryginalny dokument i prywatny backup. Błędny JSON należy naprawić świadomie; instalator odmawia nadpisania. Sprawdź uprawnienia 0600 bez wypisywania zawartości pliku. Nie uruchamiaj narzędzi na produkcyjnym HOME w ramach testów.

## Rollback

Cofnięcie commitów aplikacji przywróci również stare podatności. Preferuj wyłączenie problematycznej funkcji i poprawkę naprzód. Brak migracji formatu danych/API. Kontener służy runtime: npm/yarn usunięte, aktualizacja wymaga przebudowy obrazu. Wdrożenie/restart/rotacja rzeczywistych sekretów to osobny etap; nie wykonano ich w tym audycie.
