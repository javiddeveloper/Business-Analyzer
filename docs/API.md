# 📡 Business Analyzer — REST API Specification

This document provides a comprehensive reference for all HTTP and REST API endpoints exposed by **Business Analyzer** (`server.js`).

---

## 1. Authentication & Security Headers

| Header | Description | Required |
| :--- | :--- | :--- |
| `X-Admin-Token` | Secret administrative token matching `ADMIN_TOKEN` in `secrets.env`. Required for all `/api/*` endpoints when accessed from non-localhost IP addresses. | Conditional |
| `X-Gitlab-Token` | Secret webhook token matching `WEBHOOK_SECRET` in `secrets.env`. Required for `/webhook/gitlab`. | Yes |
| `Content-Type` | Set to `application/json; charset=utf-8` for POST and PUT requests. | Yes |

---

## 2. Core & Webhook Endpoints

### `POST /webhook/gitlab`
Receives GitLab webhook events (specifically **Merge Request Events**).

- **Headers**: `X-Gitlab-Token: <WEBHOOK_SECRET>`
- **Request Body**: Standard GitLab Merge Request Webhook payload.
- **Behavior**: Validates the secret token, immediately acknowledges the event (`200 OK`) to prevent GitLab webhook timeout, and asynchronously dispatches a review job if action is `open` or `update`.
- **Response `200 OK`**:
```json
{
  "status": "received",
  "action": "open",
  "iid": 42
}
```

---

### `GET /health`
Liveness and health check endpoint for monitoring systems, container health checks, and load balancers.

- **Authentication**: None.
- **Response `200 OK`**:
```json
{
  "ok": true
}
```

---

### `GET /` & `GET /admin`
Renders and serves the complete Shadcn-inspired single-page Admin Dashboard (`public/admin.html`).

- **Response `200 OK`**: HTML content (`text/html; charset=utf-8`).

---

## 3. Review Orchestration Endpoints

### `GET /api/jobs`
Lists all currently active or recently completed review jobs.

- **Headers**: `X-Admin-Token` (if non-local)
- **Response `200 OK`**:
```json
[
  {
    "id": "14-42",
    "projectId": 14,
    "mrIid": 42,
    "status": "running",
    "trigger": "manual",
    "startedAt": "2026-09-16T10:00:00.000Z",
    "progress": {
      "step": "analyzing_diff",
      "batchesCompleted": 3,
      "totalBatches": 6
    }
  }
]
```

---

### `POST /api/review`
Triggers an immediate code review for a specific GitLab Merge Request.

- **Request Body**:
```json
{
  "projectId": 14,
  "mrIid": 42,
  "post": true
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "jobId": "14-42",
  "status": "started"
}
```

---

### `POST /api/review/stop`
Cancels and halts an in-progress review job. Aborts the active LLM HTTP connection or terminates the spawned Claude CLI subprocess.

- **Request Body**:
```json
{
  "projectId": 14,
  "mrIid": 42
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "stopped": true
}
```

---

### `POST /api/post-note`
Publishes an existing locally generated review report to the GitLab Merge Request as inline discussion threads and a general summary note.

- **Request Body**:
```json
{
  "projectId": 14,
  "mrIid": 42
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "posted": true,
  "discussionsCreated": 5
}
```

---

## 4. GitLab & Merge Requests

### `GET /api/merge-requests`
Fetches all open Merge Requests for the currently active project or all accessible projects.

- **Query Parameters**:
  - `projectId` *(optional)*: Filter by specific GitLab project ID.
- **Response `200 OK`**:
```json
[
  {
    "id": 1054,
    "iid": 42,
    "project_id": 14,
    "title": "EM-2840: Refactor authentication token refresh",
    "state": "opened",
    "author": {
      "username": "developer1",
      "name": "Jane Doe",
      "avatar_url": "https://gitlab.example.com/avatar.png"
    },
    "source_branch": "feature/EM-2840-token-refresh",
    "target_branch": "develop",
    "taskKey": "EM-2840",
    "mergeOrder": 1,
    "draft": false,
    "hasReviewReport": true,
    "lastDecision": "APPROVE"
  }
]
```

---

### `GET /api/merge-requests/:projectId/:iid/context`
Retrieves detailed contextual information for a single Merge Request, including commit history, Jira ticket details, and existing review reports.

- **Response `200 OK`**:
```json
{
  "mr": { "iid": 42, "title": "..." },
  "commits": [ ... ],
  "jira": { "key": "EM-2840", "summary": "...", "status": "In Review" },
  "report": "# Review for MR !42 ...",
  "reportExists": true
}
```

---

## 5. Developer Analytics & Scoring

### `GET /api/developers`
Retrieves a list of all detected developers who have authored merge requests in the repository.

- **Response `200 OK`**: Array of developer usernames (`["j.doe", "a.smith"]`).

---

### `GET /api/developers/roster`
Returns the cached team roster enriched with GitLab membership metadata and role classifications.

- **Query Parameters**:
  - `projectId` *(optional)*: Target project ID.
