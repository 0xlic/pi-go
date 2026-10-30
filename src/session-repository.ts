import { access } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizePath } from "./path-utils.ts";

export async function listSessions(currentSessionDir: string, extraDirs: string[], signal?: AbortSignal): Promise<SessionInfo[]> {
  // listAll(customDir) reads flat JSONL storage; listAll() discovers default project subdirectories.
  const infos = await SessionManager.listAll(undefined, signal);
  // Also scan the root itself: older/custom stores may keep JSONL files flat.
  const dirs = new Set([join(getAgentDir(), "sessions"), currentSessionDir, ...extraDirs].map(dir => normalizePath(dir)));
  for (const dir of dirs) {
    signal?.throwIfAborted();
    try { await access(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" &&
          (dir === normalizePath(currentSessionDir) || dir === normalizePath(join(getAgentDir(), "sessions")))) continue;
      throw new Error(`无法读取会话目录：${dir}`);
    }
    infos.push(...await SessionManager.listAll(dir, undefined, signal));
  }
  return [...new Map(infos.map(info => [normalizePath(info.path), info])).values()];
}
