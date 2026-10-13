import { copyToClipboard, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCatalog, projectEntries } from "./catalog.ts";
import { inspectCatalogAvailability } from "./catalog-availability.ts";
import { MetadataStore } from "./metadata-store.ts";
import { normalizePath } from "./path-utils.ts";
import { executeAction } from "./session-gateway.ts";
import { compareEntries } from "./sort.ts";
import { listSessions } from "./session-repository.ts";
import type { GoAction } from "./types.ts";
import { GoSelector } from "./ui/go-selector.ts";
import { loadWithProgress } from "./ui/load-with-progress.ts";

export interface RuntimeGuard { active: boolean; startupConsumed: boolean }

export async function openGo(ctx: ExtensionCommandContext, store: MetadataStore, guard: RuntimeGuard): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("pi-go 仅支持交互式终端模式", "warning"); return; }
  if (guard.active) { ctx.ui.notify("pi-go 已经打开", "info"); return; }
  guard.active = true;
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
    });
    if (!loaded) return;
    const cwd = normalizePath(ctx.cwd);
    let { metadata } = loaded;
    const { infos, availability } = loaded;
    // Only discovered files become selectable sessions; do not revive a deleted current file.
    const catalog = () => buildCatalog(infos, metadata, cwd, availability);
    const action = await ctx.ui.custom<GoAction | null>((tui, theme, kb, done) => new GoSelector(tui, theme, kb, catalog(), cwd, {
      pinProject: async (id, pinned) => { metadata = await store.patchProject(id, { pinned, pinOrder: undefined }); return catalog(); },
      pinSession: async (key, pinned) => { metadata = await store.patchSession(key, { pinned, pinOrder: undefined }); return catalog(); },
      rename: async (id, alias) => { metadata = await store.patchProject(id, { alias }); return catalog(); },
      copyPath: copyToClipboard,
      movePin: async (kind, key, neighbor) => {
        const current = catalog();
        const fallback = kind === "project"
          ? projectEntries(current).filter(p => p.pinned).sort((a, b) => compareEntries(a, b) || a.id.localeCompare(b.id)).map(p => p.id)
          : [...current.sessions.values()].filter(s => s.pinned).sort((a, b) => compareEntries(a, b) || a.key.localeCompare(b.key)).map(s => s.key);
        metadata = await store.movePinned(kind, key, neighbor, fallback);
        return catalog();
      },
    }, done));
    if (!action) return;
    await executeAction(ctx, action, store);
    // Do not use ctx after session replacement.
  } finally {
    guard.active = false;
  }
}
