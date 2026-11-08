#!/usr/bin/env node
import { main } from './pr-review/cli.mjs';
import { collectReview } from './pr-review/collect.mjs';

const code = await main(collectReview, {
  '--repo': { name: 'repo', required: true },
  '--pr': { name: 'pr', required: true },
  '--worktree': { name: 'worktree', required: true },
  '--out': { name: 'out', required: true },
});
process.exitCode = code;
