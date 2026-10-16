import { access } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openGo, type RuntimeGuard } from "./src/controller.ts";
import { MetadataStore } from "./src/metadata-store.ts";
import { registerStartup, STARTUP_ARGUMENT } from "./src/startup-adapter.ts";
import { normalizePath } from "./src/path-utils.ts";

// A replacement or /reload creates a new extension instance; keep only process-level guards here.
const guardKey = Symbol.for("pi-go.runtime-guard.v1");
const globals = globalThis as typeof globalThis & { [guardKey]?: RuntimeGuard };

export default function piGo(pi: ExtensionAPI): void {
  const guard = globals[guardKey] ??= { active: false, startupConsumed: false };
  const store = new MetadataStore(join(getAgentDir(), "pi-go", "state.json"));
  pi.registerFlag("g", { description: "Open the project/session switcher on startup", type: "boolean", default: false });
  pi.registerCommand("go", { description: "切换项目和会话，创建或恢复 session", handler: async (args, ctx) => {
    if (args.startsWith(STARTUP_ARGUMENT)) {
      const task = guard.startupTask;
      if (!task || args !== `${STARTUP_ARGUMENT}${task.id}` || task.controller.signal.aborted || guard.startupConsumed) return;
      await openGo(ctx, store, guard, task);
    } else {
      await openGo(ctx, store, guard);
    }
  } });
  pi.on("session_start", async (_event, ctx) => {
    if (guard.active) return; // /go records replacement visits through its fresh-context callback.
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    try { await access(file); } catch { return; } // Do not mark an unused, unsaved startup session as visited.
    try { await store.visit(normalizePath(ctx.cwd), normalizePath(file)); }
    catch (error) { if (ctx.hasUI) ctx.ui.notify(`pi-go 访问记录未保存：${String(error)}`, "warning"); }
  });
  registerStartup(pi, guard);
}
