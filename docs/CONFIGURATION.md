# ⚙️ Business Analyzer — Configuration & Deployment Guide

This guide explains how to configure, secure, and deploy **Business Analyzer** across local environments, self-hosted servers, and enterprise infrastructure.

---

## 1. Environment Configuration File (`secrets.env`)

Business Analyzer stores runtime configurations in a local `secrets.env` file in the project root. On first run, the server automatically initializes an empty `secrets.env` template if one does not exist.

You can edit `secrets.env` directly or modify it via the **Settings (⚙)** modal in the web dashboard at `http://localhost:8078/admin`.

### Quick Setup

```bash
cp secrets.env.example secrets.env
```

---

## 2. Complete Environment Variables Reference

### 2.1 Local Project Checkout (Required)

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PROJECT_PATH` | **Yes** | *None* | Absolute path to a pre-cloned local git repository of the target project (e.g., `D:/Project/MyRepo` or `/var/repos/my-app`). Required for reading full file context, executing git operations, and spawning Claude CLI worktrees. |

---

### 2.2 GitLab Integration

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `GITLAB_URL` | **Yes** | `https://gitlab.com` | Base URL of your GitLab instance (supports self-hosted installations like `https://gitlab.company.local`). |
| `GITLAB_TOKEN` | **Yes** | *None* | Personal or Project Access Token with `api` scope. Required for fetching MR metadata, diffs, commits, and publishing inline discussion notes. |
| `WEBHOOK_SECRET` | No | *None* | Random secret string shared with GitLab's webhook settings. Sent in the `X-Gitlab-Token` header to verify request authenticity. |
| `GITLAB_PROJECT_ID`| No | *None* | Default GitLab Project ID (numeric ID or `group/repo` string). If omitted, the server can interact with any project accessible by `GITLAB_TOKEN`. |

---

### 2.3 AI Provider Configuration

Business Analyzer features a multi-provider engine selector. You can configure multiple providers simultaneously and switch between them on the fly from the dashboard header.

| Variable | Allowed Values / Format | Description |
| :--- | :--- | :--- |
| `AI_PROVIDER` | `claude-cli`, `openai-compatible`, `9router`, `gemini` | Currently active default engine. |

#### Provider A: Claude Code CLI (`claude-cli`)
- **How it works**: Spawns the native `claude` CLI subprocess directly on the host machine.
- **Authentication**: Uses your existing local Claude CLI login (`claude login`); no separate API key is needed.
- **Prerequisites**:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
- **Variables**:
  - `CLAUDE_MODEL`: *(Optional)* Target model override (leave empty to use CLI default, e.g., `claude-3-7-sonnet-latest`).

#### Provider B: OpenAI-Compatible / GapGPT (`openai-compatible`)
- **Variables**:
  - `AI_BASE_URL`: Base API endpoint (e.g., `https://api.openai.com/v1` or `https://api.gapgpt.app/v1`).
  - `AI_API_KEY`: API authentication bearer key.
  - `AI_MODEL`: Target model identifier (e.g., `gpt-4o`, `gpt-4o-mini`, `deepseek-coder`).

#### Provider C: 9Router Multi-Model Proxy (`9router`)
- **Variables**:
  - `NINEROUTER_BASE_URL`: Router URL (default: `http://localhost:20128/v1`).
  - `NINEROUTER_API_KEY`: Router authorization key.
  - `NINEROUTER_MODEL`: Router target alias (default: `combo`).

#### Provider D: Google Gemini (`gemini`)
- **Variables**:
  - `GEMINI_API_KEY`: Google AI Studio API key.
  - `GEMINI_MODEL`: Model name (default: `gemini-2.0-flash`).

---

### 2.4 Context Budget Overrides (Optional)

Override engine-specific context and output token allocations:

