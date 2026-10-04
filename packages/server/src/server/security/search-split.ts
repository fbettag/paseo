import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_NAMES = new Set([
  ".git",
  ".next",
  ".paseo",
  "build",
  "coverage",
  "dist",
  "findings",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const MAX_SLICES = 64;
const MAX_DEPTH = 3;

interface SliceEntry {
  relativePath: string;
  isDirectory: boolean;
}

export function searchRoots(scopes: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (scope.startsWith("engagements/")) continue;
    const name = scope.replace(/\/$/, "");
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    roots.push(name);
  }
  return roots;
}

export function partitionSearchPaths(
  paths: readonly string[],
  workerCount: number,
  random: () => number = Math.random,
): string[][] {
  const count = Math.max(0, Math.floor(workerCount));
  const buckets: string[][] = [];
  for (let index = 0; index < count; index += 1) buckets.push([]);
  if (count === 0 || paths.length === 0) return buckets;
  const shuffled = shuffle(paths, random);
  for (let index = 0; index < shuffled.length; index += 1) {
    const path = shuffled[index];
    const bucket = buckets[index % count];
    if (path && bucket) bucket.push(path);
  }
  return buckets;
}

export async function listSearchSlices(
  root: string,
  scopes: readonly string[],
  workerCount: number,
): Promise<string[]> {
  if (workerCount < 2) return [];
  const roots = searchRoots(scopes);
  if (roots.length === 0) return [];
  let current: SliceEntry[] = roots.map((relativePath) => ({
    relativePath,
    isDirectory: true,
  }));
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const children = await listSliceChildren(root, current);
    if (children.length === 0 || samePaths(children, current)) break;
    current = children;
    if (children.length >= workerCount) break;
  }
  const paths = current.map((entry) => entry.relativePath);
  if (paths.length < 2) return [];
  return paths.slice(0, MAX_SLICES);
}

function shuffle(paths: readonly string[], random: () => number): string[] {
  const next = [...paths];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = next[index];
    const swap = next[swapIndex];
    if (current === undefined || swap === undefined) continue;
    next[index] = swap;
    next[swapIndex] = current;
  }
  return next;
}

async function listSliceChildren(
  root: string,
  parents: readonly SliceEntry[],
): Promise<SliceEntry[]> {
  const groups = await Promise.all(parents.map((parent) => childrenOf(root, parent)));
  const children: SliceEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      children.push(entry);
      if (children.length >= MAX_SLICES) return children;
    }
  }
  return children;
}

async function childrenOf(root: string, parent: SliceEntry): Promise<SliceEntry[]> {
  if (!parent.isDirectory) return [parent];
  const entries = await readSliceDir(join(root, parent.relativePath));
  if (entries.length === 0) return [parent];
  return entries.map((entry) => ({
    relativePath: `${parent.relativePath}/${entry.name}`,
    isDirectory: entry.isDirectory,
  }));
}

async function readSliceDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const kept: { name: string; isDirectory: boolean }[] = [];
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      kept.push({ name: entry.name, isDirectory: entry.isDirectory() });
    }
    return kept.toSorted((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function samePaths(left: readonly SliceEntry[], right: readonly SliceEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.relativePath !== right[index]?.relativePath) return false;
  }
  return true;
}
