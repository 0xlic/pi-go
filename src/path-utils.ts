import { stat } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

export function normalizePath(path: string, base = process.cwd()): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
  return resolve(base, expanded);
}

export function isPathWithin(path: string, directory: string, platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  // Fold only comparison keys on Windows; preserve stored and displayed paths.
  const comparisonKey = (value: string) => {
    const normalized = paths.resolve(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const root = comparisonKey(directory);
  const normalized = comparisonKey(path);
  return normalized === root || normalized.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep);
}

export function isTemporaryPath(path: string): boolean {
  return isPathWithin(normalizePath(path), resolve(getAgentDir(), "pi-temp-sessions"))
    || isPathWithin(normalizePath(path), normalizePath("~/.pi/agent/pi-temp-sessions"));
}

// Never allow transcript names or filesystem paths to inject terminal controls.
export function safeText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

export function aliasFromInput(text: string): string | undefined {
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) throw new Error("项目名称不能包含换行或控制字符");
  return text.trim() || undefined;
}

export async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => { throw new Error(`目录不存在或无法访问：${safeText(path)}`); });
  if (!info.isDirectory()) throw new Error(`不是目录：${safeText(path)}`);
}
