import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeGuard, StartupTask } from "./controller.ts";

// The argument identifies deferred commands from an obsolete runtime.
export const STARTUP_ARGUMENT = "__pi_go_startup:";

export function registerStartup(pi: ExtensionAPI, guard: RuntimeGuard): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let task: StartupTask | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!pi.getFlag("g") || guard.startupConsumed || task) return;
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("--g 只支持交互式终端模式", "warning");
      else console.error("pi-go: --g 只支持交互式终端模式");
      return;
    }
    // Retain intent across replacements, but never retain a runtime's pi or ctx.
    task = { id: guard.startupSequence = (guard.startupSequence ?? 0) + 1, controller: new AbortController() };
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
