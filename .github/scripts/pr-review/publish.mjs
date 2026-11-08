import { verifyBundle } from './bundle.mjs';
import { validateFindings } from './findings.mjs';
import { ghJson, paginate, readPr } from './github.mjs';
import { parseRepository } from './validate.mjs';
import { fail } from './errors.mjs';

const marker = (id) => `<!-- agent-guardrails-pr-review:${id} -->`;

function renderFinding(finding) {
  return [
    `### [${finding.severity}] ${finding.title}`,
    ...(finding.filePath && finding.line === undefined ? [`**File:** \`${finding.filePath}\``] : []),
    finding.explanation,
    `**Remediation:** ${finding.remediation}`,
    finding.blocking ? '**Blocking:** yes' : '**Blocking:** no',
    marker(finding.findingId),
  ].join('\n\n');
}

export function buildPublication(document, existingReviews, existingComments) {
  const existingText = [...existingReviews, ...existingComments].map((item) => item.body ?? '').join('\n');
  const unmarked = document.findings.filter((finding) => !existingText.includes(marker(finding.findingId)));
  const bodyFindings = unmarked.filter((finding) => finding.line === undefined);
  const inline = unmarked.filter((finding) => finding.line !== undefined);
  const bodyParts = [
    '# Agent Guardrails offline PR review',
    `Overall verdict: **${document.overallVerdict}**`,
    ...bodyFindings.map(renderFinding),
  ];
  if (bodyFindings.length === 0) bodyParts.push(inline.length ? 'Inline findings are attached to this COMMENT review.' : 'No unmarked findings remain.');
  return {
    body: bodyParts.join('\n\n'),
    comments: inline.map((finding) => ({
      path: finding.filePath,
      line: finding.line,
      side: finding.diffSide,
      body: renderFinding(finding),
    })),
    findingIds: unmarked.map((finding) => finding.findingId),
  };
}

export async function publishReview(args, dependencies) {
  const bundle = await verifyBundle(args.bundle);
  const findings = await validateFindings(args.findings, bundle);
  const repo = parseRepository(findings.document.repository);
  const pr = findings.document.prNumber;
  const [reviews, comments] = await Promise.all([
    paginate(dependencies.run, repo, `/pulls/${pr}/reviews`, bundle.root),
    paginate(dependencies.run, repo, `/pulls/${pr}/comments`, bundle.root),
  ]);
  const publication = buildPublication(findings.document, reviews, comments);
  let published = false;
  if (args.confirm && publication.findingIds.length > 0) {
    const current = await readPr(dependencies.run, repo, pr, bundle.root);
    if (current.headSha !== bundle.manifest.headSha || current.baseSha !== bundle.manifest.baseSha) fail('stale-head', 'PR changed after bundle collection');
    await ghJson(dependencies.run, repo, `/pulls/${pr}/reviews`, {
      cwd: bundle.root,
      method: 'POST',
      input: { event: 'COMMENT', commit_id: bundle.manifest.headSha, body: publication.body, comments: publication.comments },
    });
    published = true;
  }
  return {
    contractVersion: 1, ok: true, repository: repo.full, prNumber: pr,
    baseSha: bundle.manifest.baseSha, headSha: bundle.manifest.headSha,
    bundle: bundle.root, preview: !args.confirm, published,
    review: { event: 'COMMENT', body: publication.body, comments: publication.comments },
    findingIds: publication.findingIds,
  };
}
