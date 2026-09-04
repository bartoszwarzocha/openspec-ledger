/**
 * Filesystem helpers that answer with `undefined` instead of throwing.
 *
 * The extension reads directories it does not own: a change directory can
 * vanish between being listed and being read, and a permission error on one
 * root must not empty the tree.
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export async function statSafe(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}

export async function exists(target: string): Promise<boolean> {
  return (await statSafe(target)) !== undefined;
}

export async function isDirectory(target: string): Promise<boolean> {
  const stats = await statSafe(target);
  return stats?.isDirectory() ?? false;
}

export async function isFile(target: string): Promise<boolean> {
  const stats = await statSafe(target);
  return stats?.isFile() ?? false;
}

/** The stamp a cache is keyed on: modification time and size (design.md D13). */
export async function stamp(target: string): Promise<FileStamp | undefined> {
  const stats = await statSafe(target);
  return stats ? { mtimeMs: stats.mtimeMs, size: stats.size } : undefined;
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function readTextSafe(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

/** Immediate subdirectory names, sorted. Empty when the directory is unreadable. */
export async function listDirectories(target: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Immediate file names, sorted. Empty when the directory is unreadable. */
export async function listFiles(target: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function ensureDirectory(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

/**
 * Write through a sibling temporary file so a crash mid-write cannot leave a
 * half-written history file behind.
 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, contents, 'utf8');
  await fs.rename(temp, target);
}

export async function removeFile(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}
