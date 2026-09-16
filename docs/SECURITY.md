# 🛡️ Business Analyzer — Security Architecture & Threat Model

This document outlines the security specifications, threat mitigations, and compliance considerations for **Business Analyzer**.

---

## 1. Security Design Principles

1. **Zero Data Exfiltration**:
   - Source code, diffs, GitLab tokens, Jira credentials, and Sentry crash reports reside strictly on the host operating Business Analyzer.
   - Diffs and context are only dispatched to the LLM engine configured explicitly by the organization.
2. **Deterministic Credential Sweeps**:
   - `lib/checks.js` scans every merge request for secrets using deterministic pattern recognition (independent of non-deterministic LLM behavior).
3. **Zero Supply Chain Attack Surface**:
   - Built with **zero npm dependencies** (`dependencies: {}`), eliminating `node_modules` supply chain exploits, malicious package takeovers, and prototype pollution vulnerabilities.

---

## 2. Threat Vector Audit & Safeguards

### 2.1 Secret Management & Masking
- **Threat**: Accidental leakage of GitLab personal access tokens, Jira tokens, or AI API keys via logs or API responses.
- **Safeguard**:
  - `lib/envFile.js` enforces strict masking on all sensitive fields (`GITLAB_TOKEN`, `AI_API_KEY`, `NINEROUTER_API_KEY`, `GEMINI_API_KEY`, `JIRA_API_TOKEN`, `SENTRY_AUTH_TOKEN`).
  - When inspected via `GET /api/env`, tokens are masked as `••••••••last4`.
  - Sensitive files (`secrets.env`) are explicitly listed in `.gitignore`.

### 2.2 Shell Execution & Command Injection
- **Threat**: Malicious branch names or commit titles attempting command injection during git or Claude CLI subprocess execution.
- **Safeguard**:
  - All calls to `child_process.spawn` pass arguments as discrete string arrays (`['worktree', 'add', targetPath, ref]`) rather than passing interpolated shell strings through `cmd.exe /c` or `/bin/sh -c`.
  - Task keys are strictly validated against regex `^[A-Z0-9_]+-\d+$`.
  - User-provided parameters in git commands are sanitized.

### 2.3 Agentic Worktree Sandboxing (`lib/agentReview.js`)
- **Threat**: An LLM agent attempting to modify the developer's working code, run destructive commands, or alter production files.
- **Safeguard**:
  - The Claude CLI is executed strictly inside a detached, isolated worktree (`../.coder-review-worktrees/mr-<iid>`).
  - Flagged with `--permission-mode plan`, which completely prohibits file writes, deletions, and commits.
  - Strict allowlist of safe inspection tools: `Read`, `Grep`, and `Glob`.
  - The worktree is cleanly removed and pruned upon review completion.

### 2.4 Network Access & Reverse Proxy Hardening
- **Threat**: Unauthorized users accessing `/api/*` endpoints when the server is exposed to an internal network.
- **Safeguard**:
  - `isLocal(req)` verifies whether incoming TCP sockets originate from loopback addresses (`127.0.0.1` or `::1`).
  - Non-localhost requests are rejected with `401 Unauthorized` unless accompanied by a valid `X-Admin-Token` matching `ADMIN_TOKEN`.
  - **Reverse Proxy Requirement**: If deployed behind Nginx, Caddy, or a Kubernetes Ingress on the same machine, `ADMIN_TOKEN` must be explicitly defined because proxied connections appear as `127.0.0.1`.

### 2.5 Webhook Authentication
- **Threat**: Malicious actors sending spoofed GitLab webhook payloads to trigger unwanted AI review jobs.
- **Safeguard**:
  - `verifyWebhookToken` validates the incoming `X-Gitlab-Token` header against `WEBHOOK_SECRET` before processing any payload.

---

## 3. Security Hardening Checklist for Production

- [ ] Define a strong, random `ADMIN_TOKEN` (min 32 characters) in `secrets.env`.
- [ ] Define a strong `WEBHOOK_SECRET` in both `secrets.env` and GitLab Webhook settings.
- [ ] Ensure GitLab Personal Access Tokens are granted the minimum required scope (`api`).
- [ ] Restrict Sentry Auth Tokens to `project:read`, `event:read`, `event:write`, `org:read`.
- [ ] Restrict Jira API Tokens to read access and issue creation in the designated project key.
- [ ] Place Business Analyzer behind HTTPS termination (TLS 1.3) using Nginx or Caddy.
