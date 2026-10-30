import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteProjectFolder, deleteSessionFiles } from "./deletion.ts";
import { copyProjectPath } from "./clipboard.ts";
import { buildCatalog, projectEntries } from "./catalog.ts";
import { inspectCatalogAvailability } from "./catalog-availability.ts";
import { MetadataStore } from "./metadata-store.ts";
import { normalizePath, samePath } from "./path-utils.ts";
import { executeAction } from "./session-gateway.ts";
import { compareEntries } from "./sort.ts";
import { listSessions } from "./session-repository.ts";
import type { GoAction } from "./types.ts";
import { GoSelector } from "./ui/go-selector.ts";
import { loadWithProgress } from "./ui/load-with-progress.ts";

export interface StartupTask { id: number; controller: AbortController }
export interface RuntimeGuard {
  active: boolean;
  startupConsumed: boolean;
  startupTask?: StartupTask;
  startupSequence?: number;
  activeOwner?: object;
}

export async function openGo(ctx: ExtensionCommandContext, store: MetadataStore, guard: RuntimeGuard, startup?: StartupTask): Promise<void> {
  const signal = startup?.controller.signal;
  if (signal?.aborted) return;
  if (ctx.mode !== "tui") { ctx.ui.notify("pi-go 仅支持交互式终端模式", "warning"); return; }
  if (guard.active) { ctx.ui.notify("pi-go 已经打开", "info"); return; }
  const owner = startup ?? {};
  guard.active = true;
  guard.activeOwner = owner;
  try {
    const loaded = await loadWithProgress(ctx, async signal => {
      await ctx.waitForIdle();
      signal.throwIfAborted();
      const metadata = await store.read();
      signal.throwIfAborted();
      const infos = await listSessions(ctx.sessionManager.getSessionDir(), metadata.extraSessionDirs ?? [], signal);
      signal.throwIfAborted();
      const availability = await inspectCatalogAvailability(infos, metadata, ctx.cwd, signal);
      return { metadata, infos, availability };
    }, signal);
    if (signal?.aborted || !loaded) return;
    const cwd = normalizePath(ctx.cwd);
    let { metadata } = loaded;
    let { infos, availability } = loaded;
    const removedProjects = new Set<string>();
    const currentFile = ctx.sessionManager.getSessionFile();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const reload = async () => {
      metadata = await store.read();
      infos = await listSessions(sessionDir, metadata.extraSessionDirs ?? []);
      availability = await inspectCatalogAvailability(infos, metadata, cwd);
    };
    // Only discovered files become selectable sessions; do not revive a deleted current file.
    const catalog = () => {
      const result = buildCatalog(infos, metadata, cwd, availability);
      for (const id of removedProjects) result.projects.delete(id);
      return result;
    };
    const action = await ctx.ui.custom<GoAction | null>((tui, theme, kb, done) => {
      signal?.throwIfAborted();
      const selector = new GoSelector(tui, theme, kb, catalog(), cwd, {
      pinProject: async (id, pinned) => { metadata = await store.patchProject(id, { pinned, pinOrder: undefined }); return catalog(); },
      pinSession: async (key, pinned) => { metadata = await store.patchSession(key, { pinned, pinOrder: undefined }); return catalog(); },
      rename: async (id, alias) => { metadata = await store.patchProject(id, { alias }); return catalog(); },
      copyPath: copyProjectPath,
      deleteSession: async key => {
        if (!catalog().sessions.has(key)) throw new Error("会话已不存在，请重新打开选择器");
        try {
          await deleteSessionFiles([key], currentFile);
          metadata = await store.removeEntries([key]);
        } finally { await reload(); }
        return catalog();
      },
      deleteProject: async id => {
        if (!catalog().projects.has(id)) throw new Error("虚拟分组或不存在的项目不能删除");
        // Rescan all stores, not just the filtered or pinned sessions visible in the UI.
        await reload();
        const keys = infos.filter(info => info.cwd && samePath(info.cwd, id)).map(info => normalizePath(info.path));
        try {
          await deleteSessionFiles(keys, currentFile);
          metadata = await store.removeEntries(keys, id);
          removedProjects.add(id);
        } finally { await reload(); }
        return catalog();
      },
      deleteFolder: async path => {
        if (!removedProjects.has(path)) throw new Error("必须先删除项目会话，再单独确认删除文件夹");
        await deleteProjectFolder(path, [cwd, store.file, ...(currentFile ? [currentFile] : [])]);
        await reload();
        return catalog();
      },
      movePin: async (kind, key, neighbor) => {
        const current = catalog();
        const fallback = kind === "project"
          ? projectEntries(current).filter(p => p.pinned).sort((a, b) => compareEntries(a, b) || a.id.localeCompare(b.id)).map(p => p.id)
          : [...current.sessions.values()].filter(s => s.pinned).sort((a, b) => compareEntries(a, b) || a.key.localeCompare(b.key)).map(s => s.key);
        metadata = await store.movePinned(kind, key, neighbor, fallback);
        return catalog();
      },
      }, done);
      if (startup) guard.startupConsumed = true;
      return selector;
    });
    if (signal?.aborted || !action) return;
    await executeAction(ctx, action, store);
    // Do not use ctx after session replacement.
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    if (guard.activeOwner === owner) {
      guard.active = false;
      guard.activeOwner = undefined;
    }
  }
}
