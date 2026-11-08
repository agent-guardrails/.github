#!/usr/bin/env node
import { main } from './pr-review/cli.mjs';
import { publishReview } from './pr-review/publish.mjs';

const code = await main(publishReview, {
  '--bundle': { name: 'bundle', required: true },
  '--findings': { name: 'findings', required: true },
  '--confirm': { name: 'confirm', boolean: true },
});
process.exitCode = code;
