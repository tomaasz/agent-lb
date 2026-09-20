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

## Uzupełnienie audytu: polityka, obserwowalność i podział kodu

Nowe konfiguracje mają `fallbackPolicy.mode: "explicit"`. Każda zmiana nazwy
modelu, również wskutek mapowania lub fallbacku, wymaga dokładnej reguły:

```json
{
  "fallbackPolicy": {
    "mode": "explicit",
    "rules": [
      { "fromModel": "claude-custom", "toProvider": "codex", "toModel": "gpt-target" }
    ]
  }
}
```

Nazwy w przykładzie zastąp modelami obsługiwanymi przez własne backendy.
Niedozwolona zamiana zwraca 403 przed wywołaniem upstream. Reguła nie omija
`allowedModels` ani `allowedProviders` klucza. Istniejące konfiguracje bez polityki
zachowują tryb `legacy`; migracja wymaga spisania używanych aliasów i zamian.
Zmiana dostawcy bez zmiany nazwy modelu nadal podlega `allowedProviders`.

`agentlb_time_to_first_token_seconds` mierzy czas od przyjęcia żądania do pierwszego
rozpoznanego fragmentu treści, rozumowania lub narzędzia ze strumienia upstream.
Pomija ramki metadanych. To pomiar otrzymania tokenu przez proxy, również jeśli
proxy buforuje odpowiedź dla klienta niestrumieniowego; nie mierzy dostarczenia
tokenu do klienta. Odpowiedzi bez rozpoznanych ramek SSE nie dodają obserwacji.

Administracyjne `/alerts` oraz metryka `agentlb_alert` pokazują alarm, gdy ponad 10%
z co najmniej 20 zakończonych żądań w ostatnich pięciu minutach ma status 5xx lub
499. Historia jest ograniczona do 10 000 żądań na proces. Monitorowanie zewnętrzne:
`monitoring/alerts.yml` zawiera reguły Prometheus dla niedostępności, błędów i TTFT.
Operator musi załadować reguły, skonfigurować scrape z kluczem administratora oraz
odbiorców Alertmanager; samo dodanie pliku nie włącza powiadomień.

Warstwy wydzielone z serwera: `access-control.js` (uwierzytelnienie),
`client-key-admin.js` (zarządzanie kluczami), `control-body.js` (limit body),
`stream-lifecycle.js` (timeout i zakończenie streamu), `first-token.js`
(odczyt ramek metryki), `model-substitution.js` (polityka zamian).
Tworzenie klucza zapisuje jeden kompletny wpis; obsługuje limity tokenów, termin
ważności, modele i dostawców. Pusta lista oznacza brak ograniczenia danego typu.
Usuwanie nie zwraca ani nie loguje poświadczenia.

Weryfikacja obejmuje 24 równoległe duże żądania przy limicie dwóch aktywnych,
odmowę niejawnej zamiany modelu, rozdzielone ramki SSE, alarmy i cykl życia klucza.
Nie jest to benchmark pojemności produkcyjnej. CI sprawdza Node 20/22/24/26,
lint bez ostrzeżeń i budowę obrazu; `package-lock.json` jest wersjonowany.

## Pozostałe zależności operacyjne

- HA wymaga wskazania hostów i decyzji: jedna aktywna instancja z zapasową albo
  współdzielony stan i koordynacja wielu aktywnych replik.
- Rotacja istniejących kluczy wymaga listy klientów i sposobu dystrybucji;
  endpoint rotacji jest dostępny, lecz nie zmienia automatycznie konfiguracji stacji.
- Migracja istniejącej instalacji na jawną politykę zamian wymaga zatwierdzenia
  obsługiwanych par modeli. Domyślna polityka nowych instalacji jest już jawna.

Starsze wersje mogły zapisać dwa wpisy tego samego klienta: pierwszy bez polityk.
Przed wdrożeniem sprawdź duplikaty nazw i kluczy bez wypisywania poświadczeń.
Odtwórz taki wpis przez create/upsert z kompletem zamierzonych ograniczeń
i zachowanym kluczem, jeśli nie planujesz jego rotacji. Sam restart lub rotacja
nie naprawiają historycznego wpisu bez polityk.
