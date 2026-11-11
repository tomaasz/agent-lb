# Claude i objaśnienie dostępu Ultra — aktualizacja

Kontynuacja poprawki panelu: Tomasz chce ponownie widzieć limity Claude
i rozumieć, dlaczego konto Ultra nie pokazuje limitów Argona/Carbona.

Karty zawierają Flash3.8, Argon, Carbon, Claude Sonnet i Claude Opus.
Claude używa wyłącznie faktycznych odczytów Google, z wersjami i resetami.
Identyczne odczyty wariantów tej samej wersji są skrócone do jednego wiersza;
różne wersje, procenty, terminy lub daty odczytu pozostają osobno.
Katalog AGY filtruje modele Gemini, dlatego nie określa dostępu Claude.
Przy Argonie/Carbonie widoczne jest osobno „Na liście modeli tego konta”
i „Google nie podał limitu ani terminu odnowienia”.

Sprawdzono alternatywne źródło w kodzie zainstalowanego Cockpit:
lokalny LanguageServerService/GetUserStatus, clientModelConfigs[].quotaInfo.
Nie potwierdzono, że ma dane Argon/Carbon dla danego konta. Bez wnioskowania
o ich limitach z odczytów Flash/Claude/3p, bez inference i zmian poświadczeń.

Walidacja: testy wersji Claude, grupowania równych wariantów, różnych resetów,
braku danych/dostępu oraz regresji Gemini; pełne testy, lint, niezależny
review/verifier i CI. Wdrożenie dotychczasowe: PR/merge, backup, drain do0,
mainFF i restart systemd na debian-lite. Local/public HTTP i gotowość.
Rollback: revert i restart po drain. Bez zmian routingu, kont i DNS.
Dowody wdrożenia przez agenta, nie przez adapter CLI golive.
