# Konfiguracja stacji roboczej pod AgentLB (Claude Code, Codex, jcode, VS Code)

Jesteś agentem AI uruchomionym na stacji roboczej użytkownika. Twoje zadanie: skonfigurować TEN host
tak, by agenci kodujący (Claude Code, OpenAI Codex, jcode) korzystali z proxy **AgentLB**
(`https://agentlb.gotova.pl`) kluczem stacji, a jcode działał wyłącznie w piaskownicy.
Pracuj krok po kroku, każdy krok zweryfikuj, na końcu zdaj raport prostym językiem po polsku.

## Zasady bezwzględne

1. **Klucz stacji jest sekretem.** Jest w zmiennej `AGENT_LB_API_KEY`. Nigdy nie wypisuj jego wartości,
   nie przekazuj go w argumentach poleceń (widać je w `ps`), nie wklejaj do czatu ani do notatek.
   Podawaj go przez zmienną środowiskową albo stdin. Jeśli musisz pokazać plik z konfiguracją,
   maskuj po **wzorcu wartości** (`sed -E 's/tc-[A-Za-z0-9_-]+/tc-<ukryty>/g'`), nie po nazwie pola —
   filtrowanie "po kontekście linii" już raz przepuściło klucz.
   Jeśli `AGENT_LB_API_KEY` jest pusta — zatrzymaj się i poproś użytkownika, by w terminalu wykonał
   `read -rs AGENT_LB_API_KEY && export AGENT_LB_API_KEY` i uruchomił cię ponownie z tego terminala.
2. **jcode tylko w piaskownicy** (`jcode-sandboxed`, bubblewrap). Nigdy nie uruchamiaj binarki jcode
   bezpośrednio: poza piaskownicą widzi cały katalog domowy i wszystkie klucze ze środowiska.
3. Nie zabijaj procesów użytkownika hurtem (`pkill -f jcode` zabiło mu kiedyś otwarte okno TUI i zostawiło
   terminal w trybie śledzenia myszy). Zatrzymuj tylko konkretne PID-y, które sprawdziłeś.
4. Pytaj przed operacjami nieodwracalnymi (usuwanie danych, rotacja kluczy, zmiany w innych agentach).
5. Skrypty z AgentLB (`/setup.sh`, `/jcode-setup.sh`) są zaufane; każdy inny skrypt z internetu najpierw
   pobierz do pliku i przejrzyj.

## Krok 0 — rozpoznanie hosta (tylko odczyt)

Ustal i zanotuj:
- system: `uname -a`, `/etc/os-release`; czy to WSL (`grep -i microsoft /proc/version`) — jeśli tak, host
  Windows to osobna maszyna (patrz Krok 5), a WSL i jego Windows to **ten sam komputer**;
- `sudo -n true` (czy jest sudo bez hasła), `systemctl --user is-system-running`, `command -v crontab`;
- `bwrap --version` i czy działa: `bwrap --unshare-user --ro-bind / / true`;
- **wszystkie** instalacje Claude Code: `bash -ic 'type -a claude'` i `--version` każdej. Przy nvm bywa kilka
  (różne wersje Node), a terminal interaktywny używa innej niż `ssh host claude`;
- czy jest już jcode: `ls -la ~/.local/bin/jcode ~/.jcode 2>/dev/null`, działające procesy
  `pgrep -af jcode-linux` (i czy są w piaskownicy: porównaj `readlink /proc/<pid>/ns/mnt` z `/proc/self/ns/mnt`);
- `~/.vscode-server` (VS Code Remote), `~/.config/agent-lb.env`.

## Krok 1 — klucz i łączność

```bash
[ -n "$AGENT_LB_API_KEY" ] && echo "klucz: ${#AGENT_LB_API_KEY} znaków"
curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: $AGENT_LB_API_KEY" https://agentlb.gotova.pl/v1/models   # oczekiwane 200
```

## Krok 2 — Claude Code i Codex

```bash
curl -fsSL https://agentlb.gotova.pl/setup.sh -o /tmp/alb-setup.sh
bash /tmp/alb-setup.sh --lang pl </dev/null     # klucz bierze z AGENT_LB_API_KEY
rm -f /tmp/alb-setup.sh
```

Co zmienia: `~/.claude/settings.json` (adres proxy + klucz dla Claude Code), ustawienia rozszerzenia
Claude Code w VS Code, dostawcę `codex-lb` w `~/.codex/config.toml` (jako domyślny, jeśli użytkownik nie ma
własnego — wtedy zwykłe `codex` idzie przez AgentLB), profil `~/.codex/codexlb.config.toml` (format Codex ≥ 0.160;
stare `[profiles.codexlb]` w config.toml jest usuwane, bo nowy Codex odrzuca je przy `--profile`) oraz `~/.config/agent-lb.env` wczytywany z `.bashrc` — tylko `AGENT_LB_API_KEY`
i `CODEX_LB_API_KEY`. Skrypt **nie** ustawia już globalnie `OPENAI_*` ani `ANTHROPIC_*` (przekierowywały
na proxy każde narzędzie korzystające z tych SDK), nie zabija procesów Codex i nie instaluje pakietów
systemowych bez `--install-node`. Kopię zapasową każdego pliku robi tylko raz (`<plik>.bak-agent-lb`).

Potem:
- zaktualizuj **każdą** instalację z Kroku 0: dla każdej ścieżki z `type -a claude` uruchom `<ścieżka> update`.
  Stare wersje (< 2.1.280) rozwiązują skrót `opus` na starszego Opusa 5 i nie znają `claude-opus-5-5` —
  wtedy rozszerzenie VS Code pokazuje „Opus 5.5”, a naprawdę działa stary model;
