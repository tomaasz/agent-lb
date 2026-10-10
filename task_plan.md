# Plan Zadania: [Rec] Wdrożenie narzędzia ttok 1.0 do bezpiecznego przycinania logów w agent-lb

> **Cel:** Zabezpieczenie przed marnowaniem limitów tokenów i przepełnianiem kontekstu asystenta poprzez wdrożenie narzędzia ttok 1.0 do precyzyjnego przycinania i zliczania tokenów w logach testowych agent-lb.
> **Status:** Zakończone
> **Ostatnia aktualizacja:** 2026-10-10 11:29

---

## 1. Fazy i Zadania

### Faza 1: Rozpoznanie i weryfikacja środowiska
- [x] Sprawdzenie dostępności narzędzia `ttok` w środowisku (`ttok --version`, `/home/tomaasz/.local/bin/ttok`)
- [x] Weryfikacja działania na testowym pliku i wejściu standardowym stdin
- [x] Potwierdzenie kryteriów Done: polecenie ttok zwraca poprawną liczbę jednostek i kod wyjścia 0

### Faza 2: Integracja z projektem agent-lb
- [x] Dodanie skryptu `test:trimmed` do `package.json` (`node --test ... 2>&1 | (ttok -t 4000 2>/dev/null || cat)`)
- [x] Stworzenie zestawu testów `test/ttok-log-trim.test.js` weryfikującego zliczanie i obcinanie logów
- [x] Aktualizacja `PROJECT_CONTEXT.md` z zachowaniem budżetu tokenów (ccaudit < 1500)

### Faza 3: Testy i weryfikacja
- [x] Uruchomienie `npm run lint` (0 błędów, 0 ostrzeżeń)
- [x] Uruchomienie dedykowanego testu `node --test test/ttok-log-trim.test.js` (4/4 testów PASS)
- [x] Uruchomienie `npm run audit:tokens` (1457 tokenów / próg 1500 PASS)
- [x] Wykonanie commitu i push na `origin/main`

---

## 2. Bieżący Krok (Next Action)
- [x] Wszystkie kroki zrealizowane pomyślnie. Zadanie gotowe do zamknięcia w kanbanie.

---

## 3. Decyzje projektowe i założenia
- **Decyzja 1:** Narzędzie `ttok 1.0` jest zainstalowane w `~/.local/bin/ttok` (przez `uv tool`). W testach oraz skryptach npm zaimplementowano bezpieczne sprawdzanie obecności (`which ttok` / fallback), zapobiegające awariom w środowiskach CI pozbawionych Pythona/ttok.
- **Decyzja 2:** Zaimplementowano skrypt `npm run test:trimmed` z bezpiecznym limitem 4000 tokenów, co drastycznie ogranicza narzut tokenowy z 64k znaków raportu testowego podczas sesji agentowych.
