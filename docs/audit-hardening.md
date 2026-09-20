# Utwardzenie po audycie

## Cel i kryteria akceptacji

Zamknąć eskalację klient → administrator, podszywanie przez reverse proxy,
obejścia polityk w tunelach oraz nieograniczone oczekiwanie i buforowanie.
Warunkiem wdrożenia są zielone testy, lint, niezależny review i smoke test usługi.

## Kontrakt operacyjny

- Klucz główny służy administracji. Klucze klientów służą inferencji; nie mogą
  eksportować kont, restartować usługi ani czytać/tworzyć innych kluczy.
- Pełny klucz klienta jest pokazywany tylko przy utworzeniu/rotacji. Po przeładowaniu
  dashboardu do instalacji kolejnej stacji trzeba użyć zachowanego klucza lub utworzyć nowy.
- `trustLoopback` i `trustTailnet` domyślnie są wyłączone. Jawny wyjątek sieciowy
  dotyczy wyłącznie inferencji, nigdy administracji. Nagłówki forwarded nie dają wyjątku.
- Klucze z ograniczeniami modelu/dostawcy/tokenów nie mogą korzystać z nieprzezroczystego
  forward proxy ani WebSocketów: takich kanałów nie da się rozliczyć jako inferencji.
- Modele dozwolone porównywane są dokładnie; wildcard `*` musi być jawny. Kontrola
  obejmuje model żądany, advisor i końcowy model po translacji. `allowedProviders`
  dotyczy rzeczywiście wybranego backendu, także po fallbacku.
- `proxy.maxBufferedRequests` (16) i `proxy.maxBufferedBytes` (256 MiB) są wspólne
  dla HTTP i wszystkich listenerów MITM. Budżet obejmuje chunk list i kopię body;
  struktury po parsowaniu mają dodatkowy narzut. Upload ma deadline 30 s.
- `proxy.maxRequestSeconds` (600) ogranicza inferencję wraz z retry. Długie generacje
  mogą wymagać zwiększenia tej wartości. Timeout bezczynności streamu pozostaje
  sterowany przez `AGENT_LB_UPSTREAM_BODY_TIMEOUT_MS`.
- `/metrics` wymaga klucza administratora i eksportuje liczniki statusów, aktywne
  żądania oraz histogramy czasu odpowiedzi i oczekiwania na nagłówki upstream.
  Czas nagłówków nie jest pomiarem pierwszego tokenu; retry daje osobne obserwacje.
- Lock konfiguracji nie jest automatycznie usuwany po timeoutcie. Po awarii sprawdź
  PID zapisany w pliku `.lock`, zanim ręcznie usuniesz osieroconą blokadę.

## Decyzje architektoniczne

Jedna aktywna instancja zarządza daną pulą kont. Sticky sessions nie wystarczają do HA:
quota, refresh tokenów, blokady i admission muszą mieć wspólnego właściciela.
Nie wprowadzamy pozornego trybu stateless ani nowego zewnętrznego magazynu danych
w ramach poprawki bezpieczeństwa. Rozdzielenie kont na rozłączne pule pozwala skalować.

Fallback między dostawcami zachowuje dotychczasowe ustawienie dla kompatybilności;
operator może wyłączyć `crossProviderFallback`, a klucz z `allowedProviders` nigdy
nie może wyjść poza tę listę. Dla danych z ograniczonym miejscem przetwarzania ustaw
listę dozwolonych dostawców i modeli przed udostępnieniem klucza.

## Wdrożenie i rollback

Najpierw zachowaj poprzedni commit i konfigurację (kopie sekretów wyłącznie poza Git,
0600). Uruchom testy z odizolowaną konfiguracją, następnie zrestartuj usługę i sprawdź
`/ready` z kluczem administratora oraz odmowę anonimowego dostępu do `/api/keys`.
Rollback: przywróć poprzednią wersję kodu i zrestartuj usługę; nie cofnij przypadkiem
rotacji poświadczeń. Po naprawie rozważ rotację wcześniej ujawnionych kluczy, ustalając
sposób przekazania nowych kluczy klientom. Automatyczna rotacja wszystkich kluczy
odłączyłaby istniejące stacje.
