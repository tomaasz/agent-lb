# Plan Zadania: [Rec] Wdrożenie twardych limitów budżetowych (Hard Budget Caps) w agent-lb

> **Cel:** Zabezpieczenie przed ucieczką pętli agentowych (Claude Code, Codex) poprzez wprowadzenie mechanizmu twardych limitów tokenowych per sesja na poziomie proxy agent-lb, odrzucającego żądania kodem 429/402 po przekroczeniu limitu (np. 100k tokenów).
> **Status:** Zakończone
> **Ostatnia aktualizacja:** 2026-10-05 15:40

---

## 1. Fazy i Zadania

### Faza 1: Rozpoznanie i architektura
- [x] Analiza istniejącego śledzenia sesji w `src/session-tracker.js`
- [x] Analiza rejestrowania tokenów w `src/account-manager.js` i `src/server.js`
- [x] Analiza punktu wejściowego żądań i odmów (`createProxyRequestListener`, `denyClientPolicy`)
- [x] Zaprojektowanie interfejsu konfiguracji (`maxSessionTokens`) i mechanizmu odcinania

### Faza 2: Implementacja
- [x] Rozszerzenie konfiguracji w `src/config.js` (`proxy.maxSessionTokens` / `maxSessionTokens` / env `AGENTLB_MAX_SESSION_TOKENS`)
- [x] Dodanie/rozszerzenie śledzenia sumarycznych tokenów per sesja w `src/session-tracker.js` (`totalTokens`, `sessionTokens`, `resetSessionTokens`)
- [x] Implementacja kontroli twardego limitu sesji (Hard Budget Cap check) w `src/server.js` przed przekazaniem żądania do kolejki/upstream
- [x] Zwracanie natychmiastowej odpowiedzi błędu 429/402 z czytelnym komunikatem o wyczerpaniu budżetu sesji

### Faza 3: Testy i weryfikacja
- [x] Napisanie kompleksowych testów jednostkowych i integracyjnych w `test/hard-session-budget.test.js`
- [x] Weryfikacja kryterium Done: testowe zapytanie po przekroczeniu limitu 100k tokenów zostaje natychmiast zablokowane kodem 429/402 bez obciążania upstreamu
- [x] Uruchomienie pełnego zestawu testów `npm test` w repozytorium (wszystkie 115 testów / 225 przypadków zakończone sukcesem)

---

## 2. Bieżący Krok (Next Action)
- [x] Wdrożenie zakończone, testy przeszły pomyślnie. Gotowe do zgłoszenia do review / zamknięcia zadania kanban.

---

## 3. Decyzje projektowe i założenia
- **Decyzja 1:** Śledzenie sumarycznych tokenów w `session-tracker.js` w oparciu o unikalny `sessionId` (pochodzący z nagłówków `x-claude-code-session-id`, `x-session-id`, `session-id`).
- **Decyzja 2:** Sprawdzanie limitu w `createProxyRequestListener` zaraz po ekstrakcji `sessionId` – przed buforowaniem ciała żądania i przed wyborem konta upstream, co oszczędza zasoby i zapobiega niepotrzebnemu obciążaniu upstreamu.
- **Decyzja 3:** Zwracanie kodu 429 (lub 402 w zależności od polityki, standardowo 429 Too Many Requests z błędem typu `rate_limit_error` / `budget_exceeded`), informującego klienta Claude Code / Codex o przekroczeniu budżetu tokenów w danej sesji.