- **Response `200 OK`**:
```json
[
  {
    "id": 101,
    "username": "j.doe",
    "name": "Jane Doe",
    "role": "Developer",
    "access_level": 30
  }
]
```

---

### `GET /api/team/:author/row`
Fetches a lightweight, fast-loading analytical summary row for a single developer in the Team Overview table.

- **Query Parameters**:
  - `from` *(optional)*: ISO 8601 start date (`YYYY-MM-DD`).
  - `to` *(optional)*: ISO 8601 end date (`YYYY-MM-DD`).
- **Response `200 OK`**:
```json
{
  "author": "j.doe",
  "name": "Jane Doe",
  "wipTasks": 2,
  "openMrs": 1,
  "staleMrs": 0,
  "overdueTasks": 1,
  "tasksWithoutMr": 1,
  "unloggedTasks": 0,
  "doneTasks": 5,
  "mergedMrs": 4,
  "medianHoursToMerge": 14.2,
  "overallScore": 84,
  "attentionFlags": ["OVERDUE_TASK"]
}
```

---

### `GET /api/developers/:author/analytics`
Generates a comprehensive analytical profile for a single developer over an optional date range.

- **Query Parameters**:
  - `from`: Start date (`YYYY-MM-DD`).
  - `to`: End date (`YYYY-MM-DD`).
  - `force`: Set to `true` to bypass cache.
- **Response `200 OK`**:
```json
{
  "author": "j.doe",
  "metrics": {
    "onTime": { "score": 85, "weight": 25, "sampleSize": 8, "confidence": 0.615 },
    "estimation": { "score": 90, "weight": 25, "sampleSize": 6, "confidence": 0.545 },
    "codeQuality": { "score": 78, "weight": 20, "sampleSize": 5, "confidence": 0.500 },
    "completion": { "score": 92, "weight": 15, "sampleSize": 10, "confidence": 0.667 },
    "worklogs": { "score": 100, "weight": 10, "sampleSize": 8, "confidence": 0.615 },
    "singleAuthor": { "score": 80, "weight": 5, "sampleSize": 5, "confidence": 0.500 }
  },
  "overallScore": 86,
  "workItems": [ ... ],
  "mergeRequests": [ ... ]
}
```

---

### `GET /api/developers/:author/export.xlsx`
Generates and downloads a native Excel (`.xlsx`) analytical report for the developer without third-party dependencies.

- **Query Parameters**: `from`, `to`
- **Response `200 OK`**: Binary stream (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).

---

### `POST /api/developers/:author/rating`
Submits a monthly manual maintainer rating for a developer.

- **Request Body**:
```json
{
  "month": "1405-06",
  "score": 88,
  "note": "Excellent architectural contribution to core payment gateway refactoring."
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "saved": true
}
```

---

## 6. Sentry & Issue Triage Endpoints

### `GET /api/sentry/issues`
Fetches unresolved issues from self-hosted Sentry.

- **Query Parameters**:
  - `days`: Number of days to look back (default: 14).
  - `limit`: Maximum issues to fetch (default: 25).
- **Response `200 OK`**:
```json
[
  {
    "id": "14920",
    "title": "NullPointerException in PaymentController",
    "culprit": "PaymentController.processTransaction",
    "level": "error",
    "count": 1420,
    "userCount": 380,
    "firstSeen": "2026-09-10T12:00:00Z",
    "lastSeen": "2026-09-16T08:30:00Z",
    "hasJiraTask": false
  }
]
```

---

### `POST /api/sentry/task`
Analyzes a Sentry crash report using AI and automatically files an actionable task in Jira.

- **Request Body**:
```json
{
  "issueId": "14920",
  "assignee": "j.doe",
  "estimateHours": 4
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "jiraKey": "EM-2950",
  "jiraUrl": "https://jira.example.com/browse/EM-2950"
}
```

---

### `POST /api/sentry/resolve`
Marks an issue as resolved in Sentry.

- **Request Body**:
```json
{
  "issueId": "14920"
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "resolved": true
}
```

---

## 7. Knowledge Base & System Configuration

### `GET /api/knowledge`
Returns all registered organizational engineering standards and rules.

- **Response `200 OK`**: Array of Knowledge Base items.

### `POST /api/knowledge`
Creates a new engineering standard note.

- **Request Body**:
```json
{
  "title": "Security: SQL Parameterization",
  "content": "Never concatenate user input directly into SQL strings. Always use parameterized queries."
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "item": { "id": "kb-102", "title": "...", "content": "..." }
}
```

---

### `GET /api/env`
Retrieves current configuration settings with sensitive tokens masked (`****last4`).

### `POST /api/env`
Updates environment configuration variables in `secrets.env` atomically.

---

### `GET /api/engines`
Lists available AI providers (`claude-cli`, `openai-compatible`, `9router`, `gemini`) and their connectivity status.

### `POST /api/engines/test`
Sends a test ping to the specified AI engine to verify API key validity, base URL reachability, and response generation.
