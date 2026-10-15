# AGY przez agent-lb — tak samo jak Claude i Codex

Data: 2026-10-14. Status: projekt do zatwierdzenia (nic jeszcze nie zbudowano).

## Po co to jest

Dziś Claude i Codex działają tak: klient (np. Hermes) dostaje jeden klucz agent-lb, a agent-lb sam wybiera konto, pilnuje limitów i przełącza na następne. AGY (Google Antigravity CLI) działa inaczej: agent-lb tylko wydaje stacjom konto Google, a samo `agy` chodzi lokalnie na stacji przez agybridge. Ruch AGY nie przechodzi przez agent-lb, więc nie ma w panelu pasków zużycia, przycisku Test ani liczników zapytań.

Powód zmiany: na debianovh Hermes używał AGY na koncie nr 2 w puli, konto wyczerpało limit i praca stanęła, choć w puli były trzy inne konta. Rotacja istnieje w kodzie (`GET /agy/credential`, `POST /agy/quota`), ale nie zadziałała i nie wiadomo dlaczego. Użytkownik chce jednego klucza z agent-lb, który sam przełącza między dodanymi kontami.

Sukces to: Hermes na debianovh używa modeli Gemini przez agent-lb tym samym kluczem co Claude i Codex; po wyczerpaniu konta agent-lb przełącza się na następne bez widocznej przerwy; w panelu AGY wygląda i działa jak Claude i Codex.

## Cele

- Modele Gemini z `agy` dostępne na `/v1/chat/completions` i `/v1/models` agent-lb, za tym samym kluczem co reszta.
- Wybór konta, oznaczanie wyczerpanych i ponawianie zapytania na następnym koncie robi agent-lb, nie klient.
- W panelu karta AGY taka sama jak karty Claude i Codex (wariant A z makiety): kolumna „AGY (Google)”, karta na konto z paskami limitów, przyciskiem Test, licznikami zapytań i tokenów, przeciąganiem kolejności, przypięciem, wyłączeniem, logowaniem konta Google.
- Wiersz „Gemini” w tabeli routingu u góry panelu, obok Sonnet i Haiku.

## Czego NIE robimy

- agent-lb nie wysyła zapytań bezpośrednio do API Google (`*.googleapis.com`). Zapytania do Google idą wyłącznie przez prawdziwy program `agy`.
- Nie wystawiamy modeli Claude ani GPT-OSS, które `agy` też zwraca na swojej liście. Tylko Gemini.
- Nie ruszamy trybu stacji (stacje z agybridge i kluczem stacji dalej pobierają konto z `GET /agy/credential`). Zostaje bez zmian.
- Nie przebudowujemy formatu pliku z kontami AGY (`agent-lb.agy-accounts.json`).

## Czego absolutnie unikać (anty-cele)

- Ryzyko blokady kont Google. Użytkownik wprost się go obawia. Nic, co wygląda jak nietypowy ruch (np. dziesiątki równoległych procesów `agy` na jednym koncie), nie może przejść bez ograniczenia.
- Tokeny kont nie trafiają do panelu, logów ani odpowiedzi API (jak dziś).
- Ciche podmienianie zapytań `gemini-*` na Claude/GPT po zmianie ma przestać działać dla tych modeli.

## Ustalone przez użytkownika

1. Zapytania do Google tylko przez `agy`, bez bezpośredniego wołania API.
2. Na liście modeli są prawdziwe modele Gemini dostępne w `agy`, zamiast `agy` i `agy-fast`.
3. Każdy poziom wysiłku jest osobnym modelem na liście (np. `gemini-3.8-flash-low`, `-medium`, `-high`), nazwany tak jak zwraca `agy models`.
4. Lista modeli ma być aktualna: pobierana z `agy`, nie wpisana na stałe. Użytkownik pokazał, że w `agy` są teraz m.in. Gemini 4 Argon i Gemini 3.8 Flash.
5. Panel: wariant A.

## Moje decyzje (do sprawdzenia przez użytkownika)

- agent-lb uruchamia `agy` na własnym serwerze (debian-lite, tam jest `agy` 1.3.5). Dla każdego konta z puli osobny, odizolowany katalog domowy z jego logowaniem, żeby konta się nie mieszały.
- Do rozmowy z `agy` użyć kodu z agybridge (obsługa narzędzi, sesji, rozpoznawanie „limit wyczerpany”), uruchamianego przez agent-lb jako pomocniczy proces. Alternatywa: przepisać potrzebne fragmenty na Node. Jedno albo drugie zależy od wyniku sprawdzenia poniżej.
- Wybór konta: to, któremu limit odnowi się najwcześniej (jak dziś przy Claude i Codex), z uwzględnieniem przypięcia i wyłączenia.
- Po wyczerpaniu limitu: oznaczyć konto jako zajęte do czasu odnowienia, ponowić zapytanie na następnym koncie.
- Stare nazwy `agy` i `agy-fast` zostają jako niewidoczne skróty (`agy` → najmocniejszy dostępny Gemini, `agy-fast` → Flash na low), żeby obecna konfiguracja Hermesa się nie zepsuła. Nie pojawiają się w `/v1/models`.
- `hermes-setup.sh` dodaje modele Gemini do providera `agentlb`; natywny provider `agy` w Hermesie przestaje być potrzebny, ale nie usuwamy go automatycznie.

