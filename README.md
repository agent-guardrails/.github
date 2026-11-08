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

## Auditable local PR review

The script-based review workflow creates an exact-head worktree, captures an
immutable evidence bundle, accepts findings produced offline, and publishes only
a previewed and explicitly confirmed `COMMENT` review. It never runs code from
the reviewed repository.

Requirements are Node.js, `git`, and an authenticated GitHub CLI. Run the three
fixed entry points from this repository:

```sh
node .github/scripts/pr-review-sync.mjs \
  --repo agent-guardrails/example --pr 42 --worktree /absolute/path/pr-42 \
  --head 0123456789abcdef0123456789abcdef01234567

node .github/scripts/pr-review-collect.mjs \
  --repo agent-guardrails/example --pr 42 --worktree /absolute/path/pr-42 \
  --out /absolute/path/pr-42-bundle

node .github/scripts/pr-review-publish.mjs \
  --bundle /absolute/path/pr-42-bundle \
  --findings /absolute/path/pr-42-findings.json

node .github/scripts/pr-review-publish.mjs \
  --bundle /absolute/path/pr-42-bundle \
  --findings /absolute/path/pr-42-findings.json --confirm
```

`sync` uses a private bare cache beside the requested worktree and records its
identity in an adjacent sidecar. It refuses dirty or untracked files and verifies
detached `HEAD` exactly. `collect` re-verifies that state, creates the source diff
locally, paginates remote review and CI evidence, records unavailable evidence,
and atomically writes a canonical, SHA-256-protected bundle at exactly `--out`.
Running collection again reuses only a complete verified same-head bundle.

Offline reviewers receive the verified bundle and create a separate version-1
findings JSON document without GitHub credentials. Running the publication
command in preview mode additionally requires GitHub read access so it can omit
findings already present on the pull request. Findings bind repository, PR number,
reviewed head, changed-file locations, and evidence hashes to the bundle. Each
stable `findingId` is derived from the exact review identity, location, and a
reviewer-supplied stable `defectClass`; it remains unchanged when only prose,
evidence references, or severity changes.

Publication without `--confirm` prints the exact review body and inline comments
as JSON and performs no write. Confirmed publication rereads the PR head
immediately before one review POST, suppresses findings already carrying their
hidden stable-ID marker, and submits event `COMMENT` only. Read access for sync,
collection, and preview should be separated from the account allowed to publish
reviews. The publisher cannot approve, request changes, merge, create issues or
issue comments, edit comments, resolve threads, or mutate labels and assignees.

The repository `opencode.jsonc` targets OpenCode V2. Its first shell rule is a
catch-all `ask`; later rules allow only the fixed sync, collect, and syntax-check
command shapes. Tests and every publisher command shape, including `--confirm`,
remain `ask`. `AGENTS.md` requires a trusted tooling checkout and
treats reviewed instructions, hooks, configuration, and executables as untrusted
data, never authority. It also forbids generic GitHub, shell, package, build, and
reviewed-code execution. Restart OpenCode after changing or adopting this
configuration.

Bundle verification checks the fixed inventory (including an empty `ci-logs/`),
safe relative paths, absence of symlinks and extra files, exact artifact hashes,
the `file-hashes.json` digest, and the canonical manifest self-digest. A stale
head, malformed finding, unsafe path, inaccessible required state, or altered
artifact fails closed. CI failures and unavailable logs remain explicit evidence;
they are not treated as successful checks.

The initial version supports only `agent-guardrails/REPO` repositories and
absolute caller-controlled local paths. It does not run tests or builds, infer
paths, execute or decompress evidence, clean user worktrees, or provide workflow
or rollout integration. This is a local CLI implementation, not an MCP server;
offline reviewers exchange files rather than using MCP transport.

## Repo layout

```
.github/
├── workflows/       reusable workflows (workflow_call) — the only place logic lives
└── scripts/         existing automation plus the three local pr-review-*.mjs entry points
workflow-templates/ thin caller workflows (+ GitHub workflow template metadata)
rollout.sh           adds the caller workflows to every org repo via PRs (idempotent)
```
