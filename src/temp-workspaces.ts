import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPathWithin, samePath } from "./path-utils.ts";

export const temporaryRoot = () => join(getAgentDir(), "temp-sessions");
const pad = (n: number) => String(n).padStart(2, "0");
export function timestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
export function parseTimestamp(name: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!match) return;
  const [y, m, d, h, min, s] = match.slice(1).map(Number);
  const date = new Date(y, m - 1, d, h, min, s);
  return timestamp(date) === name ? date : undefined;
}
export async function createDirectory(root = temporaryRoot()): Promise<string> {
  await mkdir(root, { recursive: true });
  await access(root, constants.W_OK | constants.X_OK);
  while (true) {
    const now = new Date();
    const path = join(root, timestamp(now));
    try { await mkdir(path); return path; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await stat(path)).isDirectory()) throw new Error(`已有同名文件：${path}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000 - now.getMilliseconds()));
  }
}
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Resolve existing ancestors too, e.g. macOS /var -> /private/var,
    // so missing workspaces compare correctly with the canonical temp root.
    const absolute = resolve(path);
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonical(parent), basename(absolute));
  }
}
export const cleanupRanges = [
  { label: "最近一天（24小时）", days: 1 }, { label: "最近一周（7天）", days: 7 },
  { label: "最近一个月（30天）", days: 30 }, { label: "最近一年（365天）", days: 365 },
  { label: "所有临时会话", days: null },
];
export interface Workspace { path: string; dev: number; ino: number }
export async function planCleanup(root: string, days: number | null, protectedPaths: string[], now = new Date()) {
  if (!cleanupRanges.some(range => range.days === days)) throw new Error("无效的清理范围");
  const directories: Workspace[] = [];
  let skippedActive = 0;
  const resolved = await canonical(root);
  const protectedCanonical = await Promise.all(protectedPaths.map(canonical));
  const entries = await readdir(resolved, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const date = parseTimestamp(entry.name);
    if (!date || (days !== null && (date.getTime() < now.getTime() - days * 86400000 || date > now))) continue;
    const path = join(resolved, entry.name);
    if (protectedCanonical.some(p => isPathWithin(p, path))) { skippedActive++; continue; }
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) directories.push({ path, dev: info.dev, ino: info.ino });
  }
  return { root: resolved, directories, skippedActive };
}
export async function deleteWorkspace(root: string, directory: Workspace): Promise<void> {
  if (!samePath(dirname(directory.path), root) || !parseTimestamp(basename(directory.path)) || !samePath(await realpath(root), root)) {
    throw new Error("清理根目录或工作区已发生变化");
  }
  const info = await lstat(directory.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev || info.ino !== directory.ino) {
    throw new Error("工作区已发生变化，跳过删除");
  }
  await rm(directory.path, { recursive: true });
}
