# Podsumowanie audytu AgentLB

Znaleziono i lokalnie zweryfikowano poprawki **11 usterek: 6 High, 5 Medium**. Nie stwierdzono odrębnej Critical osiągalnej przez API; skan starego obrazu wykazywał 1 Critical i 26 High w jego składnikach. Stan po poprawkach: npm audit i Trivy bez wykrytych podatności. Nie oznacza to gwarancji braku nieznanych luk.

Największe ryzyka: ujawnienie sesji/kluczy upstream (BUG-001), obejście limitów przez streaming i JSON (BUG-002/003), wykonanie kodu przez dane instalatora (BUG-006) oraz podatne narzędzia obrazu (BUG-010). Wszystkie naprawiono w gałęzi audytu. Szczegóły i PoC: `06-tecnico.md` oraz `../05-validacion/`.

Testy końcowe: **408 testów, 403 PASS, 0 FAIL, 5 SKIP**. Pokrycie załadowanych źródeł: **79.86% linii, 75.69% gałęzi**. Krytyczne moduły OAuth/MITM/account-manager/codex-auth nadal są poniżej celu. **Pełna Definition of Done nie jest spełniona.** Nie obniżano progów ani nie ukrywano porażek.

Skan Gitleaks: 188 commitów, 10 zweryfikowanych sztucznych wartości testowych; dokładne fingerprinty w allowliście, bez wyłączenia katalogów. Semgrep: 68 reguł/74 pliki, jedno false positive: długość tagu GCM jest już sprawdzana w kodzie. Nowa reguła regresji wykrywa podatny baseline i przepuszcza poprawiony instalator. Checkov: brak failed checks. Dokładne wyniki i zakres: `../05-validacion/validation.json`.

Odsetek naprawionych potwierdzonych usterek: 100%. MTTR nie wyliczano — nie istnieją historyczne timestampy każdego findingu. Zgodność SOC2/ISO27001/GDPR nie została potwierdzona: repo/testy nie stanowią audytu organizacji. Zmapowano kontrolę dostępu, bezpieczne zarządzanie zmianą i ryzyka danych. Retencja/obowiązki/SLO wymagają ustalenia właściciela.

SBOM CycloneDX zawiera graf npm; podpis RSA/SHA256 zweryfikowano, klucz był tymczasowy. To podpis integralności, nie potwierdzenie tożsamości organizacji. Nie uruchamiano testów destrukcyjnych, wdrożenia ani rotacji prawdziwych kluczy. Historia zużycia pominiętego przez dawny kod nie jest odtwarzana; filtr relay nie odwołuje wcześniej ujawnionych poświadczeń. Zastane zmiany użytkownika zachowano.

Dalszy etap: `../07-mejora-continua.md`. Najpierw pokrycie krytycznych ścieżek, potem osobno zatwierdzone testy rzeczywistych integracji. Nie traktować tej partii jako certyfikacji ani kompletnej realizacji wszystkich pozycji szablonu.

Semgrep: początkowy skan miał 9 timeoutów reguł w 4 dużych modułach. Powtórzenie tych 4 plików z limitem 60 s/regułę zakończyło się bez timeoutów i nowych dopasowań (68 reguł). Dowody: `05-validacion/semgrep-retry.*` (ścieżka względem katalogu audytu).

Uwaga o JUnit: stopka zawiera ten sam wynik node:test 408/403/0/5 i czas 67787.700064 ms co log spec. XML ma 406 elementów testcase i 6 skipped (m.in. skipped suite). Hierarchia reporterów nie mapuje się 1:1; obie reprezentacje zachowano bez ręcznej korekty.
