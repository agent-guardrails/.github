import { ghRaw, normalizeChangedFiles, paginate, paginateNamed } from './github.mjs';
import { MAX_ARTIFACT_BYTES, MAX_BUNDLE_BYTES } from './bundle.mjs';
import { fail, redact } from './errors.mjs';

function textLog(buffer) {
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString('utf8');
  if (Buffer.from(text).compare(buffer) !== 0 || text.includes('\uFFFD')) return undefined;
  return redact(text);
}

function stateFor(status, conclusion) {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success' || conclusion === 'neutral') return 'available';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'skipped';
  return 'failed';
}

function unavailable(kind, identity, reason) {
  return { kind, identity: String(identity), reason };
}

function runSelection(runItem, evidenceState) {
  return {
    runId: String(runItem.id), url: runItem.html_url,
    state: ['queued', 'in_progress', 'completed'].includes(runItem.status) ? runItem.status : 'unknown',
    ...(runItem.conclusion ? { conclusion: runItem.conclusion } : {}), evidenceState,
  };
}

export async function collectRemoteEvidence(run, repo, pr, headSha, changedFileCount, cwd) {
  const [remoteChangedFiles, reviews, reviewComments, issueComments, checkRuns, checkSuites, runs] = await Promise.all([
    paginate(run, repo, `/pulls/${pr}/files`, cwd, changedFileCount),
    paginate(run, repo, `/pulls/${pr}/reviews`, cwd),
    paginate(run, repo, `/pulls/${pr}/comments`, cwd),
    paginate(run, repo, `/issues/${pr}/comments`, cwd),
    paginateNamed(run, repo, `/commits/${headSha}/check-runs?filter=all`, 'check_runs', cwd),
    paginateNamed(run, repo, `/commits/${headSha}/check-suites`, 'check_suites', cwd),
    paginateNamed(run, repo, `/actions/runs?head_sha=${headSha}`, 'workflow_runs', cwd),
  ]);
  const jobsByRun = [];
  for (const runItem of runs) {
    const jobs = await paginateNamed(run, repo, `/actions/runs/${runItem.id}/jobs?filter=all`, 'jobs', cwd);
    jobsByRun.push({ run: runItem, jobs });
  }
  const selectedCi = [];
  const incomplete = [];
  const logs = {};
  let logBytes = 0;
  const ciRuns = [];
  if (checkRuns.length === 0 && checkSuites.length === 0) incomplete.push(unavailable('check', headSha, 'No check runs or check suites were reported'));
  if (runs.length === 0) incomplete.push(unavailable('ci-run', headSha, 'No workflow runs were reported'));
  for (const { run: runItem, jobs } of jobsByRun) {
    if (jobs.length === 0) {
      incomplete.push(unavailable('ci-run', runItem.id, 'No jobs were reported'));
      selectedCi.push(runSelection(runItem, 'missing'));
    }
    const normalizedJobs = [];
    for (const job of jobs) {
      const evidenceState = stateFor(job.status, job.conclusion);
      let logEvidenceState = job.status === 'completed' ? 'missing' : 'pending';
      const selected = { ...runSelection(runItem, evidenceState), jobId: String(job.id), url: job.html_url };
      if (job.status === 'completed') {
        const response = await ghRaw(run, repo, `/actions/jobs/${job.id}/logs`, { cwd, recoverFailureCodes: ['not-found', 'permission-denied'] });
        const logText = response.code === 0 ? textLog(response.stdout) : undefined;
        if (logText !== undefined) {
          const name = `${runItem.id}-${job.id}.txt`;
          const bytes = Buffer.byteLength(logText);
          if (bytes > MAX_ARTIFACT_BYTES) fail('remote-failure', 'Sanitized CI log exceeds byte limit');
          const nextLogBytes = logBytes + bytes;
          if (nextLogBytes > MAX_BUNDLE_BYTES) fail('remote-failure', 'Sanitized CI logs exceed total byte limit');
          logBytes = nextLogBytes;
          logs[name] = logText;
          selected.logUrl = `https://api.github.com/repos/${repo.full}/actions/jobs/${job.id}/logs`;
          logEvidenceState = 'available';
        } else {
          logEvidenceState = response.failureCode === 'permission-denied' ? 'inaccessible' : 'missing';
          if (selected.evidenceState === 'available') selected.evidenceState = logEvidenceState;
          const reason = response.code === 0 ? 'Log response was not text' : logEvidenceState === 'inaccessible' ? 'Log access is denied' : 'Log unavailable';
          incomplete.push(unavailable('ci-log', job.id, reason));
        }
      } else incomplete.push(unavailable('ci-log', job.id, 'Job is not completed'));
      selectedCi.push(selected);
      normalizedJobs.push({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, html_url: job.html_url, logEvidenceState });
    }
    ciRuns.push({ id: runItem.id, name: runItem.name, status: runItem.status, conclusion: runItem.conclusion, html_url: runItem.html_url, jobs: normalizedJobs });
  }
  for (const check of checkRuns) {
    const state = stateFor(check.status, check.conclusion);
    if (state !== 'available') incomplete.push(unavailable('check', check.id, `${check.status}/${check.conclusion ?? 'none'}`));
  }
  for (const suite of checkSuites) {
    const state = stateFor(suite.status, suite.conclusion);
    if (state !== 'available') incomplete.push(unavailable('check', suite.id, `suite ${suite.status ?? 'unknown'}/${suite.conclusion ?? 'none'}`));
  }
  return {
    changedFiles: normalizeChangedFiles(remoteChangedFiles), reviews, reviewComments, issueComments,
    checks: { checkRuns, checkSuites }, ciRuns, selectedCi, incomplete, logs,
  };
}
