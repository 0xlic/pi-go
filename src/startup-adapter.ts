import { homedir } from "node:os";
import { samePath } from "./path-utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeGuard, StartupTask } from "./controller.ts";

// The argument identifies deferred commands from an obsolete runtime.
export const STARTUP_ARGUMENT = "__pi_go_startup:";

export function registerStartup(pi: ExtensionAPI, guard: RuntimeGuard): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let task: StartupTask | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Decide once from the initial runtime; --g always takes precedence over Home.
    guard.startupAction ??= pi.getFlag("g") ? "panel"
      : ctx.mode === "tui" && samePath(ctx.cwd, homedir()) ? "temporary" : "none";
    if (guard.startupAction === "none" || guard.startupConsumed || task) return;
    if (ctx.mode !== "tui") {
      if (guard.startupAction === "panel") {
        if (ctx.hasUI) ctx.ui.notify("--g 只支持交互式终端模式", "warning");
        else console.error("pi-go: --g 只支持交互式终端模式");
      }
      return;
    }
    // Retain intent across replacements, but never retain a runtime's pi or ctx.
    task = { id: guard.startupSequence = (guard.startupSequence ?? 0) + 1, controller: new AbortController(),
      action: guard.startupAction };
    guard.startupTask = task;
    const scheduled = task;
    timer = setTimeout(() => {
      timer = undefined;
      if (!scheduled.controller.signal.aborted) {
        pi.sendUserMessage(`/go ${STARTUP_ARGUMENT}${scheduled.id}`, { expandPromptTemplates: true });
      }
    }, 0);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    task?.controller.abort();
    if (guard.startupTask === task) guard.startupTask = undefined;
    if (task && guard.activeOwner === task) {
      guard.active = false;
      guard.activeOwner = undefined;
    }
    task = undefined;
  });
}
