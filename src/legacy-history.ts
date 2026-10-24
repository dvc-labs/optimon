import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HISTORY_LIMIT, isHistoryPoint, type HistoryPoint } from './history.js';
export const MAX_HISTORY_BYTES = 1024 * 1024;
function invalidFile(): Error {
  return Object.assign(new Error('Invalid legacy history.'), { name: 'InvalidHistoryFile' });
}
function copyPoint({ at, cpu, memory, temperature }: HistoryPoint): HistoryPoint {
  return { at, cpu, memory, temperature };
}
export async function readLegacyHistory(path: string): Promise<HistoryPoint[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!file) {
    return [];
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_HISTORY_BYTES) throw invalidFile();
    // Read at most the cap plus one byte, even if a file grows after stat().
    const buffer = Buffer.alloc(MAX_HISTORY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_HISTORY_BYTES) throw invalidFile();
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.toString('utf8', 0, length));
    } catch {
      throw invalidFile();
    }
    if (typeof decoded !== 'object' || decoded === null) throw invalidFile();
    const data = decoded as Record<string, unknown>;
    if (
      data.version !== 1 ||
      !Array.isArray(data.points) ||
      data.points.length > HISTORY_LIMIT ||
      !data.points.every(isHistoryPoint)
    )
      throw invalidFile();
    return data.points.map(copyPoint);
  } finally {
    await file.close();
  }
}
