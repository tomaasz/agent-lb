# AGY przez agent-lb — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modele Gemini z `agy` dostępne w agent-lb za tym samym kluczem co Claude i Codex, z automatycznym przełączaniem kont Google i kartą AGY w panelu taką jak Claude/Codex.

**Architecture:** agent-lb uruchamia dla każdego konta AGY osobny proces `agybridge serve` (serwer zgodny z OpenAI na `127.0.0.1`) z własnym katalogiem domowym, w którym leży token tego konta. Zapytania z modelem `gemini-*` (oraz skróty `agy`/`agy-fast`) agent-lb przekazuje do procesu wybranego konta; odpowiedź 429 przed pierwszym bajtem odpowiedzi oznacza konto jako wyczerpane i ponawia zapytanie na następnym. Do Google rozmawia wyłącznie program `agy` uruchamiany przez agybridge.

**Tech Stack:** Node.js ≥ 20 (ESM, `node:http`, `node:child_process`), `node:test`; agybridge (Python 3.11+, repo `tomaasz/agybridge`) jako zewnętrzny proces; `agy` 1.3.5.

**Spec:** `docs/superpowers/specs/2026-10-14-agy-przez-agentlb-design.md`

## Global Constraints

- Żadnych zapytań z agent-lb do `*.googleapis.com`. Do Google rozmawia tylko `agy` (przez agybridge).
- Na `/v1/models` tylko modele, których id zaczyna się od `gemini-`, nazwane dokładnie tak, jak zwraca `agy models` (np. `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high`); każdy poziom wysiłku to osobny model. Lista pobierana z `agy`, nie wpisana na stałe.
- `agy` i `agy-fast` przyjmowane, ale niewidoczne w `/v1/models`.
- Zapytania `gemini-*`, `agy`, `agy-fast` nie są już po cichu podmieniane na Claude/GPT. Brak wolnego konta AGY → błąd 429 dla klienta.
- Tokeny kont nie trafiają do panelu, logów ani odpowiedzi API.
- Tryb stacji (`GET /agy/credential`, `POST /agy/quota`, `POST /agy/usage`) bez zmian.
- Format `agent-lb.agy-accounts.json` bez przebudowy (wolno dopisywać nowe pola do konta).
- Bez zewnętrznych zależności npm. Testy: `npm test`; lint: `npm run lint` (`--max-warnings=0`).
- Po każdym zadaniu commit; push na `origin` po przejściu `npm test` i `npm run lint`. Instalacja agybridge na debian-lite, restart `agentlb.service` i deploy — tylko po osobnym „tak” użytkownika.

## Review Focus

1. Dwa zapytania naraz na tym samym koncie, gdy jego proces jeszcze się nie uruchomił — oczekiwane: jeden proces, oba zapytania obsłużone (Task 3: `concurrent first requests share one worker`).
2. Proces agybridge danego konta pada w trakcie pracy — oczekiwane: następne zapytanie uruchamia go od nowa, a nie wisi (Task 3: `restarts a worker that exited`).
3. Wszystkie konta wyczerpane lub wyłączone — oczekiwane: szybkie 429 z czytelnym komunikatem, bez pętli ponowień (Task 4: `all accounts spent returns 429 without looping`).
4. Klient zrywa połączenie w trakcie strumienia — oczekiwane: zapytanie do procesu konta jest przerywane, licznik zajętości konta zwalniany (Task 4: `client abort releases the account slot`).
5. `agy models` zawodzi albo zwraca pustą listę — oczekiwane: `/v1/models` dalej działa, z ostatnią znaną listą albo bez modeli Gemini, i nie wywraca listy Claude/Codex (Task 2: `listing failure keeps last known models`).

---

### Task 1: Test bramkujący — czy agybridge przepuszcza narzędzia (bez kodu w repo)

Bramka z projektu: bez działających wywołań narzędzi Hermes nie ma sensu przez tę drogę. **Jeśli wynik jest negatywny, przerwij plan i wróć do użytkownika.**

