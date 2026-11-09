#!/usr/bin/env node
import { main } from './pr-review/cli.mjs';
import { INSPECT_ARGUMENTS, inspectReview } from './pr-review/inspect.mjs';

const code = await main(inspectReview, INSPECT_ARGUMENTS);
process.exitCode = code;
