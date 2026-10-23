# Logowanie AGY 1.4.6 — wynik

Wdrożono PR [#6](https://github.com/tomaasz/agent-lb/pull/6), kod `2720e5d`, merge `ba43b73`. Parser obsługuje id_token_email, zachowując zgodność z dawnym id_token. Sprzeczne adresy i dwa różne niepuste sub są odrzucane przed zapisem. Re-login po jednoznacznym adresie zachowuje ID/przypięcie/nazwę i worker home. Nie zmieniano surowego formatu tokenów ani istniejących poświadczeń.

Walidacja: npm test exit0, 417 testów, 412 PASS / 5 SKIP / 0 FAIL. Lint i git diff --check PASS. Niezależny review/verifier PASS; 48/48 testów accounts/hardening. Testy obejmują PTY i pipes start→submit→cleanup, modern↔legacy, brak duplikatów, odrzucanie konfliktów bez zapisu i szyfrowany restart. Kontrole push/PR Node20/22/24/26, image i security PASS.

Produkcja: drain zakończony przy activeRequests0; backup3plików w `~/.local/share/agent-lb/backups/2026-10-23-agy-login` (katalog0700/pliki0600). Dopiero potem main fast-forward i restart systemd. agentlb active/running PID627068, NRestarts0.

Lokalny i publiczny smoke PASS: ready200/true/drainingfalse, anonymous401, dashboard200/CSP ze zgodnym SHA256, models200/62, client-admin403/client-login401, admin-cookie200/logout200. Tożsamości kont i klucze proxy zgodne z backupem.

Ograniczenie: nie wykonano prawdziwego OAuth Google w imieniu użytkownika. Końcowe potwierdzenie wymaga kliknięcia Nowy link i użycia świeżego kodu przez użytkownika; stare zakończone sesje logowania nie są wznawiane. Nie wykonywano inference. Reporter usage ze stacji (setup/agy-setup.sh) nadal zakłada dawny id_token i pozostaje poza zakresem tej poprawki logowania.

Wdrożenie guided według golive: systemd/HTTP sprawdzone przez agenta, nie CLI golive. Wcześniejsze raporty statusów AGY i audytu pozostają aktualne dla swojego zakresu.
