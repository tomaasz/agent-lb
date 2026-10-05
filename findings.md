# Ustalenia, Błędy i Notatki Badawcze: Hard Budget Caps w agent-lb

> Plik gromadzi odkrycia architektoniczne, napotkane błędy, rozwiązania oraz ograniczenia środowiska.

---

## 1. Odkrycia architektoniczne i struktura kodu
- **Identyfikacja sesji:** `clientSessionId(headers)` w `src/server.js` sprawdza `x-claude-code-session-id`, `x-session-id`, `session-id` pod kątem `SESSION_ID_SHAPE` (`/^[A-Za-z0-9._-]{1,128}$/`).
- **Śledzenie sesji:** `SessionTracker` w `src/session-tracker.js` utrzymuje sesje w mapie `sessions`. Metoda `recordTokens(sessionId, bucket, usage)` zapisuje tokeny (input, output, cacheRead, cacheCreation) w mapie `s.tokens` per bucket (np. `unified7d`).
- **Zarządzanie kontami:** `AccountManager` w `src/account-manager.js` posiada instancję `this.sessionTracker` i deleguje rejestrację tokenów (`recordTokens`).
- **Bramka proxy:** `createProxyRequestListener` w `src/server.js` obsługuje przychodzące żądania, uwierzytelnianie klienta, kontrolę limitów (fairShare, clientUsage.checkQuota) oraz przekazywanie do upstreamu.

---

## 2. Zrealizowane wdrożenie (Hard Budget Caps)
- **`src/config.js`:**
  - Obsługa konfiguracji `proxy.maxSessionTokens`, `maxSessionTokens` oraz zmiennej środowiskowej `AGENTLB_MAX_SESSION_TOKENS`.
  - Obsługa konfiguracji kodu statusu `proxy.sessionBudgetStatusCode` / `AGENTLB_SESSION_BUDGET_STATUS_CODE` (domyślnie 429, konfigurowalny 402).
  - Eksport funkcji pomocniczych `resolveMaxSessionTokens(config, keyConfig)` oraz `resolveSessionBudgetStatusCode(config)`.
- **`src/session-tracker.js`:**
  - Wzbogacenie `totalTokens(sessionId)` oraz `sessionTokens(sessionId)` o agregację wszystkich tokenów (input, output, cacheRead, cacheCreation) w danej sesji ze wszystkich bucketów.
  - Dodanie metody `resetSessionTokens(sessionId)` pozwalającej na zresetowanie liczników tokenów dla danej sesji.
  - Rozszerzenie `sessionItem` o pole `totalTokens` w zwracanym obiekcie statusu sesji.
- **`src/account-manager.js`:**
  - Dodanie metod pomocniczych `sessionTokens(sessionId)` oraz `resetSessionTokens(sessionId)` delegujących do wewnętrznego `sessionTracker`.
- **`src/server.js`:**
  - Wczesna kontrola budżetu sesji w `createProxyRequestListener` natychmiast po ekstrakcji `sessionId`, zanim nastąpi buforowanie ciała żądania i zanim obciążony zostanie upstream.
  - Natychmiastowe odrzucenie żądania z kodem 429 (lub 402) i nagłówkiem `Retry-After: 60` oraz czytelnym komunikatem błędu wskazującym przekroczony budżet tokenów.
  - Wywołanie `hooks.onRequestEnd` oraz `recordEarlyOutcome` bez tworzenia osieroconego wpisu w TUI activity log.
- **`test/hard-session-budget.test.js`:**
  - 7 testów jednostkowych i integracyjnych pokrywających tracking tokenów, resetowanie, wczesne odcinanie przez proxy oraz test end-to-end z rzeczywistym serwerem proxy HTTP i mockowanym serwerem upstream.

---
## 3. Ograniczenia i specyfika środowiska
- Node.js ESM (`import`/`export`).
- Zestaw testów uruchamiany przez `npm test` (node:test) — 115 testów, 225 subtestów przeszło w 100% sukcesem.
