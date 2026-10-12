# Plan Zadania: [R205] Automatyczny reset limitów Codex CLI w agent-lb (t_d2bf030b)

> **Cel:** Dodanie do komponentu agent-lb modularnej obsługi automatycznego wywoływania resetu limitów zapytań Codex CLI przy niskim stanie konta (<10% limitu / >=90% utylizacji), z zabezpieczeniem przed pętlami, obsługą błędów, konfigurowalnym feature flagiem i pełnym zestawem testów jednostkowych.
> **Status:** Zakończone
> **Ostatnia aktualizacja:** 2026-10-12 22:54

---

## 1. Fazy i Zadania

### Faza 1: Rozpoznanie i architektura
- [x] Analiza istniejącego kodu i endpointów OpenAI WHAM (codex-auth.js, account-manager.js, server.js)
- [x] Weryfikacja ustaleń z zadania badawczego t_e41e3929 (1 konto tomaasz@gmail.com, 2 kredyty dostępne, próg <10% headroomu)
- [x] Zaprojektowanie modularnej architektury src/codex-reset.js z zabezpieczeniem współbieżności i pętli błędów

### Faza 2: Implementacja
- [x] Krok 1: Utworzenie src/codex-reset.js z logiką sprawdzania progów, loop prevention, backoff cooldown i audytem zdarzeń
- [x] Krok 2: Usprawnienie src/codex-auth.js (consumeCodexResetCredit zwracające identyfikator zużytego kredytu)
- [x] Krok 3: Integracja z src/account-manager.js (wyzwalanie po aktualizacji kwot i sondach, reporting w getStatus())
- [x] Krok 4: Integracja z src/server.js (reakcja na 429 quota exhaustion) oraz src/config.js i src/index.js (feature flag autoResetCredits / codexReset)

### Faza 3: Testy i weryfikacja
- [x] Krok 1: Implementacja kompleksowych testów jednostkowych test/codex-auto-reset.test.js (warunki progowe <10%, obsługa błędów, cooldown, zapobieganie pętlom, wyłącznik feature flag)
- [x] Krok 2: Weryfikacja regresji istniejących testów (npm test test/codex-support.test.js i inne)
- [x] Krok 3: Sprawdzenie lintera (npm run lint) i audytu tokenów (npm run audit:tokens)
- [x] Krok 4: Aktualizacja findings.md i dokumentacji

---

## 2. Bieżący Krok (Next Action)
- [x] Wszystkie kroki zrealizowane pomyślnie. Zadanie gotowe do handoffu / review.

---

## 3. Decyzje projektowe i założenia
- **Decyzja 1 (Modularność):** Cała logika decyzyjna progu, ochrony przed pętlami, licznika awarii i logowania audytowego jest wydzielona do src/codex-reset.js. AccountManager deleguje do tego modułu.
- **Decyzja 2 (Warunek progowy <10%):** Próg wyzwala się, gdy utylizacja okna 5h (lub 7d) wynosi >= 0.90 (czyli pozostały headroom < 10%) lub gdy konto ma status exhausted. Domyślna wartość to 0.90, konfigurowalna przez codexReset.threshold lub env AGENTLB_AUTO_RESET_THRESHOLD.
- **Decyzja 3 (Ochrona przed pętlami):** Flaga _resetInProgress blokuje równoległe wywołania. Na wypadek błędu API włączany jest cooldown (60s dla pojedynczego błędu, 15 min po 3 kolejnych awariach, 5 min przy braku kredytów). Po udanym resecie obowiązuje 30-sekundowy cooldown ochronny.
- **Decyzja 4 (Feature flag / rollback):** Opcja autoResetCredits: false lub codexReset: { enabled: false } natychmiast wyłącza mechanizm bez wpływu na ręczne wywoływanie przez dashboard.
