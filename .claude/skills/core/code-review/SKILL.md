---
name: code-review
description: Dowodowy review diffu.
---
# code-review

Priorytet: poprawność > bezpieczeństwo > utrata danych > regresje > kompatybilność > utrzymywalność > styl. Następnie oceń samą zmianę: czy jest minimalna wobec wymagania, czy nie wprowadza abstrakcji przed drugim użyciem, czy nazewnictwo i struktura są spójne z sąsiadującym kodem, czy nie zostawia martwego lub zduplikowanego kodu. Każdy finding: Severity, Evidence (plik:linia), Impact, Minimal fix. Działający, ale niepotrzebnie złożony kod to nadal finding.
