# Dlaczego rotacja kont AGY nie zadziałała na debianovh

Data: 2026-10-14. Zakres: śledztwo tylko do odczytu (debian-lite i debianovh), bez zmian na hostach.

## Wniosek

Najbardziej prawdopodobna przyczyna: do 2026-10-14 około 20:51 pula agent-lb miała **jedno** konto Google (to, na którym Hermes stał od 2026-09-22), więc po wyczerpaniu limitu nie było dokąd przełączyć. Pewność około 80%.

## Fakty (zaobserwowane)

- W pliku kont agent-lb pierwsze konto zostało dodane 2026-09-22, trzy kolejne dopiero 2026-10-14 około 20:51.
- Po dodaniu kont rotacja zadziałała: o 22:34:20 pierwsze konto dostało `quotaUntil` ("Resets in 10h24m6s"), a o 22:34:43 plik `agybridge-account.json` na debianovh wskazywał już inne konto. W stanie limitów agybridge (`~/.hermes/state/agy-quota.json`) jest wpis o wyczerpanym limicie. Czyli `report_quota` i pula działają.
- Konfiguracja na debianovh jest poprawna: `agybridge.env` ma `AGENT_LB_URL`, procesy Hermesa mają `AGENT_LB_API_KEY`. `pool_settings()` bierze adres i klucz niezależnie, z env albo z pliku.
- Kod puli (`AccountPool`, `report_quota`) jest zainstalowany na debianovh od 2026-09-22 i wołany z `engine.py`.

## Wykluczone

Brak kodu puli, brak adresu lub klucza, błąd w `report_quota`. Odpowiedź 403 na `/agy/*` jest mało prawdopodobna, bo rotacja 14.10 by wtedy nie przeszła.

## Czego nie udało się sprawdzić (przypuszczenia)

- Log usługi `agentlb` był niedostępny dla agenta (brak uprawnień do journala), więc nie widziano linii "AGY quota spent" ani ewentualnych odpowiedzi 404 "no AGY account with free quota" z okresu jednego konta.
- Kopia `agy-quota.json.bak-20261012` sugeruje wcześniejsze wyczerpanie limitu 12.10, ale to tylko przypuszczenie.

## Czy dotyczy nowej drogi (agent-lb uruchamia `agybridge serve` na konto)

Raczej nie. Przyczyną była pusta pula, nie błąd mostka. Warunek: agent-lb sam reaguje na wyczerpany limit z procesu konta (zrobione w `src/agy-gateway.js`) i ma co najmniej dwa włączone konta.
