# Ustalenia, Błędy i Notatki Badawcze: Wdrożenie ttok 1.0 w agent-lb

> Plik gromadzi odkrycia architektoniczne, napotkane błędy, rozwiązania oraz ograniczenia środowiska.

---

## 1. Odkrycia architektoniczne i struktura kodu
- **ttok CLI:** Narzędzie Simona Willisona oparte o `tiktoken` służące do szybkiego liczenia tokenów (`ttok -i <file>` / `cat <file> | ttok`) oraz przycinania tekstu do zadanego limitu tokenów (`ttok -t <N> -i <file>`).
- **Skrypty testowe agent-lb:** Pełny zestaw testów `npm test` (`node --test`) generuje ponad 63k znaków wyjścia (115 suite'ów / 225 testów). Bez przycinania taki log obciąża kontekst agentów LLM.
- **Obsługa wejścia w ttok:** Argumenty bez flag traktowane są jako prompt (`ttok one two three`). Aby przekazać plik wejściowy, należy użyć flagi `-i <ścieżka>` lub strumienia stdin (`cat <plik> | ttok`).

---

## 2. Dziennik problemów i rozwiązań (Troubleshooting Log)

### Problem: PEP 668 na Debianie Trixie blokuje `pip install ttok`
- **Przyczyna:** Systemowy Python na Debianie (`externally-managed-environment`) uniemożliwia bezpośrednie `pip install` bez flagi `--break-system-packages`.
- **Rozwiązanie:** Narzędzie `ttok 1.0` jest instalowane i zarządzane w izolowanym środowisku przez `uv tool install ttok` w `~/.local/share/uv/tools/ttok/bin/ttok` z dowiązaniem w `~/.local/bin/ttok`.

---

## 3. Ograniczenia i specyfika środowiska
- W środowisku CI (GitHub Actions) runner Node.js może nie posiadać preinstalowanego `ttok`. Z tego powodu test `test/ttok-log-trim.test.js` sprawdza dostępność binarki i pomija testy w środowiskach bez `ttok`, a skrypt `test:trimmed` posiada fallback `|| cat`.
