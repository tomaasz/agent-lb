# Wynik testu bramkującego: narzędzia przez `agybridge serve`

Data: 2026-10-14, host debian-lite, `agy` 1.3.5 (lokalne logowanie), agybridge z `tomaasz/agybridge` (`pip install -e .` w venv w scratchpadzie).

**GATE: PASS**

Powody: przez `agybridge serve` działa pełny obieg narzędzi w formacie OpenAI. W turze 1 strumień zawiera `delta.tool_calls` z `function.name == "get_time"` i `finish_reason: "tool_calls"`. W turze 2 (z `role: "tool"`) model odpowiada tekstem, który używa wyniku narzędzia. Nie trzeba żadnych dodatkowych opcji ani zmiennych środowiskowych. Koszty: ok. 10-11 s na żądanie i ok. 13 tys. tokenów promptu (duży prompt systemowy agybridge), więc kolejne wywołania są wolne i drogie w limitach AGY.

## Polecenia

```bash
python3 -m venv <venv> && <venv>/bin/pip install -e <agybridge-src>
env -u AGENT_LB_URL -u AGENT_LB_API_KEY <venv>/bin/agybridge serve --host 127.0.0.1 --port 18791 --token <token>
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:18791/v1/models          # HTTP 200: gemini-3.8-flash-high, gemini-3.8-flash-low
curl -sN -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d @req1.json http://127.0.0.1:18791/v1/chat/completions
curl -sN -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d @req2.json http://127.0.0.1:18791/v1/chat/completions
```

Start serwera: poniżej 1 s. `req1.json`: `model gemini-3.8-flash-low`, `stream: true`, wiadomość „Która jest godzina? Użyj narzędzia.”, `tools` = jedna funkcja `get_time` bez parametrów.

## Tura 1 - HTTP 200, 11,4 s

Przez ok. 11 s serwer wysyłał tylko komentarze `: keep-alive`, potem jeden chunk (cała odpowiedź naraz, nie token po tokenie):

```
data: {"id": "chatcmpl-...", "object": "chat.completion.chunk", "model": "gemini-3.8-flash-low", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "get_time", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]}
data: {... "choices": [], "usage": {"prompt_tokens": 13090, "completion_tokens": 248, "total_tokens": 13338}}
data: [DONE]
```

## Tura 2 - HTTP 200, 9,8 s

Wiadomości: user, assistant (`tool_calls` get_time `call_1`), `{"role":"tool","tool_call_id":"call_1","content":"14:37"}`; te same `tools`.

```
data: {... "choices": [{"index": 0, "delta": {"content": "Jest godzina 14:37."}, "finish_reason": "stop"}]}
data: {... "usage": {"prompt_tokens": 13138, "completion_tokens": 212, "total_tokens": 13350}}
data: [DONE]
```

## Obserwacje

- Narzędzia są mostkowane w samym agybridge (`core/agybridge/toolcalls.py`): model emituje bloki `<tool_call>...</tool_call>` w tekście, które agybridge ściśle waliduje (nazwy, duplikaty, limity) i zamienia na `delta.tool_calls`. Nie wymaga to opcji ani zmiennych.
- Log serwera: `AGY request done in 11.4s (one-shot; model 3.4s, 13090 prompt tokens)` - tryb one-shot, czyli każde żądanie to osobne uruchomienie `agy` (narzut ok. 7 s poza czasem modelu).
- Brak prawdziwego strumieniowania: odpowiedź przychodzi jednym chunkiem po keep-alive. Klient (agent-lb/Hermes) musi tolerować komentarze SSE i długi czas do pierwszego bajtu.
- Zużyto 2 żądania, bez błędów kwotowych. Serwer zatrzymany; nie było `AGENT_LB_URL`/`AGENT_LB_API_KEY`; nic poza scratchpadem nie zmieniono. W systemie zostaje cudzy proces `agy --hub` (start 22:03, sprzed testu, nie mój).