**Files:**
- Create: `docs/superpowers/plans/2026-10-14-agy-tool-gate.md` (zapis wyniku)

- [ ] **Step 1: Przygotuj agybridge w katalogu tymczasowym sesji** (venv w scratchpad, źródło: `gh repo clone tomaasz/agybridge`, `pip install -e .`). Nie instaluj nic globalnie ani jako usługi.
- [ ] **Step 2: Uruchom `agybridge serve --host 127.0.0.1 --port 18791 --token <losowy>`** na lokalnym logowaniu `agy` z debian-lite (bez `AGENT_LB_URL`/`AGENT_LB_API_KEY` w środowisku).
- [ ] **Step 3: Wyślij zapytanie z narzędziem**, `stream: true`, model `gemini-3.8-flash-low`, `tools` z jedną funkcją `get_time()` i wiadomością „Która jest godzina? Użyj narzędzia.”
  Expected: w strumieniu pojawia się `delta.tool_calls` z `function.name == "get_time"`.
- [ ] **Step 4: Wyślij drugą turę** z `role: "tool"` i wynikiem; Expected: odpowiedź tekstowa korzystająca z wyniku.
- [ ] **Step 5: Zapisz wynik** (polecenia, kody, fragmenty odpowiedzi bez tokenów) w pliku z sekcji Files i zacommituj.

```bash
git add docs/superpowers/plans/2026-10-14-agy-tool-gate.md
git commit -m "docs(agy): wynik testu narzędzi przez agybridge serve"
```

---

### Task 2: Lista modeli Gemini z `agy`

**Files:**
- Create: `src/agy-models.js`
- Modify: `src/server.js:1783` (dołożenie modeli Gemini do `listedModels`)
- Test: `test/agy-models.test.js`

**Interfaces:**
- Produces:
  - `parseAgyModels(stdout: string) -> Array<{ id: string, name: string }>` — wiersze `id<TAB>nazwa`, tylko `id` zaczynające się od `gemini-`, w kolejności z `agy`.
  - `class AgyModelCatalog { constructor({ run: (homeDir) => Promise<string>, homeFor: () => string|null, ttlMs = 900000, now = Date.now }); async list() -> Array<{id,name}>; resolveAlias(model: string) -> string|null }`
  - `resolveAlias('agy')` → pierwszy model kończący się na `-high`, inaczej pierwszy; `resolveAlias('agy-fast')` → pierwszy kończący się na `-low`, inaczej pierwszy; id `gemini-*` z listy → to samo id; inne → `null`.
  - `isAgyModelName(model: string) -> boolean` — `agy`, `agy-fast` lub prefiks `gemini-`.

- [ ] **Step 1: Write the failing tests**

```js
test('parseAgyModels keeps only gemini rows in agy order', () => {
  const out = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';
  assert.deepEqual(parseAgyModels(out), [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ]);
});
test('parseAgyModels ignores the "Fetching available models..." banner', ...);
test('aliases resolve to high and low variants', async () => {
  // catalog z listą [flash-high, flash-medium, flash-low]
  assert.equal(cat.resolveAlias('agy'), 'gemini-3.8-flash-high');
  assert.equal(cat.resolveAlias('agy-fast'), 'gemini-3.8-flash-low');
  assert.equal(cat.resolveAlias('gpt-5'), null);
});
test('list() is cached for ttlMs and refreshed after', ...); // run wywołane 1 raz w TTL, 2 razy po upływie
test('listing failure keeps last known models', ...);        // run rzuca po udanym pierwszym razie → list() zwraca poprzednią listę
test('no account home → empty list, run not called', ...);
```

