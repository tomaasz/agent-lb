# Logowanie AGY 1.4.6 — plan poprawki

Problem: po wklejeniu kodu parser odrzuca plik bez e-maila w id_token. Zainstalowany CLI1.4.6 zawiera StoredToken.IDTokenEmail (JSON id_token_email,omitempty). Parser rozumiał wyłącznie starszy JWT.

Zakres: obsługa id_token_email, normalizacja i kontrola zgodności obu źródeł. Bez dopisywania sztucznych JWT, bez zmiany formatu zapisywanych tokenów. Re-login po tym samym e-mailu zachowuje ID, przypięcie i worker home, gdy nowy format nie ma sub. Dwa różne niepuste sub są odrzucane przed mutacją. Nie zmieniamy zapisanych produkcyjnych poświadczeń ani setup/*.

Akceptacja: starszy i nowy format przechodzą logowanie przez PTY/pipes; restart magazynu (także encrypted) nie gubi konta; re-login nie tworzy duplikatu; konflikty email/sub odrzucane bez zapisu; błędy nie ujawniają sekretów.

Weryfikacja: testy atrapy CLI dla start→submit→cleanup, parsera, upsert i encrypted restart; pełny npm test, lint, git diff --check, niezależny review/verifier i CI.

Wdrożenie w ramach trwającej naprawy produkcji: PR po CI, drain do0 przed modyfikacją lokalnego main, prywatny backup, aktualizacja main i restart systemd, local/public smoke. Nie wykonywać prawdziwego OAuth w imieniu użytkownika ani inference. Rzeczywistą próbę z nowym linkiem wykona użytkownik po wdrożeniu. Rollback przez revert i restart po drain; stare konta nie wymagają migracji. Weryfikacja guided przez agenta (systemctl/HTTP), nie CLI golive.

Poza zakresem: raportowanie usage ze stacji w setup/agy-setup.sh nadal zakłada dawny id_token; osobna zmiana instalatora. Nie blokuje logowania w panelu.
