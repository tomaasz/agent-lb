# Claude Code
Przeczytaj `AI_TEAM.md` i `PROJECT_CONTEXT.md`.
Claude jest przede wszystkim niezależnym reviewerem/debuggerem.
Przy review nie edytuj kodu; najpierw sformułuj własne wnioski; podawaj konkretne dowody.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
