"""AI issue triage: apply up to 3 existing labels and post a one-paragraph summary.

Provider-agnostic: any OpenAI-compatible endpoint via AI_BASE_URL / AI_MODELS / AI_API_KEY.
Single bounded model call. Never creates new labels, never edits the issue body,
and only comments once per run (re-open the issue to re-triage).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

AI_BASE_URL = os.environ.get(
    'AI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai').rstrip('/')
AI_MODELS = [m.strip() for m in os.environ.get(
    'AI_MODELS', 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',') if m.strip()]
AI_API_KEY = os.environ.get('AI_API_KEY', '')
GH_TOKEN = os.environ.get('GH_TOKEN', '')
REPO = os.environ.get('GITHUB_REPOSITORY', '')
ISSUE_NUM = os.environ.get('ISSUE_NUM', '')
API = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
TRANSIENT = {429, 500, 502, 503, 504}
MAX_LABELS = 3


def gh(path: str, data: dict | None = None, method: str = 'GET'):
    """GitHub REST call with the Actions token."""
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        f'{API}{path}', data=body, method=method,
        headers={
            'Authorization': f'Bearer {GH_TOKEN}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def chat(prompt: str, max_tokens: int = 700) -> str:
    """One completion; walks AI_MODELS in order on transient failures."""
    last_err: Exception | None = None
    for model in AI_MODELS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    f'{AI_BASE_URL}/chat/completions',
                    data=json.dumps({
                        'model': model,
                        'messages': [{'role': 'user', 'content': prompt}],
                        'max_tokens': max_tokens,
                        'temperature': 0.2,
                    }).encode(),
                    headers={
                        'Authorization': f'Bearer {AI_API_KEY}',
                        'Content-Type': 'application/json',
                    }, method='POST')
                with urllib.request.urlopen(req, timeout=90) as r:
                    return json.loads(r.read().decode())['choices'][0]['message']['content']
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code not in TRANSIENT:
                    break  # model-level problem: try the next model
                time.sleep(3 * (attempt + 1))
            except Exception as e:  # network error: retry, then next model
                last_err = e
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f'all models failed, last error: {last_err}')


def main() -> int:
    issue = gh(f'/repos/{REPO}/issues/{ISSUE_NUM}')
    if 'pull_request' in issue:
        print('PR passed to triage; skipped (PRs are handled by ai-review)')
        return 0

    repo_labels = [l['name'] for l in gh(f'/repos/{REPO}/labels?per_page=100')]
    prompt = (
        'You are a maintainer assistant triaging a GitHub issue.\n\n'
        f'Repository: {REPO}\n'
        f"Issue #{issue['number']}: {issue['title']}\n\n"
        'Body (truncated):\n'
        f"{(issue.get('body') or '')[:6000]}\n\n"
        'Existing labels (use ONLY these, max 3): '
        f"{', '.join(repo_labels) if repo_labels else '(none — just summarize)'}\n\n"
        'Return STRICT JSON only, no markdown fences, exactly this shape:\n'
        '{"labels": ["up to 3 label names from the existing list"], '
        '"summary": "1-3 sentences: what is requested, expected vs actual, '
        'key reproduction details if given"}')

    try:
        raw = chat(prompt)
    except Exception as e:
        gh(f'/repos/{REPO}/issues/{ISSUE_NUM}/comments',
           {'body': f'🤖 AI triage unavailable: `{e}`'})
        return 1

    m = re.search(r'\{.*\}', raw, re.S)
    if not m:
        print(f'model returned no JSON object: {raw[:200]!r}', file=sys.stderr)
        return 1
    parsed = json.loads(m.group(0))

    want = [l for l in parsed.get('labels', [])[:MAX_LABELS]
            if isinstance(l, str) and l in repo_labels]
    summary = str(parsed.get('summary', '')).strip()

    if want:
        gh(f'/repos/{REPO}/issues/{ISSUE_NUM}/labels', {'labels': want}, method='POST')

    lines = ['🤖 **AI triage**', '']
    if summary:
        lines += [summary, '']
    if want:
        lines += ['**Labels:** ' + ', '.join(f'`{l}`' for l in want), '']
    lines += ['<sub>AI-generated, may be wrong — maintainers decide. agent-guardrails/ai-review</sub>']
    gh(f'/repos/{REPO}/issues/{ISSUE_NUM}/comments', {'body': '\n'.join(lines)})
    print(f'triage ok: labels={want}')
    return 0


if __name__ == '__main__':
    missing = [v for v in ('GH_TOKEN', 'GITHUB_REPOSITORY', 'ISSUE_NUM') if not os.environ.get(v)]
    if missing:
        print(f'missing env vars: {missing}', file=sys.stderr)
        sys.exit(1)
    if not AI_API_KEY:
        print('AI_API_KEY is not set (org secret missing); skipping', file=sys.stderr)
        sys.exit(1)
    sys.exit(main())