## Rozstrzygnięte po przeglądzie dokumentu

Sprawdzone w kodzie i na maszynach:
- agent-lb działa jako usługa `agentlb.service` na debian-lite, tam samo jest `agy` 1.3.5. Konta w `agent-lb.agy-accounts.json` zawierają tokeny; agybridge już dziś wstawia taki token do pliku logowania `agy` (`~/.gemini/antigravity-cli/antigravity-oauth-token`), więc osobny katalog domowy na konto da się zasilić zapisanym tokenem bez logowania na serwerze. Przycisk „Zaloguj konto Google” w panelu już istnieje i zostaje.
- agybridge to osobne repozytorium (`tomaasz/agybridge`, oba projekty należą do użytkownika). Jest na debianovh w `~/projekty/agybridge`, ale **nie ma go na debian-lite** — trzeba go tam zainstalować.

Moje decyzje:
- **Narzędzia są wymagane.** Hermes jest agentem, a dzisiejsze AGY w Hermesie działa z mostkowaniem narzędzi. Pierwszy krok budowy to krótki test bramkujący: czy agybridge w trybie serwera HTTP przepuszcza wywołania narzędzi tak, jak potrzebuje Hermes. Jeśli nie, budowa staje i wracamy do użytkownika z wyborem, zamiast przepisywać most po cichu.
- **Streaming (SSE) jest wymagany** na `/v1/chat/completions` (Hermes używa trybu `chat_completions`; agybridge już obsługuje SSE). Ponawianie na następnym koncie jest możliwe tylko dopóki klient nie dostał pierwszego tokenu — komunikat o wyczerpanym limicie pojawia się na początku odpowiedzi. Błąd po pierwszym tokenie wraca do klienta jako błąd.
- **Dlaczego rotacja na debianovh nie zadziałała** — krótkie, tylko do odczytu śledztwo na początku budowy, równolegle z resztą (nie blokuje jej). Jeśli okaże się, że przyczyna dotyczy też nowej drogi, naprawiamy ją tam.
- **agybridge jako zależność:** agent-lb uruchamia go jako osobny proces potomny ze ścieżką ustawianą w konfiguracji (nie kopiujemy kodu do agent-lb). Cykl życia procesu (start, restart) należy do agent-lb jako część usługi `agentlb.service`.
- **Wiersz „Gemini” w tabeli routingu** działa jak wiersze Sonnet i Haiku: pokazuje, które konta mogą obsłużyć rodzinę modeli. Nie dodajemy nowych ustawień routingu.

## Zgoda użytkownika (2026-10-14)

Zatwierdzenie tego dokumentu jest jawną zgodą na zmiany **w repozytorium** w obszarach chronionych przez `PROJECT_CONTEXT.md`: przechowywanie i obsługa tokenów kont AGY, routing w `src/server.js`, skrypty `setup/*`. Poza repozytorium zgody nie ma: instalacja agybridge na debian-lite, restart `agentlb.service` i każdy deploy wymagają osobnego „tak” w chwili, gdy do nich dojdzie.

## Czego jeszcze nie wiem (do sprawdzenia przy budowie, nie zgadywać)

- Czy agybridge w trybie serwera HTTP (`/v1/chat/completions`) obsługuje wywołania narzędzi tak, jak potrzebuje Hermes. Jeśli nie, trzeba to rozstrzygnąć przed budową.
- Jak uruchamiać wiele kont naraz: czy jeden proces agybridge na konto z własnym `HOME`, czy proces na zapytanie. Wpływa na koszt i na ryzyko z sekcji anty-celów.
- Jaki identyfikator ma Gemini 4 Argon w `agy models` (na debian-lite go nie widać; lista zależy od konta). Dlatego lista ma być pobierana na żywo z konta z puli.
- Czy `agy` podaje dane o limitach (zużycie, czas do odnowienia) inaczej niż przez komunikat o błędzie („Resets in 93h56m25s”). Paski w panelu pokazujemy tylko z danych, które `agy` faktycznie daje. Commit `9ac6c8a` już pokazuje limity AGY w panelu — sprawdzić, skąd te dane.
- Dlaczego dotychczasowa rotacja na debianovh nie zadziałała (bridge ma klucz stacji, pliki są aktualne, w panelu brak zgłoszeń zużycia). Przyczyna może być wspólna z nowym rozwiązaniem, więc trzeba ją znaleźć, nie omijać.

## Ograniczenia projektu

- Zasady repozytorium (`PROJECT_CONTEXT.md`): zmiany w przechowywaniu poświadczeń i tokenów, w routingu proxy (`src/server.js`) i w skryptach `setup/*` wymagają jawnej zgody przed zmianą; po testach commit i push na `origin`; deploy i operacje sieciowe poza repo tylko za zgodą.
- Node.js 20+, ESM, bez zewnętrznych frameworków webowych; panel to czysty JS w `src/dashboard.js`; testy: `npm test`, lint: `npm run lint`.
- Istniejące moduły do ponownego użycia: `src/agy-accounts.js` (pula kont, przypięcie, limity), wybór konta jak przy Claude/Codex w `src/server.js`.

## Zostawione budowniczemu

Szczegóły techniczne: sposób uruchamiania `agy`/agybridge, limity równoległości na konto, format danych o limitach w panelu, kolejność kroków, testy, sposób pobierania i odświeżania listy modeli (np. jak często).