- weryfikacja (w powłoce interaktywnej, żeby wczytać `agent-lb.env`):
  `bash -ic 'claude -p --model "opus[1m]" --output-format json "Reply: ok"'` → w `modelUsage` ma być
  `claude-opus-5-5[1m]`;
- automatyczne aktualizacje (Claude Code ma często `autoUpdates: false`): dodaj do crona linię z markerem
  `# claude-update (zarzadzane)`, np. `37 4 * * * PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin timeout 600 claude update >> $HOME/.claude/update-cron.log 2>&1  # claude-update (zarzadzane)`;
  przy kilku instalacjach nvm — pętla po wszystkich ścieżkach.

## Krok 3 — jcode w piaskownicy

```bash
curl -fsSL https://agentlb.gotova.pl/jcode-setup.sh -o /tmp/jcode-setup.sh
bash /tmp/jcode-setup.sh            # klucz z AGENT_LB_API_KEY; instaluje, weryfikuje, drukuje wynik
rm -f /tmp/jcode-setup.sh
```

Skrypt: instaluje jcode bez telemetrii, tworzy `~/bin/jcode-sandboxed`, przepina `~/.local/bin/jcode`
na piaskownicę (strażnik systemd + `.bashrc` przywraca to po każdej aktualizacji), dodaje nocny cron
`jcode-update --auto`, profil dostawcy `agentlb` i pomija ekran powitalny. Sprawdź wynik sam:
- `readlink ~/.local/bin/jcode` → `~/bin/jcode-sandboxed`;
- `jcode telemetry status` z katalogu projektu → `disabled`;
- w katalogu projektu: `jcode --shell -- -c 'git status; ls -A ~; env | grep -ci key'`
  → „not a git repository”, w home tylko `.jcode`, `0`;
- pliki z sekretami w projekcie (`.env`, `.env.*`, `.envrc`; bez `.env.example` itp.) są w piaskownicy
  puste: jeśli projekt ma `.env`, to `jcode --shell -- -c 'wc -c .env'` → `0 .env`;
- jeśli wcześniej działał serwer jcode **poza** piaskownicą — zatrzymaj go (tylko ten PID). Klient jcode
  łączy się z już działającym serwerem, więc taki serwer „przejmuje” nowe sesje i używa kluczy hosta
  (objaw: w nagłówku `api-key:openai` zamiast `agentlb`, błędy 404 / `anyOf`).

## Krok 4 — VS Code

- Projekty otwiera się przez Remote-SSH lub rozszerzenie WSL, zawsze **folder projektu**, nie cały home.
  jcode odmawia startu w katalogu domowym; rozszerzenie „Claude Code Chat” (Andre Pimenta) przed każdą
  wiadomością robi kopię git całego otwartego folderu — na dużym folderze wisi w „Processing”
  i kopiuje pliki `.env` z kluczami.
- jcode: nowy terminal w VS Code (w folderze projektu) → `jcode`. Terminale otwarte **przed** instalacją
  mogą mieć stare PATH — otwórz nowy. Na pasku jcode musi być `agentlb`.
- Napis „Log in to get started (type /login)” w jcode to znany błąd ekranu startowego — nie loguj się,
  po prostu pisz zadanie.
- Jeśli terminal wypisuje ciągi liczb typu `35;40;24M` — to kody myszy po zabitym TUI: wpisz `reset`.

## Krok 5 — host Windows (jeśli pracujesz też natywnie na Windowsie)

Na Windowsie nie ma bubblewrap, więc natywny `jcode.exe` **nie może** być używany. `jcode` w PowerShell/cmd
ma przekazywać pracę do piaskownicy w WSL:
1. Skonfiguruj WSL tego komputera krokami 1–3 (to ten sam komputer).
2. Jeśli istnieje `%LOCALAPPDATA%\jcode\bin\jcode.exe` (instalator Windows): wyłącz telemetrię
   (`jcode.exe telemetry disable`, plik `%USERPROFILE%\.jcode\no_telemetry`), zmień nazwę na
   `jcode.exe.disabled`.
3. Utwórz `%LOCALAPPDATA%\jcode\bin\jcode.cmd` (instalator Windows dopisuje ten katalog na początek PATH,
   a `.EXE` wygrywa z `.CMD` — dlatego w tym samym katalogu i bez `.exe`):
   ```bat
   @echo off
   setlocal
   if /I "%CD%"=="%USERPROFILE%" goto :refuse
   if "%CD:~3%"=="" goto :refuse
   wsl.exe -d <DYSTRYBUCJA> --cd "%CD%" -- /home/<UŻYTKOWNIK_WSL>/bin/jcode-sandboxed %*
   exit /b %ERRORLEVEL%
   :refuse
   echo Blad: przejdz do folderu projektu. 1>&2
   exit /b 2
   ```
4. Strażnik: zadanie Harmonogramu (przy logowaniu + codziennie), które ponownie zmienia nazwę `jcode.exe`,
   gdyby instalator go odtworzył. Ustaw też zmienne użytkownika `JCODE_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`.
5. Test z `cmd` w folderze projektu na C:: `jcode --version`, a w `%USERPROFILE%` — odmowa.
   Projekty z C: działają w WSL wolniej (`/mnt/c`); lepiej trzymać je w systemie plików WSL.

## Krok 6 — raport dla użytkownika

Krótko, prostym językiem (bez nazw plików tam, gdzie nie są potrzebne): co zainstalowano i skonfigurowano,
co zweryfikowano (i jak), co się nie udało i dlaczego, co użytkownik musi zrobić sam
(np. przeładować okno VS Code, otworzyć nowy terminal). Nie cytuj żadnych kluczy.
