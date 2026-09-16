# 🚀 Business Analyzer

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-blue.svg)](package.json)
[![Tests Passing](https://img.shields.io/badge/tests-226%20passing-success.svg)](tests/)
[![Architecture](https://img.shields.io/badge/architecture-Vanilla%20JS%20%7C%20Pure%20Node.js-orange.svg)](docs/ARCHITECTURE.md)
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey.svg)](package.json)

**Business Analyzer** (formerly *Coder Review*) is a high-performance, zero-dependency engineering intelligence platform that unifies **Autonomous AI Code Review** on GitLab Merge Requests with **Engineering Team Performance Analytics** powered by Jira and Sentry.

Built with pure Node.js and vanilla browser technologies, it requires **zero npm packages**, runs on a single server or laptop, persists state atomically to local disk, and includes a modern, responsive Shadcn-style dark dashboard with dual-language (English/Persian) typography and bidirectional text isolation.

---

## 📑 Table of Contents

- [Key Capabilities](#-key-capabilities)
  - [1. Autonomous AI Code Review](#1-autonomous-ai-code-review)
  - [2. Engineering Performance Analytics](#2-engineering-performance-analytics)
  - [3. Sentry Crash Triage & Jira Task Generation](#3-sentry-crash-triage--jira-task-generation)
  - [4. Dynamic Team Knowledge Base](#4-dynamic-team-knowledge-base)
  - [5. Multi-Project Management](#5-multi-project-management)
- [Architecture & Design Philosophy](#-architecture--design-philosophy)
- [Installation & Quick Start](#-installation--quick-start)
- [Configuration Reference](#-configuration-reference)
- [GitLab Integration (Webhook & Polling)](#-gitlab-integration-webhook--polling)
- [Dashboard Walkthrough](#-dashboard-walkthrough)
- [Mathematical Scoring Model](#-mathematical-scoring-model)
- [Testing & Quality Assurance](#-testing--quality-assurance)
- [Documentation Index](#-documentation-index)
- [Intentional Design Trade-offs](#-intentional-design-trade-offs)

---

## ✨ Key Capabilities

### 1. Autonomous AI Code Review

- **Agentic Repository-Wide Inspection (Claude CLI Mode)**:
  - Spawns the native `claude` CLI inside an isolated, detached git worktree (`../.coder-review-worktrees/mr-<iid>`).
  - Read-only execution with `--permission-mode plan` and strictly allowlisted tools (`Read`, `Grep`, `Glob`).
  - The AI autonomously traverses callers, implementations, unit tests, and cross-file interfaces to catch bugs that diff-only reviews miss.
  - Leaves the developer's working directory and uncommitted work completely untouched.
- **Diff-Driven Batching (HTTP Engines)**:
  - Supports OpenAI-compatible endpoints (GapGPT, OpenRouter, self-hosted LLMs), 9Router, and Google Gemini.
  - Intelligently filters lockfiles, build artifacts (`node_modules`, `dist`, `vendor`), binaries, and generated files.
  - Dynamically packages diffs into clean batches bounded by engine-specific context budgets with up to 6-way concurrency.
- **Deterministic Machine Checks (Independent of LLM)**:
  - Scans for leaked credentials (AWS, JWT, private keys, GitLab/GitHub access tokens).
  - Detects leftover debugging statements (`console.log`, `debugger`, `print()`, `var_dump`).
  - Catches unmerged git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
  - Flags missing tests on non-trivial source code changes.
- **Precision Line Anchor Positioning**:
  - Diffs are parsed down to exact line coordinates. Comments are published directly onto the affected line as GitLab Discussions.
  - If a model hallucinates a line number outside the diff, the finding is safely routed to the MR summary note rather than failing with an API error.
- **Idempotent Finding Fingerprints**:
  - Every finding has an invisible hash fingerprint. Re-reviewing updated branches never reposts duplicate comments.
- **Sequential Merge-Order Auto-Approval**:
  - When enabled, clean reviews (`APPROVE`) automatically approve the MR in GitLab.
  - Enforces merge discipline: **Approvals are held until all earlier-created MRs in the same project have been approved**.
  - **Safety First**: The tool *never* merges code automatically. Final merge execution remains in human hands and CI pipelines.
- **Standardized Local Markdown Reports**:
  - Generates comprehensive review reports at `review/MR-<iid>.md` matching senior human reviewer formatting.

---

### 2. Engineering Performance Analytics

A dedicated analytics suite providing engineering leaders with data-driven team insights:

- **Team Overview (Managerial Landing View)**:
  - Real-time status of all engineers: active tasks, open MRs, stale MRs (>72h), overdue deadlines, unlogged work, merged velocity, and overall scores.
  - **Attention Priority Sorting**: Automatically surfaces engineers who have blocking issues *today* (e.g., severe overdue tickets, stalled MRs), rather than sorting by historical average scores.
  - Progressive streaming rendering: Each developer row renders as soon as its GitLab and Jira data loads, avoiding UI lockups.
- **Individual Developer Dossiers**:
  - **Live Workload**: Open MRs, in-progress tasks, tasks missing MR branches, current sprint completion.
  - **Needs Attention**: Prioritized, clickable links to overdue tasks (with delay days) and stalled reviews.
  - **Delivery History**: Completed tasks, merged MRs, p50 and p90 merge duration, on-time delivery rates, and estimation variance.
  - **Sprint Trends**: Visual 5-sprint performance trend graphs and monthly rating history.
- **Zero-Dependency Native Excel Export**:
  - Generates full `.xlsx` analytical spreadsheets directly from Node.js standard libraries for management reporting.
- **Monthly Manual Grading**:
  - Enables engineering managers to record structured qualitative monthly feedback alongside automated metrics.

---

### 3. Sentry Crash Triage & Jira Task Generation

- Seamless integration with self-hosted or cloud Sentry instances (`/api/0/`).
- Prioritizes unresolved production errors by frequency, impact, and user reach.
- **AI-Assisted Root Cause Diagnosis**: Generates immediate stack-trace interpretations.
- **One-Click Jira Ticket Creation**: Instantly turns a Sentry crash into a structured Jira task with automatic priority assignment, effort estimation, and developer assignment based on current workload.
- Marks issues resolved in Sentry directly from the dashboard.

---

### 4. Dynamic Team Knowledge Base

- Define custom engineering standards, architectural decisions, and coding conventions via the dashboard.
- Automatically injected into review prompts across every active AI engine.
- Direct editing, deletion, and `.md`/`.txt` file uploads.

---

### 5. Multi-Project Management

- Manage multiple GitLab repositories simultaneously under one dashboard.
- Top toolbar selector controls the active repository for MR reviews and polling.
- Developer Analytics seamlessly aggregates data across all configured repositories to accurately evaluate cross-project engineering output.

---

## 🏗 Architecture & Design Philosophy

Business Analyzer is architected around three non-negotiable principles:

1. **Zero External Dependencies (`package.json: dependencies: {}`)**:
   - Zero vulnerability surfaces, zero npm install drift, and no external build steps.
   - Built with standard Node.js modules: `http`, `https`, `crypto`, `fs`, `child_process`, `path`, and `os`.
2. **Deterministic File-Based Persistence**:
   - State and caches live in `data/*.json`.
   - Write safety is guaranteed via `lib/atomicWrite.js`: writes to a unique temporary file followed by an atomic OS `renameSync`.
   - Automated backups run every 24 hours into `backups/YYYY-MM-DD-HHmmss/` via `lib/backup.js`.
3. **Dynamic Context Budgeting (`lib/contextBudget.js`)**:
   - Computes token boundaries dynamically per engine: Claude (200K), OpenAI (128K), 9Router (32K), Gemini (1M).
   - Accounts for language differences (Persian prompts at 1.2 chars/token; code at 3.6 chars/token).
   - Truncates safely along line boundaries and explicitly logs omitted context in review summaries.

---

## 🛠 Installation & Quick Start

### Prerequisites
- **Node.js**: Version `18.0.0` or higher.
- **Git**: Installed and available in your system path.
- **Local Git Clone**: An existing local clone of your target repository on the same machine (`PROJECT_PATH`).

### Quick Setup

1. **Clone & Launch**:
   ```bash
   git clone https://github.com/javiddeveloper/Business-Analyzer.git
   cd Business-Analyzer
   npm start
   ```

2. **Access Dashboard**:
   Open your browser and navigate to:
   ```
   http://localhost:8078/admin
   ```

3. **Configure Settings**:
   On your first visit, the **Settings (⚙)** modal opens automatically if required variables are missing:
   - Provide `PROJECT_PATH` (absolute path to your local project clone).
   - Enter your `GITLAB_URL` and `GITLAB_TOKEN` (Access Token with `api` scope).
   - Select your preferred AI Provider.

*Tip*: You can also initialize configurations by copying the template:
```bash
cp secrets.env.example secrets.env
```

---

## ⚙️ Configuration Reference

Key variables managed in `secrets.env` or through the **Settings (⚙)** UI:

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PROJECT_PATH` | **Yes** | *None* | Absolute path to local git clone of target repository. |
| `GITLAB_URL` | **Yes** | `https://gitlab.com` | Base URL of GitLab instance (cloud or self-hosted). |
| `GITLAB_TOKEN` | **Yes** | *None* | GitLab Access Token with `api` permissions. |
| `WEBHOOK_SECRET` | No | *None* | Shared secret token for verifying GitLab webhook requests. |
| `GITLAB_PROJECT_ID`| No | *None* | Restricts monitoring to a specific project ID (or group/repo). |
| `AI_PROVIDER` | **Yes** | `openai-compatible` | Active engine: `claude-cli`, `openai-compatible`, `9router`, `gemini`. |
| `CLAUDE_MODEL` | No | *CLI Default* | Model override for Claude Code CLI. |
| `AI_BASE_URL` | Conditional | `https://api.gapgpt.app/v1` | Base URL for OpenAI-compatible provider. |
| `AI_API_KEY` | Conditional | *None* | API Key for OpenAI-compatible provider. |
| `AI_MODEL` | Conditional | `gpt-4o-mini` | Model name for OpenAI-compatible provider. |
| `JIRA_BASE_URL` | No | *None* | Self-hosted Jira Server/Data Center base URL. |
| `JIRA_API_TOKEN` | No | *None* | Jira Personal Access Token (`Bearer`). |
| `SENTRY_URL` | No | *None* | Base URL of Sentry instance. |
| `SENTRY_AUTH_TOKEN`| No | *None* | Sentry API token with `event:read`, `event:write`, `project:read`. |
| `ADMIN_TOKEN` | No | *None* | Administrative token for protecting `/api/*` when accessed outside localhost. |
| `PORT` | No | `8078` | Server listening port. |

*For complete details, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).*

---

## 🔗 GitLab Integration (Webhook & Polling)

Business Analyzer supports two complementary modes of operation:

### Mode 1: Automated Background Polling (Zero Network Configuration)
- Works out-of-the-box on local workstations, private VPNs, or behind NAT without public IPs.
- Enable the **Auto-Review** toggle in the dashboard header.
- The server automatically polls open MRs every $N$ seconds (default: 120s), reviewing any MR with new commits.
- Toggle **Skip Draft MRs** to ignore work-in-progress code.

### Mode 2: GitLab Webhook (Instant Event-Driven Reviews)
1. Go to your repository in GitLab: **Settings → Webhooks**.
2. **URL**: `http://<your-server-address>:8078/webhook/gitlab`
3. **Secret Token**: Enter the value configured in `WEBHOOK_SECRET`.
4. **Trigger**: Select **Merge request events** only.
5. Click **Add Webhook**. Incoming MR events will be acknowledged immediately (`HTTP 200`) and reviewed in the background.

---

## 🖥 Dashboard Walkthrough

The web interface (`http://localhost:8078/admin`) provides a unified command center:

- **Header Bar**:
  - Live status pills for GitLab connectivity, active AI engine, and token authentication.
  - Active project dropdown selector.
  - Auto-Review toggle and status indicator.
  - Navigation buttons: **📊 Developer Analytics**, **🛡️ Sentry Issues**, and **⚙ Settings**.
- **Merge Requests View**:
  - Left sidebar listing open MRs ordered by **sequential merge sequence** (oldest first) with task keys (`EM-1234`) and target branch indicators.
  - Real-time status indicators: Running (blinking cyan), Approved (green), Changes Requested (red), Error (orange).
  - Main panel showing MR details, commit log, linked Jira status, and the one-click **Run Review** button.
  - Real-time **⏹ Stop** button to immediately abort long-running or stalled reviews.
  - Inline preview of local `review/MR-<iid>.md` reports with one-click GitLab publishing.
- **Developer Analytics View**:
  - **Team View**: Aggregated team matrix with actionable attention counters, delivery metrics, and overall scores.
  - **Individual View**: Deep-dive profiles with live workloads, attention items, 5-sprint trajectory charts, detailed metric decompositions, and Excel export.
- **Settings Modal (⚙)**:
  - Tabbed interface to configure Environment variables, AI engines, Multi-projects, and Knowledge Base articles without restarting the server.

---

## 📊 Mathematical Scoring Model

Developer performance scores ($S \in [0, 100]$) are calculated using a balanced, normalized multi-factor formula:

$$S = \frac{\sum_{i=1}^{M} w_i \cdot c_i \cdot s_i}{\sum_{i=1}^{M} w_i \cdot c_i}$$

### 1. The 6 Balanced Metrics

| Metric | Weight ($w_i$) | Sample ($n$) | Confidence Factor ($c_i$) | Calculation Basis |
| :--- | :---: | :--- | :---: | :--- |
| **On-Time Delivery** | 25 | Total Jira tasks with due dates | $\frac{n}{n + 5}$ | On-time ratio penalized smoothly by days overdue. |
| **Estimation Accuracy** | 25 | Tasks with estimate & time spent | $\frac{n}{n + 5}$ | Symmetric $\log_2$ penalty comparing estimated vs actual logged time. |
| **Code Quality** | 20 | Total reviewed MRs | $\frac{n}{n + 5}$ | Review findings normalized by file count: $\frac{\text{findings}}{\sqrt{\text{files}}}$. |
| **Task Completion** | 15 | Total assigned Jira tasks | $\frac{n}{n + 5}$ | Ratio of Resolved/Done tasks within the timeframe. |
| **Worklog Logging** | 10 | Tasks in Review or Done | $\frac{n}{n + 5}$ | Percentage of finished tasks with logged work hours. |
| **Single-Author Branch**| 5 | MRs with review reports | $\frac{n}{n + 5}$ | Ratio of branches containing commits solely by the author. |

### 2. Ethical Guarantees Built Into Scoring
- **No Penalty for Missing Signals**: If a developer has zero sample data for a metric ($n = 0$), the metric is omitted and its weight redistributed proportionally. Missing worklogs never default to a zero score.
- **Sample Size Scaling**: Small sample sizes are discounted using $\frac{n}{n + 5}$, preventing an isolated MR or ticket from skewing ratings.
- **Symmetric Estimation**: Padding estimates is penalized just as strictly as under-estimating, discouraging team members from inflating ticket estimates.
- **Recency Neutrality**: Leaves of absence and approved holidays do not affect engineering performance ratings.

---

## 🧪 Testing & Quality Assurance

Business Analyzer maintains an exhaustive regression test suite built on Node.js native test runner:

```bash
npm test
```

### Test Coverage Highlights (226 Tests)
- ✅ Isolated git worktree creation, sandboxing, and cleanup on disposable repositories.
- ✅ AI prompt construction and JSON response parsing.
- ✅ High-volume diff chunking, batching, and context budget boundaries.
- ✅ Exact diff parsing, hunk position mapping, and GitLab inline discussion generation.
- ✅ Deterministic security and credential scanning.
- ✅ Finding deduplication and fingerprint hashing.
- ✅ Sequential merge-order auto-approval logic.
- ✅ Developer scoring formulas, confidence scaling, and Excel export generation.
- ✅ Sentry crash triage, stack parsing, and Jira task compilation.
- ✅ Atomic file persistence and automated backup mechanics.

---

## 📚 Documentation Index

For deeper technical documentation, refer to the guides in the repository:

- 🏛️ **[Technical Architecture](docs/ARCHITECTURE.md)**: Deep dive into the internal subsystems, execution pipelines, data flow, and security boundaries.
- 📡 **[REST API Reference](docs/API.md)**: Exhaustive documentation of all endpoints, parameters, request schemas, and responses.
- ⚙️ **[Configuration & Deployment](docs/CONFIGURATION.md)**: Production deployment instructions, reverse proxy setups, and environment variable tuning.
- 💼 **[Business & CTO Review](BUSINESS-REVIEW.md)**: Comprehensive business analysis, ROI evaluation, governance insights, and architectural scorecard.

---

## ⚠️ Intentional Design Trade-offs

1. **Auto-Approve Yes, Auto-Merge Never**:
   - Business Analyzer will approve clean MRs sequentially when configured, but will **never** execute a merge. Final merges remain in human hands and CI gates.
2. **Deterministic Markdown Overwrites**:
   - `review/MR-<iid>.md` is regenerated cleanly on every run. It intentionally does not attempt to merge manual human edits into the file across review cycles.
3. **Single-Node Focus**:
   - Designed to run leanly on an internal team server or Tech Lead workstation. It deliberately avoids complex distributed databases or Kubernetes clusters in favor of native simplicity and zero operating overhead.

---

## 📄 License

This project is proprietary and unlicensed. All rights reserved.
