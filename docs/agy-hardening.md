# AGY: limity, kolejka i poświadczenia

Klucze aplikacji domyślnie mają dostęp do generowania. Pobieranie kont Google
i nieprzezroczyste tunele wymagają `allowCredentialRelay: true`; istniejące
ograniczenia dostawców, modeli i budżetu nadal wykluczają takie tunele.
Uprawnienie administrator zmienia na karcie stacji lub przez
`POST /agent-lb/api/keys/permissions` z nazwą i wartością boolean.
Przed aktualizacją należy jawnie nadać dostęp stacjom używającym lokalnego
mostka. Aplikacjom korzystającym z `/v1/chat/completions` wystarczy klucz API.

Limity odpowiedzi Google dotyczą dokładnego modelu. Wspólne pule można
zdefiniować przez `agy.quotaGroups`, np. mapowanie dwóch identyfikatorów
modeli na tę samą nazwę grupy. Nie wnioskujemy grup z etykiet reportera.
Lokalne 429/401 mostka nie oznaczają wyczerpania limitu/autoryzacji Google.
Potwierdzone błędy logowania i odmowy Google wyłączają konto do ponownego
logowania lub jawnego odblokowania przez administratora. Błędy przejściowe
wprowadzają rosnącą przerwę. Po rozpoczęciu odpowiedzi nie ponawiamy generacji.

Kolejka ma domyślnie 64 oczekujące żądania, maksymalnie 8 na klienta i
30 sekund oczekiwania wraz ze startem mostka. `agy.maxQueued` oraz
`agy.maxQueuedPerClient` pozwalają zmienić pojemność. Klient pochodzi z
uwierzytelnienia; tury są rozdzielane round-robin, wewnątrz klienta FIFO.
Rozłączenie usuwa oczekiwanie. Przepełnienie zwraca 503 z Retry-After.
Panel pokazuje kolejkę oraz ostatnie 100 zdarzeń (bez promptów i poświadczeń).

## Szyfrowanie i odzyskiwanie

Ustaw `agy.encryptionKeyPath` na prywatny plik **poza katalogiem kont**,
np. w osobnym katalogu kluczy w lokalnych danych użytkownika. Przy pierwszym
zapisie powstaje losowy klucz 32 bajty (0600, nowy katalog 0700). Magazyn kont
jest atomowo migrowany do AES-256-GCM z nowym nonce przy każdym zapisie.
Niepoprawne dane, zły/brakujący klucz lub zmodyfikowany szyfrogram zatrzymują
odczyt; nie zastępujemy ich pustą listą. Klucz i zaszyfrowane kopie należy
archiwizować oddzielnie, poza repozytorium.

Przed restartem wykonaj drain i poczekaj na zero aktywnych żądań. Po migracji
sprawdź listę kont, gotowość usługi oraz generację kluczem aplikacji i odmowę
pobrania nim poświadczeń. Zachowaj zaszyfrowaną kopię magazynu i konfiguracji.

**Rollback:** nie uruchamiaj starego wydania na zaszyfrowanym magazynie —
stary kod może potraktować go jak pusty. Preferuj naprawę na wersji obsługującej
szyfrowanie. Jeśli powrót do starej wersji jest konieczny: zatrzymaj usługę,
odszyfruj magazyn funkcją `readAgyStorage` tego wydania, zapisz atomowo prywatny
plik 0600 bez wypisywania treści, usuń ustawienie szyfrowania i dopiero wtedy
uruchom starą wersję. Brak klucza wymaga odzyskania go z kopii lub ponownego
logowania kont; nie generuj zastępczego klucza dla starego szyfrogramu.

Natywny AGY nadal potrzebuje własnych plików logowania workerów. Pozostają
prywatne (0600 w HOME 0700); szyfrowanie centralnego magazynu ich nie obejmuje.
