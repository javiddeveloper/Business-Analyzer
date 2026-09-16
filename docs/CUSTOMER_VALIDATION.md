# 🧪 Business Analyzer — Customer Validation & Hypothesis Testing

This document establishes the experimental framework to validate core product assumptions with real engineering teams before investing in commercial enterprise features.

---

## Hypothesis 1: Fragmented Engineering Information is an Acute Pain
- **Core Assumption**: Engineering Managers waste at least 3 hours per week manually synthesizing progress across GitLab, Jira, and Sentry to understand sprint health and team bottlenecks.
- **Validation Experiment**: Conduct 15 structured 20-minute interviews with Engineering Managers managing 8–25 developers.
- **Primary Metric**: Percentage of interviewees who rank "information fragmentation across code, tasks, and errors" among their top 3 operational frustrations.
- **Success Signal**: $\ge 65\%$ of managers confirm it is a weekly time drain and show interest in a unified view.
- **Failure Signal**: $< 30\%$ care; managers indicate Jira dashboards alone are sufficient.

---

## Hypothesis 2: Teams Want Autonomous AI Review Beyond Simple Diff Matching
- **Core Assumption**: Tech Leads are dissatisfied with superficial cloud PR bots because diff-only bots miss cross-file interface breakage and hallucinate irrelevant styling comments.
- **Validation Experiment**: Deploy Business Analyzer's isolated Claude Worktree inspection on 5 beta engineering teams for 14 days. Measure the adoption and developer feedback votes (👍 vs 👎) on findings.
- **Primary Metric**: Positive feedback rating on AI findings and review comment action rate (findings addressed vs dismissed).
- **Success Signal**: $> 80\%$ positive feedback; developers report catching at least 1 critical multi-file bug per sprint.
- **Failure Signal**: High dismissal rate ($> 40\%$ marked unhelpful or ignored).

---

## Hypothesis 3: Engineering Managers Value Objective, Fair Analytics
- **Core Assumption**: Engineering Managers need objective, defensible metrics to conduct fair 1:1 reviews and spot team burnout without demoralizing developers.
- **Validation Experiment**: Share the 6-factor mathematical scoring model and sample dashboard with 10 engineering leaders.
- **Primary Metric**: Willingness to pilot the Developer Analytics view with their active teams.
- **Success Signal**: $\ge 6$ out of 10 managers agree the sample size confidence discounting and symmetric estimation penalty resolve their fear of "toxic developer scorecards."
- **Failure Signal**: Managers reject numerical scoring altogether, viewing all algorithmic evaluations as counterproductive.

---

## Hypothesis 4: Self-Hosted Teams Will Connect Private Code to On-Prem AI
- **Core Assumption**: Regulated companies using self-hosted GitLab will readily install a zero-dependency, local-first engine because code never leaves their private VPC.
- **Validation Experiment**: Offer the zero-dependency self-hosted setup to 5 regulated enterprise teams (fintech, healthtech).
- **Primary Metric**: Security compliance approval time and successful installation rate.
- **Success Signal**: Security teams approve installation within 5 business days based on the zero npm dependency audit.
- **Failure Signal**: Strict refusal to execute any LLM inference (even via self-hosted Ollama/vLLM or private enterprise endpoints).
