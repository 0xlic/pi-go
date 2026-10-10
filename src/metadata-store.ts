import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PINNED_SESSIONS_GROUP_ID, type Metadata, type ProjectMeta, type SessionMeta } from "./types.ts";

export function emptyMetadata(): Metadata {
  return { version: 1, projects: {}, sessions: {} };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validate(value: unknown): Metadata {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.projects) || !isRecord(value.sessions)) {
    throw new Error("pi-go 状态格式或版本不受支持；原文件未修改");
  }
  for (const [section, entries] of [["projects", value.projects], ["sessions", value.sessions]] as const) {
    for (const item of Object.values(entries)) {
      if (!isRecord(item) ||
          (item.pinned !== undefined && typeof item.pinned !== "boolean") ||
          (item.pinOrder !== undefined && (typeof item.pinOrder !== "number" || !Number.isSafeInteger(item.pinOrder) || item.pinOrder < 0)) ||
          (item.lastUsedAt !== undefined && (typeof item.lastUsedAt !== "number" || !Number.isFinite(item.lastUsedAt) || item.lastUsedAt < 0)) ||
          (section === "projects" && ((item.alias !== undefined && typeof item.alias !== "string") ||
          (item.registered !== undefined && typeof item.registered !== "boolean")))) {
        throw new Error("pi-go 状态条目损坏；原文件未修改");
      }
    }
  }
  if (value.pinnedSessionsGroup !== undefined && (!isRecord(value.pinnedSessionsGroup) ||
      (value.pinnedSessionsGroup.pinOrder !== undefined && (typeof value.pinnedSessionsGroup.pinOrder !== "number" ||
      !Number.isSafeInteger(value.pinnedSessionsGroup.pinOrder) || value.pinnedSessionsGroup.pinOrder < 0)))) {
    throw new Error("pi-go 置顶会话分组顺序损坏；原文件未修改");
  }
  if (value.extraSessionDirs !== undefined && (!Array.isArray(value.extraSessionDirs) || value.extraSessionDirs.some(x => typeof x !== "string"))) {
    throw new Error("pi-go extraSessionDirs 必须是路径数组");
  }
  return value as unknown as Metadata;
}
function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

/** Read-modify-write under a cross-process lock; never overwrite an unreadable state. */
export class MetadataStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, private lockTimeoutMs = 2500) {}

  async read(): Promise<Metadata> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) { if (hasCode(error, "ENOENT")) return emptyMetadata(); throw error; }
    try { return validate(JSON.parse(text)); }
    catch (error) { throw new Error(`无法读取 ${this.file}：${error instanceof Error ? error.message : String(error)}`); }
  }

  private update(change: (state: Metadata) => void): Promise<Metadata> {
    const operation = this.queue.then(() => this.lockedUpdate(change));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async lockedUpdate(change: (state: Metadata) => void): Promise<Metadata> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) {
          throw new Error(`pi-go 状态被锁定：${lock}。若进程异常退出，请确认 owner.json 对应进程已结束后手动移除锁目录。`);
        }
        await sleep(25 + Math.random() * 25);
      }
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const owner = await open(join(lock, "owner.json"), "wx", 0o600);
      try { await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      finally { await owner.close(); }
      const state = await this.read();
      change(state);
      validate(state);
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.file);
      return state;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }

  patchProject(id: string, patch: Partial<ProjectMeta>): Promise<Metadata> {
    if (id === PINNED_SESSIONS_GROUP_ID) return Promise.reject(new Error("【置顶会话】不能取消 pin 或重命名"));
    return this.update(s => { s.projects[id] = { ...s.projects[id], ...patch }; });
  }
  patchSession(key: string, patch: Partial<SessionMeta>): Promise<Metadata> {
    return this.update(s => { s.sessions[key] = { ...s.sessions[key], ...patch }; });
  }
  movePinned(kind: "project" | "session", key: string, neighbor: string, fallbackOrder: string[]): Promise<Metadata> {
    return this.update(state => {
      const entries: Record<string, ProjectMeta | SessionMeta> = { ...(kind === "project" ? state.projects : state.sessions) };
      if (kind === "project" && fallbackOrder.includes(PINNED_SESSIONS_GROUP_ID) &&
          Object.values(state.sessions).some(session => session.pinned)) {
        entries[PINNED_SESSIONS_GROUP_ID] = { pinned: true, pinOrder: state.pinnedSessionsGroup?.pinOrder };
      }
      if (!entries[key]?.pinned || !entries[neighbor]?.pinned || key === neighbor) {
        throw new Error("只能移动已 pin 的条目；状态已变化，请重新打开选择器");
      }
      const fallback = new Map(fallbackOrder.map((id, index) => [id, index]));
      const order = Object.keys(entries).filter(id => entries[id].pinned).sort((a, b) => {
        const left = entries[a].pinOrder ?? Infinity, right = entries[b].pinOrder ?? Infinity;
        if (left !== right) return left - right;
        const ai = fallback.get(a) ?? Infinity, bi = fallback.get(b) ?? Infinity;
        return (ai !== bi ? ai - bi : 0) || a.localeCompare(b);
      });
      const from = order.indexOf(key), to = order.indexOf(neighbor);
      [order[from], order[to]] = [order[to], order[from]];
      order.forEach((id, index) => {
        if (kind === "project" && id === PINNED_SESSIONS_GROUP_ID) {
          state.pinnedSessionsGroup = { ...state.pinnedSessionsGroup, pinOrder: index };
        } else if (kind === "project") state.projects[id] = { ...state.projects[id], pinOrder: index };
        else state.sessions[id] = { ...state.sessions[id], pinOrder: index };
      });
    });
  }

  visit(projectId: string, key: string | undefined, time = Date.now()): Promise<Metadata> {
    return this.update(s => {
      s.projects[projectId] = { ...s.projects[projectId], registered: true, lastUsedAt: time };
      if (key) s.sessions[key] = { ...s.sessions[key], lastUsedAt: time };
    });
  }
}