- [ ] **Step 2: Run** `node --test test/agy-models.test.js` — Expected: FAIL (moduł nie istnieje).
- [ ] **Step 3: Implement `src/agy-models.js`.** `run` domyślnie: `execFile(resolveAgyCommand(config), ['models'], { env: { ...minimalEnv, HOME: homeDir }, timeout: 60000 })`. Odświeżenie w tle nie blokuje `list()`, jeśli jest poprzednia lista.
- [ ] **Step 4: Run** `node --test test/agy-models.test.js` — Expected: PASS.
- [ ] **Step 5: Dołóż modele do `/v1/models` w `src/server.js`.** Po `listedModels` dodaj wynik `agyCatalog.list()` jako `{ id, name, display_name: name, context_window: 1000000, max_tokens: 65536, description: name }` (wartości okna to moja decyzja — wpisz je jako stałe w `agy-models.js`). Błąd katalogu nie może przerwać odpowiedzi. Dodaj test w `test/agy-models.test.js`: `GET /v1/models lists gemini ids and hides agy aliases` (serwer z podstawionym katalogiem).
- [ ] **Step 6: Run** `npm test && npm run lint` — Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add src/agy-models.js src/server.js test/agy-models.test.js
git commit -m "feat(agy): lista modeli Gemini z agy w /v1/models"
```

---

### Task 3: Procesy agybridge dla kont

**Files:**
- Create: `src/agy-workers.js`
- Modify: `src/agy-accounts.js` (eksport ścieżki katalogu domowego konta; nowe pole konta `seededAt`)
- Test: `test/agy-workers.test.js`

**Interfaces:**
- Consumes: `AgyAccountStore` (`_find`, `data.accounts`, `TOKEN_PATH`) z `src/agy-accounts.js`.
- Produces:
  - `accountHome(baseDir: string, accountId: string) -> string` — `<baseDir>/<accountId>`; `baseDir` domyślnie `<katalog konfiguracji>/agy-homes`, tryb 0700.
  - `class AgyWorkerPool { constructor({ store, baseDir, command, spawn = child_process.spawn, maxPerAccount = 2, idleMs = 600000, portFrom = 18800 }); async acquire(accountId) -> { port: number, token: string, release: () => void }; busy(accountId) -> number; stopAll() -> void }`
  - Zachowanie: przy pierwszym `acquire` zapisuje token konta do `<home>/.gemini/antigravity-cli/antigravity-oauth-token` (0600), tylko jeśli pliku nie ma albo `account.updatedAt > account.seededAt` (ponowne logowanie); nie nadpisuje pliku odświeżanego przez `agy`. Uruchamia `command serve --host 127.0.0.1 --port <p> --token <losowy>` z env: `HOME=<home>`, `PATH`, `AGYBRIDGE_CONFIG=<home>/.config/agybridge/none.env`, bez `AGENT_LB_URL`/`AGENT_LB_API_KEY`. Gotowość: `GET /health` → 200 (do 20 s). Więcej niż `maxPerAccount` równoległych `acquire` dla konta → czeka w kolejce (anty-cel: blokada kont).
  - `command` z `config.agy.bridgeCommand` (domyślnie `agybridge`).

- [ ] **Step 1: Write the failing tests** (fałszywy `spawn` uruchamia mały serwer HTTP w teście):

```js
test('first acquire seeds the token file 0600 and starts one worker', ...); // plik istnieje, mode & 0o777 === 0o600, spawn wołany raz z HOME = accountHome(...)
test('worker env has no AGENT_LB_URL or AGENT_LB_API_KEY', ...);
test('does not overwrite a token file refreshed by agy', ...);   // drugi acquire po zmianie pliku → treść bez zmian
test('re-login (updatedAt > seededAt) reseeds the token', ...);
test('concurrent first requests share one worker', ...);         // Promise.all([acquire(a), acquire(a)]) → spawn 1x
test('restarts a worker that exited', ...);                      // proces kończy się → następny acquire spawnuje ponownie
test('more than maxPerAccount waits until release', ...);         // 3. acquire rozwiązuje się dopiero po release()
test('idle worker is stopped after idleMs', ...);                // z podstawionym zegarem
```

- [ ] **Step 2: Run** `node --test test/agy-workers.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement `src/agy-workers.js`** i drobne dopiski w `src/agy-accounts.js`.
- [ ] **Step 4: Run** `node --test test/agy-workers.test.js` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/agy-workers.js src/agy-accounts.js test/agy-workers.test.js
git commit -m "feat(agy): procesy agybridge per konto z izolowanym HOME"
```

---

### Task 4: Kierowanie zapytań Gemini przez pulę kont

**Files:**
- Create: `src/agy-gateway.js`
- Modify: `src/agy-accounts.js` (`pick`, `recordRequest`), `src/server.js:6258-6280` (gałąź AGY przed obecnym wyborem `targetProvider`), `src/server.js:9839-9845` i `:10076-10087` (usunięcie mapowania `agy`/`gemini-*` na Claude), `src/model-substitution.js`, `src/provider-translator.js` (usunięcie podmiany `gemini-*`/`agy*` na Claude/GPT, jeśli tam jest)
- Test: `test/agy-gateway.test.js`

**Interfaces:**
- Consumes: `AgyWorkerPool.acquire` (Task 3), `AgyModelCatalog.resolveAlias`, `isAgyModelName` (Task 2).
- Produces:
  - `AgyAccountStore.pick(exclude: Set<string>) -> account|null` — przypięte (jeśli dostępne i nie w `exclude`), dalej dostępne konta posortowane po najbliższym `usage.models[].resetAt` (brak danych = na końcu, w kolejności z panelu).
  - `AgyAccountStore.recordRequest(id, { inputTokens, outputTokens }) -> void` — pole konta `stats: { requests, inputTokens, outputTokens, lastAt }`, zapis do pliku najwyżej co 10 s.
  - `async handleAgyCompletion(req, res, { body: Buffer, model: string, store, pool, catalog, usageRecorder, hooks }) -> void` — tylko `POST /v1/chat/completions`. Podmienia `model` na wynik `resolveAlias`, wybiera konto `pick`, przekazuje zapytanie do `127.0.0.1:<port>/v1/chat/completions` z `Authorization: Bearer <token procesu>`, przekazuje strumień klientowi bez zmian.
  - 429 od procesu **przed wysłaniem nagłówków do klienta** → `store.markQuota(id, Retry-After || null, komunikat)` i ponowienie na następnym koncie (najwyżej tyle prób, ile kont). Po wysłaniu nagłówków błąd idzie do klienta.
  - Brak konta → 429 `{ error: { type: "rate_limit_error", code: "insufficient_quota", message: "Brak konta AGY z wolnym limitem" } }`.
  - `model` nieznany katalogowi (np. `gemini-9`) → 404 `model_not_found`.
  - Zapytania AGY na `/v1/messages` (format Anthropic) → 400 z komunikatem, że AGY obsługuje `/v1/chat/completions` (moja decyzja: Hermes używa `chat_completions`; tłumaczenie Anthropic→AGY poza zakresem).
- Konfiguracja w `src/server.js`: `agyStore`, `AgyWorkerPool`, `AgyModelCatalog` tworzone leniwie razem (wyciągnij obecny blok z `:679-686` do funkcji `ensureAgy()`); `pool.stopAll()` przy zamykaniu serwera.

- [ ] **Step 1: Write the failing tests** (fałszywa pula z serwerami HTTP zwracającymi zadane odpowiedzi):

```js
test('streams a completion from the picked account unchanged', ...);
test('agy alias is rewritten to the catalog model before forwarding', ...);
test('429 before headers marks the account and retries on the next', ...); // store.list()[0].quotaUntil > now; odpowiedź z konta #2
test('all accounts spent returns 429 without looping', ...);               // liczba wywołań procesu === liczba kont
test('error after first byte is passed to the client, no retry', ...);
test('pinned account is used first; disabled is skipped', ...);
test('client abort releases the account slot', ...);                      // pool.busy(id) === 0 po zerwaniu
test('records request and token counts from the final usage chunk', ...);
test('gemini model is no longer substituted to claude/gpt', ...);         // test na normalizeAnthropicModelForOAuth i model-substitution
test('response never contains the account token', ...);
```

- [ ] **Step 2: Run** `node --test test/agy-gateway.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/agy-gateway.js`, `pick`/`recordRequest` w `src/agy-accounts.js`, wpięcie w `src/server.js` (gałąź `isAgyModelName(model)` → `handleAgyCompletion`, wykonana po rejestracji `usageRecorder` i przed ustaleniem `targetProvider`), usunięcie starego mapowania.
- [ ] **Step 4: Run** `npm test && npm run lint` — Expected: PASS (popraw istniejące testy, które sprawdzały podmianę `gemini-*` na Claude — zachowanie świadomie zmienione przez projekt).
- [ ] **Step 5: Commit**

```bash
git add src/agy-gateway.js src/agy-accounts.js src/server.js src/model-substitution.js src/provider-translator.js test/
git commit -m "feat(agy): zapytania Gemini przez pulę kont AGY z automatycznym przełączaniem"
```

---

### Task 5: Panel — karta AGY jak Claude/Codex i wiersz Gemini w routingu

**Files:**
- Modify: `src/dashboard.js` (sekcja `#colAgy` `:1296`, `renderAgyAccounts` `:6207`, tabela routingu, i18n PL/EN), `src/agy-accounts.js` (`list()` dodaje `stats`, `busy`; akcja `accounts/test`)
- Test: `test/dashboard-routes.test.js`, `test/agy-accounts.test.js`

