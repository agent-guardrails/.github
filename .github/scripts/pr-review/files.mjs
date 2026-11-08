import { open, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeExclusive(filePath, content) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicFile(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeExclusive(temporary, content);
    await rename(temporary, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function freshStage(output) {
  const stage = `${output}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await mkdir(stage, { recursive: false, mode: 0o700 });
  return stage;
}

export async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}
