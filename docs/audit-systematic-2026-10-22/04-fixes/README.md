# Powiązanie poprawek

Baza `509ddf1`, wspólna gałąź `ai/systematic-audit-2026-10-22`. Osobne commity relay, streaming quota, JSON quota, Unicode, zależności i obrazu. Pięć powiązanych zmian instalatorów połączono w jeden commit, bo dotyczą tych samych funkcji i wspólnego zestawu testów; nie tworzono osobnego PR per finding.

| Finding | Commit |
|---|---|
| BUG-001 | `5cb0116` |
| BUG-002 | `2adee31` |
| BUG-003 | `4493ca1` |
| BUG-004 | `36a3931` |
| BUG-005 | `8b70bb6` |
| BUG-006 | `dd434ed` |
| BUG-007 | `dd434ed` |
| BUG-008 | `dd434ed` |
| BUG-009 | `dd434ed` |
| BUG-010 | `5ad665f` |
| BUG-011 | `dd434ed` |

CI: `b968f3f`. `verified.patch` zawiera końcowe zmiany istniejących plików względem bazy; nowe testy są w commitach. `setup-fixes.patch` to wersja przedstawiona do osobnej zgody użytkownika, nie końcowy diff. Zgoda udzielona w tej sesji: „Tak, zastosuj poprawki instalatorów”.