**Interfaces:**
- Consumes: `store.list()`, `pool.busy(id)`, `handleAgyCompletion` (do testu konta).
- Produces:
  - `POST /api/agy/accounts/test` `{ id }` → wysyła przez proces tego konta zapytanie `"Odpowiedz jednym słowem: OK"` na pierwszy model z katalogu kończący się na `-low`; zwraca `{ ok, ms, model }` albo `{ ok:false, error }`. Nie zmienia kolejności ani przypięcia.
  - `GET /api/agy/accounts` → konta z dodatkowymi polami `stats` i `busy`.
- Wygląd (wariant A z makiety): kolumna „AGY (Google)” obok Claude i Codex w tym samym układzie kart (`account-col`, `account-list`, przeciąganie ⠿ → istniejąca akcja `accounts/reorder`); na karcie: numer, status (ZDROWE / LIMIT WYCZERPANY + „odnowi za …” z `quotaUntil`), e-mail, paski z `usage.models` (jeśli są), licznik „N zapytań · X tok · czas temu” ze `stats`, przyciski Test / przypnij / wyłącz / wyczyść limit / usuń, przycisk „Zaloguj konto Google” w nagłówku kolumny. Wiersz „Gemini” w tabeli routingu: lista id z katalogu i „N z M” kont dostępnych.

