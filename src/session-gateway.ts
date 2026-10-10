import { open, readFile, stat, unlink } from "node:fs/promises";
import { parseSessionEntries, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertDirectory, normalizePath } from "./path-utils.ts";
import type { MetadataStore } from "./metadata-store.ts";
import type { GoAction } from "./types.ts";

/** Materialize Pi's own public snapshot, without fabricated user messages or private persistence APIs. */
export async function createSessionFile(cwd: string, sessionDir?: string): Promise<{ path: string; snapshot: string }> {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendCustomEntry("pi-go-created", { version: 1 });
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  if (!path || !header) throw new Error("Pi 没有生成可持久化的 session");
  const snapshot = [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(snapshot); await file.sync(); }
  catch (error) { await file.close(); await unlink(path).catch(() => undefined); throw error; }
  await file.close();
  return { path, snapshot };
}

async function discardUnused(seed: { path: string; snapshot: string }): Promise<void> {
  // Only remove our exact untouched seed, never a session modified by another process.
  if (await readFile(seed.path, "utf8").catch(() => undefined) === seed.snapshot) await unlink(seed.path).catch(() => undefined);
}

export async function executeAction(ctx: ExtensionCommandContext, action: GoAction, store: MetadataStore): Promise<void> {
  const remember = async (fresh: ExtensionCommandContext) => {
    try {
      const path = fresh.sessionManager.getSessionFile();
      await store.visit(normalizePath(fresh.cwd), path ? normalizePath(path) : undefined);
    } catch (error) {
      fresh.ui.notify(`已切换，但访问记录未保存：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };
  if (action.kind === "restore") {
    const path = normalizePath(action.path);
    const current = ctx.sessionManager.getSessionFile();
    if (current && normalizePath(current) === path) { await remember(ctx); return; }
    const fileInfo = await stat(path);
    if (!fileInfo.isFile() || fileInfo.size === 0) throw new Error("目标 session 为空或不是文件");
    const header = parseSessionEntries(await readFile(path, "utf8")).find(entry => entry.type === "session");
    if (!header || typeof header.cwd !== "string" || !header.cwd) throw new Error("session 缺少有效 cwd，不能安全恢复");
    const target = SessionManager.open(path);
    await assertDirectory(target.getCwd());
    await ctx.switchSession(path, { withSession: remember });
    return; // Old ctx is invalid on success.
  }
  const cwd = normalizePath(action.cwd);
  await assertDirectory(cwd);
  if (cwd === normalizePath(ctx.cwd)) {
    await ctx.newSession({ withSession: remember });
    return;
  }
  const currentFile = ctx.sessionManager.getSessionFile();
  if (!currentFile) throw new Error("当前为临时会话；跨目录新建需要持久化 session，请重新启动 Pi（不使用 --no-session）");
  // Preserve an explicitly configured flat session store, otherwise use the target project's default store.
  // Supplying cwdOverride also works when the current empty session has not been written yet.
  const currentManager = SessionManager.open(currentFile, undefined, ctx.cwd);
  const sessionDir = currentManager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
  const seed = await createSessionFile(cwd, sessionDir);
  let accepted = false;
  try {
    const result = await ctx.switchSession(seed.path, { withSession: async fresh => {
      accepted = true;
      await remember(fresh);
    } });
    if (result.cancelled) await discardUnused(seed);
  } catch (error) {
    if (!accepted) await discardUnused(seed);
    throw error;
  }
}
