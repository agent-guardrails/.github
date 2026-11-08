#!/usr/bin/env node
import { main } from './pr-review/cli.mjs';
import { syncReview } from './pr-review/sync.mjs';

const code = await main(syncReview, {
  '--repo': { name: 'repo', required: true },
  '--pr': { name: 'pr', required: true },
  '--worktree': { name: 'worktree', required: true },
  '--head': { name: 'head' },
});
process.exitCode = code;