- [ ] **Step 1: Write the failing tests:**

```js
test('GET /api/agy/accounts includes stats and busy, never token', ...);
test('POST /api/agy/accounts/test runs a request on that account only', ...);
test('dashboard HTML has the AGY column in the accounts grid', ...); // id listAgy z data-provider="agy" obok listClaude/listCodex
```

- [ ] **Step 2: Run** `node --test test/dashboard-routes.test.js test/agy-accounts.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** zmiany w `src/dashboard.js` i `src/agy-accounts.js`.
- [ ] **Step 4: Run** `npm test && npm run lint` — Expected: PASS.
- [ ] **Step 5: Sprawdź w przeglądarce** (skill `run`): panel na lokalnym, testowym agent-lb (nie produkcyjny `agentlb.service`) z podstawionym plikiem kont bez prawdziwych tokenów — karta AGY wygląda jak karty Claude/Codex, przeciąganie zmienia kolejność.
- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js src/agy-accounts.js test/
git commit -m "feat(agy): karta AGY w panelu jak Claude/Codex, wiersz Gemini w routingu"
```

---

### Task 6: Hermes i dokumentacja

**Files:**
- Modify: `setup/hermes-setup.sh:132-205`, `README.pl.md:203-216`, `README.md` (odpowiednia sekcja AGY)
- Test: `test/hermes-setup.test.js`

