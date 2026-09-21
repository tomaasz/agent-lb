# ⚖️ agent-lb

> **Universal Multi-Account Load Balancer, Quota Rotator & Modern Web Dashboard for Claude Code & OpenAI Codex CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](docker/Dockerfile)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

`agent-lb` acts as an intelligent proxy between your coding tools ([Claude Code](https://claude.ai/claude-code), [VS Code Claude Extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code), OpenAI Codex CLI, Cursor, Roo Code) and upstream providers (Anthropic, OpenAI). It pools multiple Claude (Max, Pro, Team, API-key) and OpenAI Codex accounts and automatically rotates traffic when limits are approached — preventing interruptions and 429 quota exhaustion.

---

## 🌟 Key Features

- **⚡ Multi-Account Pooling & Adaptive Rotation**: Pools multiple Anthropic & OpenAI Codex accounts and rotates before hitting 5-hour session or 7-day weekly rate limits (customizable threshold, default 98%).
- **🧠 OpenAI Codex & Anthropic Claude Dual Support**: Full proxy support for both Anthropic Claude (`/v1/messages`) and OpenAI Codex / ChatGPT (`/backend-api/codex`, `/backend-api/wham`, `/v1/responses`, `/v1/chat/completions`), with seamless OAuth PKCE and API key management.
- **⚖️ Max-Min Fair-Share Stream Admission**: Prevents interactive coding sessions from being starved by concurrent batch workloads or background autonomous agents (e.g. Hermes) by dynamically throttling aggressive consumers.
- **⏰ Smart Keep-Warm & Working Hours Planner**: Keeps sessions responsive before the workday begins, while automatically standing down on nights and weekends to conserve precious 5-hour and 7-day quota limits.
- **🛡️ Tool Call Deduplication & Replay Safety**: Tracks non-idempotent side-effect tool calls (file edits, bash execution) with deterministic fingerprinting, preventing duplicate executions during network hiccups and client retries.
- **📊 Real-time Web Dashboard**: Responsive web UI (`/dashboard`) monitoring account status, prepaid balances, active connections, token usage, provider badges, and client keys with live WebSocket & SSE updates.
- **🔄 In-Dashboard 1-Click OAuth Re-login**: Re-authenticate expired Anthropic or OpenAI Codex accounts directly through the web UI using OAuth flows without touching the server CLI.
- **🛠️ Zero-Config Client Connectors**: Instant 1-line setup scripts for Linux, macOS, WSL, and Windows PowerShell that configure Claude Code CLI, Codex CLI, and VS Code, handling OAuth credential backups and conflict prevention automatically.
- **👥 Multi-Tenant Client Keys**: Generate independent access keys (`tc-...`) with per-key token metrics, provider access controls (`allowedProviders`), rate limits, and permission scopes for team members.
- **🪶 Zero External Dependencies**: 100% pure Node.js built-ins (`http`, `https`, `crypto`, `net`). Extremely lightweight, starts in milliseconds.
- **🔒 Secure by Default**: Automatic loopback and Tailscale Tailnet bypass, constant-time API key comparisons, strict Content Security Policy (CSP), and zero secrets in git.
- **🐳 Docker & systemd Ready**: Out-of-the-box Docker container and native systemd service integration.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Clients["Developer Workstations & Agents"]
        C1["Claude Code CLI (Linux/macOS)"]
        C2["VS Code Extension (Windows)"]
        C3["OpenAI Codex CLI"]
        C4["Batch / Background Agents (Hermes)"]
    end

    subgraph Proxy["AgentLB Proxy & Dashboard (Port 3456)"]
        Gate["API Key & Tailscale Gate"]
        FairShare["Max-Min Fair Share Admission"]
        Dedupe["Tool Call Dedupe & Replay Guard"]
        Router["Smart Quota Rotator"]
        Warmer["Working Hours Keep-Warm Planner"]
        Dash["Web Dashboard & Admin API"]
        Gate --> FairShare
        FairShare --> Dedupe
        Dedupe --> Router
        Warmer -.->|Pre-warm| Router
        Gate --> Dash
    end

    subgraph Upstream["Upstream Providers"]
        A1["Account 1 (Claude Max - Active)"]
        A2["Account 2 (Claude Pro - Standby)"]
        A3["Account 3 (Prepaid API Key)"]
        A4["Account 4 (OpenAI Codex OAuth / API Key)"]
    end

    C1 -->|ANTHROPIC_BASE_URL| Gate
    C2 -->|Proxy URL| Gate
    C3 -->|CODEX_BASE_URL| Gate
    C4 -->|x-api-key / Bearer| Gate
    Router -->|Live Token Injection| A1
    Router -.->|Failover on Quota| A2
    Router -.->|Fallback| A3
    Router -.->|Codex Traffic| A4
```

---

## 🚀 Quick Start (Server Setup)

### Option 1: Quick Run with Git (Recommended)

Requires **Node.js 20+**:

```bash
git clone https://github.com/tomaasz/agent-lb.git
cd agent-lb

# Start interactive TUI server
npm start

# Or run headless daemon (recommended for servers)
node src/index.js headless
```

On first startup, `agent-lb` generates a primary admin API key and prints the dashboard URL:

```text
Agent-LB proxy listening on 0.0.0.0:3456
Web Dashboard: http://localhost:3456/dashboard
Admin Key: tc-adm_xxxxxxxxxxxxxxxx
```

### Option 2: Docker & Docker Compose

```bash
git clone https://github.com/tomaasz/agent-lb.git
cd agent-lb/docker

# Start container in background
docker compose up -d
```

Your configuration and accounts will persist in `docker/data/agent-lb.json`.

### Option 3: Systemd Service (Linux)

Install as a background systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cat << 'EOF' > ~/.config/systemd/user/agentlb.service
[Unit]
Description=AgentLB Multi-Account Proxy Service
Documentation=https://github.com/tomaasz/agent-lb
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/agent-lb
ExecStart=/usr/bin/node %h/agent-lb/src/index.js headless
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agentlb
```

---

## 💻 Client Setup (Connecting Developers)

Connecting developer workstations takes a single command. The server dynamically bakes its address into the installer script and offers a **unified all-in-one installer** supporting both **Claude Code CLI** and **OpenAI Codex CLI** (alongside their official VS Code extensions):

### All-in-One Setup (Claude Code + OpenAI Codex + VS Code)

#### Linux / macOS / WSL:

```bash
# Interactive (prompts for client key):
curl -fsSL http://your-server:3456/setup.sh | bash

# Non-interactive with station key:
curl -fsSL http://your-server:3456/setup.sh | bash -s -- --key tc-YOUR_STATION_KEY
```

#### Windows (PowerShell):

```powershell
# Interactive (prompts for client key):
& ([scriptblock]::Create((irm http://your-server:3456/setup.ps1)))

# Non-interactive with station key:
& ([scriptblock]::Create((irm http://your-server:3456/setup.ps1))) -Key tc-YOUR_STATION_KEY
```

> **WSL Detection on Windows**: When run under Windows PowerShell, `setup.ps1` automatically detects any installed WSL distributions (e.g., Debian, Ubuntu) and prints the exact command to configure your WSL environment as well.

#### Installer Options & Flags:

- `--key <KEY>` / `-Key <KEY>`: Provide the client workstation key directly.
- `--url <URL>` / `-Url <URL>`: Override the proxy server URL (e.g. `https://agentlb.yourdomain.com`).
- `--test` / `-Test`: Run diagnostic connection and authentication tests without altering settings.
- `--no-install`: Skip automatic installation/upgrade of npm packages (`@anthropic-ai/claude-code`, `@openai/codex`).
- `--uninstall` / `-Uninstall`: Remove proxy environment configurations and restore backed-up config files.

---

### What the client installers do automatically:

1. **Environment check & auto-installation**: Verifies Node.js & npm; automatically installs `@anthropic-ai/claude-code` and `@openai/codex` CLI globally if missing.
2. **Auth verification**: Verifies connection and key validity live against the server (`/v1/models` and `/backend-api/codex/models`).
3. **Clean configuration & OAuth conflict prevention**: Backs up existing configs (`.bak`) and prevents OAuth _"Auth conflict"_ errors.
4. **Tool configuration**: Configures `~/.claude/settings.json` (Claude Code) and `~/.codex/config.json` / `config.toml` (OpenAI Codex CLI 0.14+).
5. **VS Code extensions**: Configures official VS Code extensions for both Claude Code and OpenAI Codex.
6. **Persistence**: Saves proxy settings to shell profiles (`~/.bashrc`, `~/.zshrc`, `~/.config/agent-lb.env`) or the Windows User Registry. When `~/.claude/.credentials.json` contains a Claude OAuth session, the installer keeps Claude Code in subscription mode by removing conflicting `ANTHROPIC_API_KEY` and injecting `ANTHROPIC_CUSTOM_HEADERS=x-api-key: <proxy-key>`. The load balancer consumes this header and transparently attaches upstream account credentials.

The proxy does not set a Claude token or context-window value. It forwards `max_tokens`, messages, cache controls, and compaction requests unchanged. `proxy.maxBodyBytes` is only a memory-safety cap on the serialized HTTP body (64 MiB by default, `0` for an explicit unlimited setting); it is not a token limit. Increase it for unusually large multimodal payloads, for example:

```json
{
  "proxy": { "maxBodyBytes": 268435456 }
}
```

---

## 🖥️ Web Dashboard

Access the interactive dashboard at:

```text
http://your-server:3456/dashboard
```

### Dashboard Features:

- **Accounts Overview**: Real-time status badges (`active`, `idle`, `rate-limited`, `error`, `needs-relogin`), provider indicator (`Anthropic` / `OpenAI Codex`), 5h session and 7d weekly quota gauges, and prepaid account balances ($ / credits).
- **1-Click OAuth Login & Re-login**: Add new Anthropic or OpenAI Codex accounts or refresh expired sessions directly from your browser.
- **Client Access Keys**: Create, copy, rotate, and revoke client API keys (`tc-...`) with usage stats (requests, tokens) and granular provider restrictions (`allowedProviders: ["anthropic", "codex"]`).
- **Client Connect Wizard**: Copy pre-filled setup commands for Linux, macOS, Windows, VS Code, and Codex CLI.
- **Manual Overrides**: Toggle accounts on/off, adjust priority levels, or manually switch active accounts.

---

## 🛡️ Reverse Proxy & Tailscale

`AgentLB` supports reverse proxies and **Tailscale**. Keep `proxy.trustLoopback` and `proxy.trustTailnet` false behind a reverse proxy. Every client must send its own key; management endpoints require the administrator key. See [security and deployment notes](docs/audit-hardening.md).

### Tailscale Tailnet Authentication

Tailnet address exemptions are disabled by default. An explicit `proxy.trustTailnet: true` only admits direct Tailnet peers for inference; it never grants administrator access and never trusts forwarded identity headers. Configure allowed hostnames via environment variable:

```bash
export AGENT_LB_HOST="agentlb.your-tailnet.ts.net"
```

### Caddy Configuration Example

```caddy
claude.your-domain.com {
    reverse_proxy localhost:3456 {
        header_up -X-From-Tailnet
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Nginx Configuration Example

```nginx
server {
    listen 443 ssl http2;
    server_name claude.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-From-Tailnet "";
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## ⚙️ Configuration Reference

Configuration is stored in `~/.config/agent-lb.json` (or `~/.config/claude-lb.json`).

```json
{
  "proxy": {
    "port": 3456,
    "host": "0.0.0.0",
    "apiKey": "tc-adm_your_admin_secret",
    "clientKeys": [
      {
        "name": "developer-alice",
        "key": "tc-alice_key_xxxx",
        "allowedProviders": ["anthropic", "codex"]
      },
      {
        "name": "hermes-agent",
        "key": "tc-agent_key_yyyy",
        "allowedProviders": ["anthropic"]
      }
    ],
    "allowedHosts": ["localhost", "127.0.0.1", "claude.your-domain.com"],
    "switchThreshold": 98,
    "holdSeconds": 0,
    "fairShare": {
      "enabled": true,
      "totalSlots": 8,
      "minGuaranteed": 1
    },
    "workingHours": {
      "enabled": true,
      "days": [1, 2, 3, 4, 5],
      "startHour": 8,
      "endHour": 19,
      "timezone": "UTC",
      "prewarmMinutes": 15
    },
    "toolDedupe": {
      "enabled": true,
      "ttlMs": 300000
    }
  },
  "accounts": [
    {
      "name": "primary-claude-max",
      "provider": "anthropic",
      "type": "oauth",
      "priority": 1,
      "accountUuid": "...",
      "token": { "access_token": "..." }
    },
    {
      "name": "team-codex-oauth",
      "provider": "codex",
      "type": "oauth",
      "priority": 1,
      "chatgpt_account_id": "...",
      "token": { "access_token": "..." }
    },
    {
      "name": "backup-openai-api",
      "provider": "codex",
      "type": "api_key",
      "priority": 2,
      "apiKey": "sk-proj-..."
    }
  ]
}
```

### Advanced Settings:

- **`fairShare`**: Dynamic max-min fair allocation of concurrent streaming slots across active client keys. Guarantees that interactive developers never get starved by background autonomous agents (like Hermes or AutoGPT).
- **`workingHours`**: Keep-warm scheduler that warms up sessions 15 minutes before developers start their workday, while automatically sleeping on nights and weekends to prevent wasting 5-hour and weekly quota caps.
- **`toolDedupe`**: Safe idempotency filter for non-idempotent tool calls (e.g. bash commands, file writes, git operations). Detects duplicate calls from network disconnects within TTL window.

### Environment Variables

| Variable                                  | Description                        | Default                   |
| ----------------------------------------- | ---------------------------------- | ------------------------- |
| `AGENT_LB_PORT` (or `CLAUDE_LB_PORT`)     | Port to bind proxy server          | `3456`                    |
| `AGENT_LB_HOST` (or `CLAUDE_LB_HOST`)     | Host address or domain allowed     | `0.0.0.0`                 |
| `AGENT_LB_CONFIG` (or `CLAUDE_LB_CONFIG`) | Custom path to config file         | `~/.config/agent-lb.json` |
| `AGENT_LB_URL` (or `CLAUDE_LB_URL`)       | Base URL used by installer scripts | Dynamic detection         |

---

## 💡 Inspiration & Origins (Geneza Projektu)

Projekt **AgentLB** powstał jako zaawansowana ewolucja i rozbudowa koncepcji projektu `claude-lb` autorstwa [KarpelesLab](https://github.com/KarpelesLab/agentlb) (stworzonego pierwotnie do pulowania kont wyłącznie dla narzędzia Claude Code).

Z biegiem rozwoju projekt został przekształcony w uniwersalną bramę **AgentLB** (`agentlb` / `agent-lb`) obsługującą pełne środowisko programistów i autonomicznych agentów kodujących:

- **Wielomodelowość i wielu dostawców**: Równorzędna obsługa Anthropic Claude oraz OpenAI Codex CLI / ChatGPT (OAuth PKCE i klucze API).
- **Sprawiedliwy podział strumieni (Max-Min Fair Share)**: Ochrona interaktywnych sesji programistów przed zagłodzeniem przez intensywne procesy autonomiczne w tle (np. Hermes, AutoGPT).
- **Inteligentny harmonogram Keep-Warm**: Podtrzymywanie gotowości sesji w godzinach pracy i automatyczne oszczędzanie limitów nocami oraz w weekendy.
- **Bezpieczeństwo i deduplikacja narzędzi**: Zabezpieczenie przed wielokrotnym wykonaniem nieidempotentnych operacji basha i edycji plików przy zerwaniu połączenia.
- **Nowoczesny Dashboard WWW**: Dwukolumnowy interfejs z intuicyjnym przeciąganiem (drag & drop), natychmiastową edycją nazw kont (_inline rename_), testami łączności (_quick test_) oraz zarządzaniem kluczami klienckimi bez konieczności restartu serwera.

---

## 📄 License

MIT © [Tomasz](https://github.com/tomaasz)
Inspirowane pracami [KarpelesLab](https://github.com/KarpelesLab/agentlb).
