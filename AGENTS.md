# AGENTS.md — agent-guardrails

This file contains the general rules for working on the **agent-guardrails**
organization's projects. It is maintained in
[agent-guardrails/.github](https://github.com/agent-guardrails/.github) and is
the single source of truth: agent workspaces load it as a URL instruction in
their OpenCode configuration, so changes here reach every workspace without a
copy step.

It acts as the root instruction set: every repository in the organization must
have its own `AGENTS.md` that inherits these rules. A repo-specific `AGENTS.md`
adds to (and never replaces) these rules.

## 1. Text quality

All written output — code, documentation, commits, PRs, issues — must be:

- **coherent** — no garbage, random characters, or fragments;
- **clear** — the reader should never have to guess what was meant;
- **readable** — structure, headings, paragraphs, lists, consistent style;
- **meaningful** — every sentence adds value; filler is not allowed.

## 2. Work is tracked on the project board

All project tasks are tracked in GitHub Projects:

- Board: <https://github.com/orgs/agent-guardrails/projects/1>

Rules:

- any substantive work starts with a ticket on the board;
- commits and PRs must reference the corresponding ticket (explicit URLs, not
  bare `#N`);
- when work is finished, the card is moved or closed;
- working off-board is forbidden — sprint velocity is measured by cards;
- **Explicit references** — issues, PRs, tickets, files, repos, and any other
  organization artifacts are always referenced by a full clickable URL (for
  example: https://github.com/agent-guardrails/opencode-shell-warden-hook/pull/1),
  not by a bare `#123`, "PR #1", or "the files we discussed". Every member must
  be able to open the referenced thing with a single click. Local-only mentions
  follow the same rule when the target will be read by someone else or later —
  write the full URL, or the path relative to the repository root plus the
  repository URL;
- **status freshness** — tickets must always carry the status that matches the
  real state of the work. The board has exactly four statuses, use them as
  follows: newly created ticket — "Todo", started — "In Progress", sent for
  review — "In Review", finished — "Done". A stale status is a bug and must be
  fixed immediately;
- **granular tickets** — a ticket must be scoped so that it can move to
  "In Review" in one pass, without returning to "In Progress". If a task needs
  review feedback to be worked on again, it must be split: the original ticket
  closes (or is reordered), and the follow-up work gets a new, separate ticket.
  Flow on the board is one-directional: "In Progress" → "In Review" → "Done";
  a card moving "In Review" → "In Progress" means the ticket was split badly
  and is a planning error to avoid next time.

## 3. Design before implementation

Any major task starts from written design, not from code. A task is **major**
when it introduces a new feature, changes architecture (transport, lifecycle
policy, trust boundary, security invariants), or starts a new repository or
service.

- An architectural choice was made (options were actually weighed) → a new ADR
  in [agent-guardrails/docs/adr/](https://github.com/agent-guardrails/docs/tree/main/adr)
  with the next sequential number, MADR structure, one decision per file,
  status Accepted. Never edit an Accepted ADR — supersede it with a new one
  ("Supersedes NNNN").
- Normative behavior is touched (protocol, budgets/clamps, config semantics,
  security invariants) → a design draft in
  [agent-guardrails/docs/design/](https://github.com/agent-guardrails/docs/tree/main/design),
  promoted to `spec/` when accepted; the matching spec and `schemas/` update in
  the same change as the behavior they describe.
- The ticket may move to "In Progress" only with full clickable URLs of the
  design document and/or ADR in its body (see §2 — explicit references).

## 4. Repository conventions

Every organization repository is brought to a common standard so that agents
immediately know how to work with it.

Mandatory requirements:

- **Nested `AGENTS.md`** — each repository has its own root-level `AGENTS.md`
  describing repo structure, build/test commands, and working rules. It must
  link back to this root file;
- **Docs repo sync** — sync the documentation repository before every change
  and after every change. Docs get exactly what actually changed, nothing else;
- **Everything through PRs** — direct commits to main branches are forbidden.
  Any change goes through a pull request with a description, a ticket
  reference, and a review.

## 5. Language policy

- All public-facing artifacts are written in **English**: issues, PR titles and
  descriptions, commits, specs, `adr/`, `schemas/`, READMEs, and release notes.
- Code comments follow the language of the surrounding code (default English).
- Existing non-English artifacts are translated opportunistically when next
  touched — no bulk rewrites.

## 6. Basics

- Tests and typecheck must pass before every push.
- Keep changes minimal and on-topic; no drive-by refactors or formatting churn.
- Never commit secrets, keys, or tokens. Never weaken fail-closed behavior.

## 7. Accountability

- Any requirement above left unmet means the work is considered unfinished
  (open).
- Unclear text, off-board work, or bypassing PRs are grounds for sending the
  change back for rework.

---

*This instruction set is complete. Add any new rules directly to this file.*