**Interfaces:**
- Consumes: `GET /v1/models` (Task 2).
- Produces: `hermes-setup.sh` pobiera `/v1/models` z kluczem i dopisuje do `MODELS` providera `agentlb` wszystkie id `gemini-*`. Natywne providery `agy`/`agy-fast` zostają w konfiguracji, jeśli już są (nie usuwamy automatycznie), ale nie są dopisywane nowym instalacjom.

- [ ] **Step 1: Write the failing test** w `test/hermes-setup.test.js`: `adds gemini models from /v1/models to the agentlb provider` (fałszywy serwer zwraca `gemini-3.8-flash-low`, `gemini-3.8-flash-high`, `claude-sonnet-5`; w wygenerowanym `config.yaml` provider `agentlb` ma oba id Gemini) oraz `keeps an existing native agy provider untouched`.
- [ ] **Step 2: Run** `node --test test/hermes-setup.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** w `setup/hermes-setup.sh`; zaktualizuj README (PL i EN): AGY przez proxy, wymagany agybridge na serwerze agent-lb (`config.agy.bridgeCommand`), tryb stacji bez zmian.
- [ ] **Step 4: Run** `npm test && npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit i push**

```bash
git add setup/hermes-setup.sh README.md README.pl.md test/hermes-setup.test.js
git commit -m "feat(agy): Hermes dostaje modele Gemini przez providera agentlb"
git push origin main
```

---

### Task 7: Śledztwo — czemu rotacja na debianovh nie zadziałała (tylko odczyt, równolegle)

Nie blokuje Tasków 2–6. Bez zmian na debianovh.

**Files:**
- Create: `docs/reports/2026-10-14-agy-rotacja-debianovh.md`

- [ ] **Step 1:** Na debianovh (ssh, tylko odczyt) sprawdź logi `hermes-gateway`/`hermes-serve` od 2026-09-22 pod kątem `AGY quota`, `agent-lb pool`, `could not install`, `/agy/quota`; sprawdź, czy klucz stacji jest „nieograniczony” (`relayPolicyAllowed`) — 403 z `/agy/quota` wyjaśniałby brak zgłoszeń.
- [ ] **Step 2:** Na debian-lite sprawdź log `agentlb.service` pod kątem `AGY quota spent on` i 403 dla `/agy/`.
- [ ] **Step 3:** Zapisz przyczynę (lub listę wykluczonych przyczyn) i czy dotyczy nowej drogi; jeśli dotyczy — dopisz poprawkę jako krok do zadania, które obejmuje ten kod. Commit raportu.

---

### Task 8: Uruchomienie na debian-lite (wymaga osobnego „tak”)

- [ ] **Step 1: Zapytaj użytkownika o zgodę** na: instalację agybridge na debian-lite (`~/projekty/agybridge`, venv), ustawienie `config.agy.bridgeCommand`, restart `agentlb.service`.
- [ ] **Step 2:** Po zgodzie: instalacja, restart, `GET /v1/models` pokazuje modele `gemini-*`; `POST /v1/chat/completions` z `gemini-3.8-flash-low` przez `https://agentlb.gotova.pl` zwraca odpowiedź; panel pokazuje licznik na koncie.
- [ ] **Step 3:** Zapytaj o zgodę na uruchomienie `hermes-setup.sh` na debianovh; po zgodzie sprawdź odpowiedź Hermesa na modelu Gemini przez providera `agentlb`.
