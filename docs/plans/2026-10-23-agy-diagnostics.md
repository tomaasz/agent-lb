# Diagnostyka puli AGY

Cel: odczyt dostępu, planu i limitów bez generowania zapytań modelowych; panel,
ręczne i okresowe sprawdzanie, trwała historia i bezpieczna rotacja.

Punkty wejścia: `agy-accounts.js`, administracyjne `/api/agy/*`, dashboard i
inicjalizacja serwera. Zakres nie obejmuje MITM, konfiguratorów stacji ani
zmiany formatu tokena wydawanego agybridge.

- Osobne wyniki OAuth, metadanych, modeli i quota summary; częściowe awarie
  nie usuwają poprawnych pomiarów, nieznany plan pozostaje nieznany.
- Wykluczenie z przydziału tylko przy potwierdzonej przeszkodzie dostępu;
  sam brak metadanych/summary i limity pojedynczego modelu nie blokują puli.
- Okresowo 6h, restrykcje 24h, backoff i Retry-After, maks. 5 kont na turę.
- Atomowy zapis 0600, fsync, blokada między procesami, kontrola wersji tokena,
  ograniczona historia. Sieć poza blokadą danych.
- Ryzyko HIGH: tokeny i wybór kont; wymagane niezależne review i weryfikacja.
- Rollback: powrót do wcześniejszego kodu; dodatkowe pola są kompatybilne
  z dawnym odczytem. Nie kasować tokenów ani aktualizować ich diagnostyką.

Walidacja: testy AGY, pełne `npm test`, `npm run lint`, `git diff --check`.
Publikacja brancha po testach; wdrożenie na działającej instancji po identyfikacji
jej sposobu uruchomienia i potwierdzeniu zakresu autoryzacji.
