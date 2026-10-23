# Naprawa statusów AGY — wynik

Wdrożono PR [#5](https://github.com/tomaasz/agent-lb/pull/5), merge `475e5c4`, kod `6d0ba03`. Karty AGY pokazują znane limity modeli i aktywne blokady zdrowia zamiast domyślnego „ZDROWE”. Bez świeżego sukcesu: „Niezweryfikowane”; sukces do 15 minut: „Ostatnio działało”. Wynik Test jest zapisany trwale bez treści błędu i sekretów.

Walidacja: pełny npm test exit0, 411 testów, 406 PASS / 5 SKIP / 0 FAIL; lint exit0 i git diff --check PASS. Niezależny review oraz verifier kodu PASS. Kontrole push i PR: Node20/22/24/26, obraz i security PASS.

Produkcja: po zakończeniu aktywnych żądań (drain0) restart `agentlb.service`, PID502385, active/running, NRestarts0. Pierwsza próba drain zakończyła się bezpiecznym cancel po45s; wydłużona próba doszła do0. Pierwszy smoke wystartował przed otwarciem portu po restarcie; ponowiony smoke PASS. CLI GitHub przy merge/delete automatycznie zaktualizował lokalny main przed drain; restart nastąpił dopiero po drain0.

Backup3plików: `~/.local/share/agent-lb/backups/2026-10-23-agy-status`, katalog0700/pliki0600. Bez zmian kont i kluczy proxy względem backupu.

Lokalny i publiczny `https://agentlb.gotova.pl`: ready200/true/drainingfalse, anonimowy ready401, dashboard200/CSP i identyczny SHA256 `ee4c2536df4959606111c03bdc388a99933b26178b39c88133afbfd8a084d87a`, models200/62, client-admin403/client-login401, admin-cookie200/logout200. Oba serwują agyAccountStatus i nowe etykiety. API AGY:5kont,1z aktywnym limitem modelu,0aktywnych blokad health.

Ograniczenia: nie wysyłano rzeczywistych prób inference do Google; naprawiono prezentację znanego stanu, nie wyczerpany limit Google. Auto-Health nadal obejmuje Claude/Codex; opis informuje o tym wprost. Licznik dostępności w tabeli routingu poza zakresem. Systemd i HTTP zweryfikowane przez agenta, nie przez CLI golive (workflow guided). Poprzedni raport ogólnego wdrożenia pozostaje w GOLIVE-systematic-RESULT.md.
