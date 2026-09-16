# 📈 Business Analyzer — Product Analytics & Telemetry Specification

This document defines the privacy-conscious, local-first event tracking model designed to evaluate user onboarding, feature engagement, and product conversion without transmitting telemetry to third-party surveillance networks.

---

## 1. Privacy-First Tracking Principles

1. **No External Surveillance**: No external SaaS analytics scripts (Google Analytics, Mixpanel, Segment) are embedded in the code.
2. **Local Storage First**: All telemetry events are stored in `data/events.json` using atomic writes.
3. **Anonymized Metrics**: Events record action types, timestamps, and aggregate counts—never source code strings, commit messages, or confidential ticket descriptions.

---

## 2. Core Event Schema

Each recorded event follows this standard schema:

```json
{
  "eventId": "evt_1789572000_a8f9",
  "timestamp": "2026-09-16T15:30:00.000Z",
  "event": "first_review_completed",
  "properties": {
    "provider": "claude-cli",
    "findingsCount": 3,
    "decision": "APPROVE",
    "durationMs": 4250
  }
}
```

---

## 3. Product Lifecycle Events

| Event Name | Trigger | Product Significance |
| :--- | :--- | :--- |
| `app_started` | Server boots up (`npm start`). | Tracks active deployment retention and reboot frequency. |
| `onboarding_started` | User opens dashboard with unconfigured settings. | Funnel entrance: evaluates first-time installation interest. |
| `demo_toggled` | User enables or disables Demo Mode (`?demo=1`). | Evaluates engagement with sample enterprise data before setup. |
| `project_connected` | User successfully saves a valid `PROJECT_PATH`. | Critical milestone: User has bridged a local git repository. |
| `gitlab_connected` | Valid `GITLAB_TOKEN` verified via `/api/status`. | Critical milestone: GitLab API integration confirmed. |
| `review_started` | Review triggered via Webhook, polling, or manual button. | Measures review frequency and trigger channels. |
| `review_completed` | Review successfully completes with report generated. | Core value delivery event. |
| `jira_connected` | User saves valid Jira Base URL and PAT. | Evaluates expansion into task intelligence. |
| `sentry_connected` | User saves valid Sentry token and organization slug. | Evaluates expansion into production error triage. |
| `analytics_viewed` | User navigates to Developer Analytics page. | Measures interest in engineering intelligence and 1:1 metrics. |
| `report_exported` | User downloads an `.xlsx` developer performance report. | High-intent signal: Managerial reporting and executive review. |

---

## 4. Key Activation Metrics (Product KPIs)

1. **Time-to-First-Review (TTFR)**: Target $< 10$ minutes from `git clone` to first successful MR review note.
2. **Review Completion Rate**: Percentage of started reviews that complete without errors ($> 98\%$).
3. **Multi-Repository Adoption**: Percentage of instances monitoring $\ge 2$ repositories ($> 35\%$).
4. **Analytics Engagement Rate**: Percentage of active review users who also inspect Developer Analytics weekly ($> 60\%$).
