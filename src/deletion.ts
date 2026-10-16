import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { parse } from "node:path";
import { isPathWithin, normalizePath } from "./path-utils.ts";

/** Never recursively remove a session path (even if it was replaced by a directory). */
export async function deleteSessionFiles(keys: readonly string[], currentFile?: string): Promise<void> {
  if (currentFile && keys.some(key => normalizePath(key) === normalizePath(currentFile))) {
    throw new Error("不能删除当前正在使用的会话；请先切换到其他项目 / 会话");
  }
  for (const key of keys) {
    try { await unlink(key); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Guard critical directories and do not follow a project symlink during recursive deletion. */
export async function deleteProjectFolder(cwd: string, protectedPaths: readonly string[]): Promise<void> {
  const path = normalizePath(cwd);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("为安全起见，不支持删除符号链接项目目录");
  if (!info.isDirectory()) throw new Error("项目路径已不再是文件夹");
  const target = await realpath(path);
  const home = await realpath(homedir());
  if (target === parse(target).root || target === home) throw new Error("不能删除根目录或用户主目录");
  for (const protectedPath of protectedPaths) {
    const resolved = await realpath(protectedPath).catch(() => normalizePath(protectedPath));
    if (isPathWithin(resolved, target)) throw new Error("不能删除包含当前工作目录、当前会话或 pi-go 状态的文件夹");
  }
  await rm(path, { recursive: true, force: false });
}
