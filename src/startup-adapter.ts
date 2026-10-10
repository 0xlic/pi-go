import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeGuard } from "./controller.ts";

export function registerStartup(pi: ExtensionAPI, guard: RuntimeGuard): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!pi.getFlag("go") || guard.startupConsumed) return;
    guard.startupConsumed = true; // Shared across reloads and replacement runtimes in this process.
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("--go 只支持交互式终端模式", "warning");
      else console.error("pi-go: --go 只支持交互式终端模式");
      return;
    }
    // Defer beyond the lifecycle callback; command-only session replacement must not be awaited there.
    timer = setTimeout(() => {
      timer = undefined;
      pi.sendUserMessage("/go", { expandPromptTemplates: true });
    }, 0);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
}
