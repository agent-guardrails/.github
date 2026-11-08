import { createRunner } from './runner.mjs';
import { errorRecord, ReviewError, redact } from './errors.mjs';

export function parseArgs(argv, definition) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const spec = definition[flag];
    if (!spec || Object.hasOwn(result, spec.name)) throw new ReviewError('invalid-input', `Unknown or duplicate argument: ${flag}`);
    if (spec.boolean) result[spec.name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ReviewError('invalid-input', `Missing value for ${flag}`);
      result[spec.name] = value;
      index += 1;
    }
  }
  for (const spec of Object.values(definition)) {
    if (spec.required && result[spec.name] === undefined) throw new ReviewError('invalid-input', `Missing --${spec.name}`);
  }
  return result;
}

export async function main(operation, definition, dependencies = {}) {
  try {
    const args = parseArgs(dependencies.argv ?? process.argv.slice(2), definition);
    const result = await operation(args, {
      run: dependencies.run ?? createRunner(),
      now: dependencies.now ?? (() => new Date()),
    });
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const record = errorRecord(error);
    (dependencies.stderr ?? process.stderr).write(`${redact(error?.message ?? error)}\n`);
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(record)}\n`);
    return 1;
  }
}