| Variable | Description |
| :--- | :--- |
| `REVIEW_CONTEXT_TOKENS` | Global context window token ceiling override. |
| `REVIEW_MAX_OUTPUT_TOKENS` | Global maximum completion output tokens. |
| `CLAUDE_CONTEXT_TOKENS` / `CLAUDE_MAX_OUTPUT_TOKENS` | Specific override for Claude CLI. |
| `AI_CONTEXT_TOKENS` / `AI_MAX_OUTPUT_TOKENS` | Specific override for OpenAI-compatible. |
| `NINEROUTER_CONTEXT_TOKENS` / `NINEROUTER_MAX_OUTPUT_TOKENS` | Specific override for 9Router. |
| `GEMINI_CONTEXT_TOKENS` / `GEMINI_MAX_OUTPUT_TOKENS` | Specific override for Gemini. |

---

### 2.5 Jira Integration (Self-Hosted Jira Server / Data Center)

| Variable | Description |
| :--- | :--- |
| `JIRA_BASE_URL` | Base URL of self-hosted Jira (e.g., `https://jira.company.local`). |
| `JIRA_API_TOKEN` | Personal Access Token (PAT) generated in Jira profile (`Authorization: Bearer ...`). |
| `JIRA_PROJECT_KEY` | Default Jira project key (e.g., `EM`). |
| `JIRA_ISSUE_TYPE` | Default issue type for automatically filed Sentry tasks (default: `Task` or `Bug`). |

---

### 2.6 Sentry Integration (Self-Hosted or SaaS)

| Variable | Description |
| :--- | :--- |
| `SENTRY_URL` | Sentry URL (e.g., `https://sentry.company.local` or `https://sentry.io`). |
| `SENTRY_AUTH_TOKEN` | Sentry Internal Integration Token with scopes: `project:read`, `event:read`, `event:write`, `org:read`. |
| `SENTRY_ORGANIZATION` | Target organization slug. |
| `SENTRY_PROJECT` | Target project slug. |

---

### 2.7 Security & Admin Access

| Variable | Description |
| :--- | :--- |
| `ADMIN_TOKEN` | Secret administrative token protecting `/api/*` endpoints when accessed from outside `127.0.0.1`. |
| `PORT` | Listening HTTP port (default: `8078`). |
| `CR_DATA_DIR` | Optional custom path for storing runtime data files (default: `./data`). |
| `CR_BACKUP_DIR` | Optional custom path for storing automated backups (default: `./backups`). |

---

## 3. GitLab Webhook Configuration

To trigger automatic reviews when developers open or update merge requests:

1. Navigate to your project repository in GitLab: **Settings → Webhooks**.
2. Fill in the following:
   - **URL**: `http://<your-server-domain-or-ip>:8078/webhook/gitlab`
   - **Secret Token**: Enter the exact string specified in `WEBHOOK_SECRET`.
   - **Trigger**: Check **Merge request events** only. Uncheck Push events.
   - **SSL verification**: Enable if using HTTPS (recommended).
3. Click **Add webhook**.
4. Test the webhook by clicking **Test → Merge request events**. The server should return `HTTP 200 OK`.

---

## 4. Reverse Proxy & Production Deployment

When deploying behind a reverse proxy (Nginx, Apache, Caddy, Traefik), keep the following in mind:

### ⚠️ Crucial Reverse Proxy Notice: `ADMIN_TOKEN`
Business Analyzer grants open administrative access to requests originating from `127.0.0.1`. When running behind a reverse proxy on the same host, **all forwarded incoming requests will appear to come from `127.0.0.1`**.

> [!WARNING]
> **Always set a strong `ADMIN_TOKEN` in `secrets.env` before exposing Business Analyzer behind a reverse proxy.**

### Sample Nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name review.company.local;

    ssl_certificate /etc/ssl/certs/company.crt;
    ssl_certificate_key /etc/ssl/private/company.key;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:8078;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keepalive and timeouts for long-running reviews
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

---

## 5. Multi-Project Setup

Business Analyzer can monitor multiple GitLab repositories concurrently:

1. Open the dashboard at `http://localhost:8078/admin`.
2. Click the **Settings (⚙)** button in the header.
3. Switch to the **📁 Projects** tab.
4. Add new repositories specifying:
   - **Name**: Human-readable title.
   - **GitLab Project ID**: Numeric ID or path with namespace (`team/backend`).
   - **Local Path**: Local filesystem path to the repository clone.
5. In the top toolbar, switch the **Active Project** selector to control MR views and manual triggers. In the background, auto-polling reviews every configured repository independently.
