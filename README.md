# ⚖️ claude-lb

> **Universal Multi-Account Load Balancer, Quota Rotator & Modern Web Dashboard for Claude Code & Codex CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](docker/Dockerfile)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

`claude-lb` acts as an intelligent proxy between your coding tools ([Claude Code](https://claude.ai/claude-code), [VS Code Claude Extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code), Cursor, Roo Code) and upstream providers (Anthropic, OpenAI). It pools multiple Claude Max, Pro, Team, or API-key accounts and automatically rotates traffic when limits are approached — preventing interruptions and 429 quota exhaustion.

---

## 🌟 Key Features

- **⚡ Multi-Account Pooling & Adaptive Rotation**: Pools multiple Anthropic accounts and rotates before hitting 5-hour session or 7-day weekly rate limits (customizable threshold, default 98%).
- **📊 Real-time Web Dashboard**: Responsive web UI (`/dashboard`) monitoring account status, prepaid balances, active connections, token usage, and client keys with live WebSocket & SSE updates.
- **🔄 In-Dashboard 1-Click OAuth Re-login**: Re-authenticate expired accounts directly through the web UI using Anthropic's OAuth flow without touching the server CLI.
- **🛠️ Zero-Config Client Connectors**: Instant 1-line setup scripts for Linux, macOS, WSL, and Windows PowerShell that configure both the Claude Code CLI and VS Code official extension, handling OAuth credential backups and conflict prevention automatically.
- **👥 Multi-Tenant Client Keys**: Generate independent access keys (`tc-...`) with per-key token metrics, rate limits, and permission scopes for team members.
- **🪶 Zero External Dependencies**: 100% pure Node.js built-ins (`http`, `https`, `crypto`, `net`). Extremely lightweight, starts in milliseconds.
- **🔒 Secure by Default**: Automatic loopback and Tailscale Tailnet bypass, constant-time API key comparisons, strict Content Security Policy (CSP), and zero secrets in git.
- **🐳 Docker & systemd Ready**: Out-of-the-box Docker container and native systemd service integration.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Clients["Developer Workstations"]
        C1["Claude Code CLI (Linux/macOS)"]
        C2["VS Code Extension (Windows)"]
        C3["Cursor / IDEs"]
    end

    subgraph Proxy["claude-lb Proxy & Dashboard (Port 3456)"]
        Gate["API Key & Tailscale Gate"]
        Router["Smart Quota Rotator"]
        Dash["Web Dashboard & Admin API"]
        Gate --> Router
        Gate --> Dash
    end

    subgraph Upstream["Upstream Providers"]
        A1["Account 1 (Claude Max - Active)"]
        A2["Account 2 (Claude Pro - Standby)"]
        A3["Account 3 (Prepaid API Key)"]
        A4["Account 4 (OpenAI Codex)"]
    end

    C1 -->|ANTHROPIC_BASE_URL| Gate
    C2 -->|Proxy URL| Gate
    C3 -->|API Base| Gate
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
git clone https://github.com/tomaasz/claude-lb.git
cd claude-lb

# Start interactive TUI server
npm start

# Or run headless daemon (recommended for servers)
node src/index.js headless
```

On first startup, `claude-lb` generates a primary admin API key and prints the dashboard URL:
```text
Claude-LB proxy listening on 0.0.0.0:3456
Web Dashboard: http://localhost:3456/dashboard
Admin Key: tc-adm_xxxxxxxxxxxxxxxx
```

### Option 2: Docker & Docker Compose

```bash
git clone https://github.com/tomaasz/claude-lb.git
cd claude-lb/docker

# Start container in background
docker compose up -d
```

Your configuration and accounts will persist in `docker/data/claude-lb.json`.

### Option 3: Systemd Service (Linux)

Install as a background systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cat << 'EOF' > ~/.config/systemd/user/claude-lb.service
[Unit]
Description=Claude-LB Proxy Service
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/claude-lb
ExecStart=/usr/bin/node %h/claude-lb/src/index.js headless
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claude-lb
```

---

## 💻 Client Setup (Connecting Developers)

Connecting developer machines takes a single command. The server dynamically bakes its address into the installer script:

### Linux / macOS / WSL

Run in your terminal:
```bash
curl -sSL http://your-server:3456/setup | bash
```

### Windows (PowerShell)

Run in PowerShell:
```powershell
irm http://your-server:3456/setup.ps1 | iex
```

### What the client installer does automatically:
1. Prompts for your Client API Key (`tc-...`) or verifies connection with server.
2. Backs up any existing OAuth tokens in `~/.claude/.credentials.json` to prevent Anthropic *"Auth conflict"* errors.
3. Updates `~/.claude/settings.json` with `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`.
4. Configures official **VS Code Claude Code Extension** (`settings.json`).
5. Persists shell environment variables (`~/.config/claude-lb.env` loaded in `.bashrc`/`.zshrc` or Windows User Registry).

---

## 🖥️ Web Dashboard

Access the interactive dashboard at:
```text
http://your-server:3456/dashboard
```

### Dashboard Features:
- **Accounts Overview**: Real-time status badges (`active`, `idle`, `rate-limited`, `error`, `needs-relogin`), 5h session and 7d weekly quota gauges, and prepaid account balances ($ / credits).
- **1-Click OAuth Login & Re-login**: Add new Claude accounts or refresh expired sessions directly from your browser.
- **Client Access Keys**: Create, copy, rotate, and revoke client API keys (`tc-...`) with usage stats (requests, tokens).
- **Client Connect Wizard**: Copy pre-filled setup commands for Linux, macOS, Windows, and VS Code.
- **Manual Overrides**: Toggle accounts on/off, adjust priority levels, or manually switch active accounts.

---

## 🛡️ Reverse Proxy & Tailscale

`claude-lb` works seamlessly behind reverse proxies and VPNs like **Tailscale**.

### Tailscale Tailnet Authentication
When accessed from your Tailscale network (e.g., `*.ts.net`), `claude-lb` can automatically trust connections from authenticated Tailnet peers. Configure allowed hostnames via environment variable:

```bash
export CLAUDE_LB_HOST="claude-lb.your-tailnet.ts.net"
```

### Caddy Configuration Example

```caddy
claude.your-domain.com {
    reverse_proxy localhost:3456 {
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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## ⚙️ Configuration Reference

Configuration is stored in `~/.config/claude-lb.json` (or `~/.config/teamclaude.json` for backward compatibility).

```json
{
  "proxy": {
    "port": 3456,
    "host": "0.0.0.0",
    "apiKey": "tc-adm_your_admin_secret",
    "clientKeys": [
      { "name": "developer-alice", "key": "tc-alice_key_xxxx" },
      { "name": "developer-bob", "key": "tc-bob_key_yyyy" }
    ],
    "allowedHosts": ["localhost", "127.0.0.1", "claude.your-domain.com"],
    "switchThreshold": 98,
    "holdSeconds": 0
  },
  "accounts": [
    {
      "name": "primary-max",
      "type": "oauth",
      "priority": 1,
      "accountUuid": "...",
      "token": { "access_token": "..." }
    }
  ]
}
```

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_LB_PORT` | Port to bind proxy server | `3456` |
| `CLAUDE_LB_HOST` | Host address or domain allowed | `0.0.0.0` |
| `CLAUDE_LB_CONFIG` | Custom path to config file | `~/.config/claude-lb.json` |
| `CLAUDE_LB_URL` | Base URL used by installer scripts | Dynamic detection |

---

## 🔄 Backward Compatibility

`claude-lb` includes complete backward compatibility with **TeamClaude**:
- Existing configuration files (`~/.config/teamclaude.json`) are automatically detected and preserved.
- CLI aliases (`teamclaude`) and legacy endpoints (`/teamclaude/status`, `/teamclaude/dashboard`) continue to function without changes.
- Existing environment files (`~/.config/teamclaude.env`) are kept synchronized with new configurations.

---

## 📄 License

MIT © [Tomasz](https://github.com/tomaasz)
Based on upstream work by [KarpelesLab](https://github.com/KarpelesLab/teamclaude).
