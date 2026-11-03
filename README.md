# agent-guardrails organization meta-repo

Org profile, community health files, and **shared AI workflows** used by every
repository in the organization: **PR code review**, **issue triage**, **release notes**.
Free for public repos: GitHub-hosted runners are free on public repositories, and the
AI provider runs on a free API tier (Google Gemini by default).

## How it works

The logic lives **only here**, once. Each project repo carries a ~10-line *caller*
workflow that invokes a *reusable* workflow from this repo:

```
project repo (e.g. shell-warden)            this repo (agent-guardrails/.github)
.github/workflows/ai-review.yml             .github/workflows/ai-review.yml  (workflow_call)
        │  uses: agent-guardrails/.github/.github/workflows/ai-review.yml@main
        └────────────────────────────────────────────► review.py  (chunked diff,
            secrets: inherit → org secret AI_API_KEY   fallback models, honest
                                        PR comment     coverage report)
```

(The double `.github` in the `uses:` path is standard: workflows must live in
`.github/workflows/` *inside* any repository, including this special one.)

- A prompt/model/limit change is made here and applies to all projects on the next run.
- `secrets: inherit` passes the caller's secrets (including org-level ones); the
  reusable workflow never sees anything else.
- Callers reference `@main`; pin to a tag (e.g. `@v1`) for stability instead.

## The three tasks

| Workflow | Trigger | Effect |
|---|---|---|
| `ai-review.yml` | `pull_request` | AI review posted on the PR: correctness/security/style findings with an explicit coverage statement |
| `issue-triage.yml` | issue `opened`/`reopened`, manual dispatch | Applies up to 3 **existing** labels + posts a one-paragraph summary comment |
| `release-notes.yml` | release `published`, manual dispatch | Drafts "What's Changed" from merged PRs and updates the release body (existing text preserved, draft marked as AI) |

## Adding to a new project repo

- Run `bash rollout.sh` (idempotent — it skips repos that already have the
  workflows and opens PRs for the rest; it also adds the org-wide `AGENTS.md` to
  repos without their own).
- Alternatively, pick the workflows in the Actions tab under "New workflow"
  (GitHub serves the [org workflow templates](https://github.com/agent-guardrails/.github/tree/main/workflow-templates)),
  or copy the three files from
  [`workflow-templates/`](workflow-templates/) into the repo's `.github/workflows/` as-is.

## Setup (once)

1. **API key** — create a free key at [Google AI Studio](https://aistudio.google.com/apikey).
2. **Org secret** — GitHub → Organization Settings → Secrets and variables → Actions →
   New organization secret: name `AI_API_KEY`, visibility *All repositories*.
3. **Rollout** — from a machine with `gh` authenticated: `bash rollout.sh`; merge the PRs.

## Switching AI provider later

The scripts speak the OpenAI-compatible Chat Completions API, so a swap is config-only:

| Provider | `AI_BASE_URL` (org variable) | `AI_MODELS` (org variable) |
|---|---|---|
| Gemini (default) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash,gemini-3.5-flash-lite` |
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat-v3.1:free` |

The `AI_API_KEY` secret name stays the same — replace its value and set the two
org variables. Models are tried in order on 429/5xx, so list a fallback.

## Limits & security

- **Fork PRs**: GitHub does not pass secrets to fork-triggered runs, so review is
  skipped there (the caller workflow guards this explicitly).
- **Free-tier rate limits**: review is capped (~25 model calls/PR, 8-min deadline),
  triage and notes are single calls. Failures post an honest "coverage incomplete"
  comment instead of a fake clean verdict.
- **AI output is advisory**: findings are comments only, nothing blocks merges.
  `review.py` is deliberately injection-resistant (diff content is data, not
  instructions) and never executes anything from the diff.

## Repo layout

```
.github/
├── workflows/       reusable workflows (workflow_call) — the only place logic lives
└── scripts/         review.py (PR review), triage.py (issues), release_notes.py (releases)
workflow-templates/ thin caller workflows (+ GitHub workflow template metadata)
rollout.sh           adds the caller workflows to every org repo via PRs (idempotent)
```
