# agylb

Nakładka na prawdziwy Antigravity CLI (`agy`). Pobiera konto Google ze wspólnej
puli AgentLB. Wymaga Linux/macOS/WSL, Pythona 3.8+ i zainstalowanego `agy`.

```bash
agylb doctor
agylb models
agylb
agylb --continue
agylb --model gemini-3.8-flash-low
agylb vscode
```

Rozszerzenie **Google Antigravity w VS Code** (Linux / WSL): w terminalu na hoście projektu
uruchom `agylb vscode`. Zostaw terminal otwarty. W tym samym VS Code
(Remote SSH lub WSL, jeśli projekt jest zdalny) wybierz **Plik → Otwórz obszar
roboczy z pliku** i otwórz wypisany plik `agylb.code-workspace`.
Rozszerzenie łączy się z lokalnym serwerem z kontem ze wspólnej puli.
Nie zmienia to globalnych ustawień VS Code ani zwykłego logowania AGY.
Wymagane jest rozszerzenie `google.google-antigravity`; sprawdzono wersję 1.9.0.

Tryb VS Code ma własne trwałe profile i port na projekt. Serwer działa na
loopback, z losowym tokenem ochronnym. Nie udostępniaj jego portu publicznie.
Po wyczerpaniu kwoty serwer zatrzymuje się, zgłasza limit i zachowuje historię.
Uruchom ponownie `agylb vscode`, aby pobrać następne konto; w rozszerzeniu
wybierz **Nowa rozmowa**. Nie przenosi ani nie ponawia poprzedniej rozmowy.
Jeśli masz globalne `ANTIGRAVITY_SERVER_URL`, usuń je ze środowiska VS Code,
ponieważ ma pierwszeństwo przed ustawieniem obszaru roboczego.

Każdy katalog pracy i każde konto mają osobny, **trwały** profil w
`~/.local/share/agylb/workspaces/`. Pracuj zawsze z tego samego katalogu,
jeśli chcesz kontynuować ostatnią rozmowę. Profil jest przypisany do hosta;
historia rozmów nie jest automatycznie przesyłana pomiędzy hostami.
Jednocześnie może działać jedna sesja agylb na katalog pracy.

W zwykłym terminalu, także w Herdr, `agylb` oddaje istniejący terminal
bezpośrednio procesowi `agy`. Dzięki temu system widzi Antigravity jako
aktywny proces; nakładka nadal obserwuje limity i obsługuje zmianę konta.
Uruchom `agylb` w panelu na właściwym hoście. Typ agenta w Herdr to `agy`.
Już uruchomioną sesję trzeba zakończyć i uruchomić ponownie po aktualizacji.

Program uruchamia AGY z osobnym `HOME`. Dzięki temu nie zmienia logowania,
historii ani uprawnień zwykłego `agy` i agybridge. Nowy profil ma własne
ustawienia AGY; ustawienia powłoki i narzędzi odczytywane z `HOME` też
mogą wymagać osobnej konfiguracji. Bieżący katalog pracy i `PATH` pozostają
takie jak w terminalu. Pliki sekretów mają tryb 600, katalog profilu 700.
Klucz AgentLB nie jest przekazywany procesowi AGY ani wypisywany.

Po komunikacie `RESOURCE_EXHAUSTED … quota` program kończy proces AGY,
zgłasza wyczerpany limit do AgentLB i pobiera następne konto. Zachowuje
dotychczasową historię. W terminalu pyta o rozpoczęcie **nowej** rozmowy;
Enter oznacza odmowę. Po zgodzie uruchamia nowe `agy` bez poprzedniego
promptu, flag wznowienia i pozostałych argumentów. Nie powtarza poleceń
ani operacji narzędzi. W trybie bez terminala kończy się kodem 75.
Zwykłe ograniczenie tempa bez komunikatu o wyczerpanej kwocie nie powoduje rotacji.

`--continue` nie przenosi historii na inne konto. Jeśli konto poprzedniej
rozmowy jest wyczerpane lub zostało zmienione w puli, polecenie zatrzymuje
się z informacją; pliki poprzedniej rozmowy pozostają zapisane. `models`
i `doctor` nie usuwają tej blokady. Limity są współdzielone przez hosty,
korzystające z tej samej puli. Obecny interfejs `/agy/quota` oznacza całe
konto jako wyczerpane, nie tylko jeden model.

Konfiguracja w `~/.config/agylb/config.json`:

```json
{"url": "https://agentlb.gotova.pl", "key": "KLUCZ_STACJI"}
```

Plik musi być prywatny (`chmod 600`). Klucz stacji musi mieć w AgentLB
`allowCredentialRelay: true` i nie może mieć ograniczeń modeli, providerów
ani liczby tokenów. Warto użyć osobnego klucza dla każdego hosta.
Nie przesyłaj kluczy przez historię komend. Program korzysta też z istniejącej
konfiguracji agybridge lub agent-lb. Osobny plik `agylb/config.json` ma
pierwszeństwo; następnie sprawdzane są `AGENT_LB_URL` i `AGENT_LB_API_KEY`
w środowisku, a na końcu konfiguracje pozostałych programów.

Instalacja z panelu: wybierz stację z dostępem do puli Google i zaznacz
`agylb` w oknie konfiguracji. Skopiowane polecenie poprosi o klucz bez
zapisywania go w historii terminala. Windows: uruchom je w WSL.
Główny instalator obsługuje opcję `--with-agylb`; samą nakładkę instaluje
`/agylb-setup.sh`. Klucz przekazuj przez `AGENT_LB_API_KEY`.
Instalator sprawdza dostęp do puli przed zapisaniem konfiguracji.

Instalacja po pobraniu repozytorium:

```bash
install -Dm700 clients/agylb.py ~/.local/bin/agylb
agylb doctor
```

Kody zakończenia: 0 — sukces, 1 — błąd konfiguracji/puli, 75 — wyczerpany
limit bez zgody na nową rozmowę. Pozostałe kody pochodzą z AGY lub sygnału.
Logi obejmują maksymalnie 50 ostatnich uruchomień na katalog pracy;
rozmowy nie są automatycznie usuwane.

Testy używają wyłącznie atrap kont i katalogów tymczasowych:

```bash
python3 -B clients/test_agylb.py -v
node --test test/agylb.test.js
```

`install_agylb.py` przyjmuje przez stdin pakiet JSON z kodem i konfiguracją
stacji. Zapisuje je atomowo i zachowuje kopię wcześniejszej wersji.
`rollout_agylb.py KATALOG_KOLEJKI` służy do dokończenia instalacji na
chwilowo niedostępnych hostach. Kolejka zawiera wyłącznie jawnie wybrane
hosty; pakiety z kluczami muszą być przechowywane w prywatnym katalogu
z plikami 600. Każdy sukces jest potwierdzany przez `agylb doctor`, a
pakiet z kluczem jest wtedy usuwany z kolejki. Worker używa Pythona 3.9+.
Prywatna kolejka tego wdrożenia znajduje się na `debian-lite` w
`~/.local/share/agylb/rollout/`. Timer ponawia próbę co 10 minut i wyłącza
się po wykonaniu wszystkich instalacji. Można go zatrzymać poleceniem
`systemctl --user disable --now agylb-rollout.timer`.
