# Kolejne kroki i mierniki

1. **P1:** zwiększyć pokrycie krytycznych modułów do 80% linii/70% gałęzi (obecnie m.in. OAuth/MITM poniżej). Najpierw lokalne testy odmowy uprawnień, odświeżania OAuth, rozłączeń i błędów zapisów. Nie obniżać progu, by uzyskać zielony wynik.
2. **P1:** osobny zatwierdzony etap browser E2E, SMTP i rzeczywistego inference na koncie testowym; nie deklarować go na podstawie atrap.
3. **P2:** przypiąć Actions i obraz bazowy do pełnych SHA/digestów z kontrolowaną aktualizacją; monitorować przyszłe advisory także po tym czystym skanie.
4. **P2:** ustalić SLO, budżet błędów, retencję logów i obowiązki GDPR; wykonać restore drill prywatnego backupu. Nie wpisywać promptów/sekretów do telemetryki.
5. **P2:** sesje przeglądarki wyłącznie cookie HttpOnly; zaplanować migrację dotychczasowego ręcznego master key w localStorage z uprzedniego audytu.
6. **P2:** odporność wieloplikowych zapisów instalatora na awarię w połowie (walidacja przed zapisem nie daje transakcji między plikami).
7. **P3:** długa sesja/heap profile i testy canary dopiero po zatwierdzeniu środowiska. Nie wyciągać SLO z mikrobenchmarku translacji.

Aktywne bramki: lint/test w istniejącym CI, nowy npm audit HIGH/CRITICAL, Gitleaks historii, regresyjna reguła Semgrep i skan runtime Trivy. Bramka pokrycia jest planowana: obecny wynik nie spełnia celu, więc nie wprowadzono fikcyjnie zielonego progu. Branch protection/reviews na GitHubie nie były zmieniane. Mierniki: otwarte High/Critical, zaległości pokrycia per moduł, czas naprawy od przyszłego timestampu wykrycia, odsetek udanych restore drills.
