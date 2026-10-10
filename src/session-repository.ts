import { access } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizePath } from "./path-utils.ts";

export async function listSessions(currentSessionDir: string, extraDirs: string[], signal?: AbortSignal): Promise<SessionInfo[]> {
  // listAll(customDir) reads flat JSONL storage; listAll() discovers default project subdirectories.
  const infos = await SessionManager.listAll(undefined, signal);
  const dirs = new Set([currentSessionDir, ...extraDirs].map(dir => normalizePath(dir)));
  dirs.delete(normalizePath(join(getAgentDir(), "sessions")));
  for (const dir of dirs) {
    signal?.throwIfAborted();
    try { await access(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir === normalizePath(currentSessionDir)) continue;
      throw new Error(`无法读取会话目录：${dir}`);
    }
    infos.push(...await SessionManager.listAll(dir, undefined, signal));
  }
  return infos;
}
