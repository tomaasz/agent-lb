# Ustalenia, Błędy i Notatki Badawcze: Automatyczny reset limitów Codex CLI (R205)

> Plik gromadzi odkrycia architektoniczne, napotkane błędy, rozwiązania oraz ograniczenia środowiska. Zapobiega powtarzaniu tych samych pomyłek i utracie kontekstu w długich sesjach vibe codingu.

---

## 1. Odkrycia architektoniczne i struktura kodu
- **Struktura limitów Codex CLI:** Nagłówki `x-codex-*` oraz endpoint `/backend-api/wham/usage` zwracają utylizację w oknach 5-godzinnym (primary) i 7-dniowym (secondary). Wyczerpanie okna 5h (100% utylizacji) skutkuje kodem 429 `usage_limit_reached`.
- **Procedura resetu RateLimitResetCredit:** Endpoint `/backend-api/wham/rate-limit-reset-credits` zwraca listę dostępnych kredytów resetu, a `POST /backend-api/wham/rate-limit-reset-credits/consume` natychmiast zeruje okno limitu 5h w OpenAI. Funkcja `consumeCodexResetCredit` w `src/codex-auth.js` wykonuje ten proces.
- **Stan obecny:** Ręczne wywoływanie resetu istniało w dashboardzie (`/accounts/consume-reset-credit`). Brakowało automatycznego wyzwalacza przy stanie <10% limitu (>=90% utylizacji) oraz ochrony przed pętlami błędów.

---

## 2. Dziennik problemów i rozwiązań (Troubleshooting Log)

### Problem: Potencjalne pętle wielokrotnego resetu przy powtarzających się błędach API
- **Przyczyna:** Jeżeli zapytanie do endpointu resetu zwróci 401, 403 lub błąd sieci, a headroom konta nadal jest <10%, kolejne zapytania proxy mogłyby w nieskończoność ponawiać próby konsumpcji kredytu.
- **Rozwiązanie / Obejście:** Wprowadzenie stanu cooldownu na poziomie konta (`_resetCooldownUntil`), licznika kolejnych awarii (`_resetFailures`), blokady współbieżności (`_resetInProgress`) oraz wykładniczego/dłuższego backoffu (15 min po 3 niepowodzeniach, 5 min przy braku kredytów).

### Problem: Re-entrancy przy odświeżaniu kwoty po resecie
- **Przyczyna:** Funkcja `consumeResetCredit` po udanej konsumpcji wywołuje `fetchCodexUsage` i `applyCodexUsageData`. Jeśli `applyCodexUsageData` sprawdza próg, mogłaby ponownie wywołać reset zanim zaktualizowana kwota zostanie przypisana.
- **Rozwiązanie / Obejście:** Flaga `_resetInProgress` pozostaje aktywna przez cały czas trwania procedury, a po sukcesie włączany jest 30-sekundowy cooldown ochronny.

---

## 3. Ograniczenia i specyfika środowiska
- Pula kont produkcyjnych Codex w środowisku może zawierać tylko jedno aktywne konto OAuth (`tomaasz@gmail.com`). Automatyczny reset musi zapobiec sytuacji, w której jedyne konto zostaje zablokowane kodem 429 bez próby odnowienia.
- Bezpieczeństwo poświadczeń: W logach i audycie nigdy nie wolno ujawniać tokenów Bearer ani nagłówków autoryzacyjnych. Logowane są tylko nazwy kont, poziomy utylizacji, ID kredytów i kody statusu.
