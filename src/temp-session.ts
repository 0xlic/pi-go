import { homedir } from "node:os";
import { readFile, rmdir, unlink } from "node:fs/promises";
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { createSessionFile } from "./session-gateway.ts";
import { canonical, createDirectory, startupConflict } from "./temp-workspaces.ts";

export function registerTemp(pi: ExtensionAPI): void {
  let busy = false;
  let startupPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inputs: InputEvent[] = [];
  pi.registerCommand("temp", {
    description: "创建临时工作区并切换到新会话（清理请使用 /go）",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("用法：/temp；清理请在 /go 中选中临时会话后按 Ctrl+K", "error"); return; }
      if (busy) return;
      busy = true;
      let directory: string | undefined;
      let seed: Awaited<ReturnType<typeof createSessionFile>> | undefined;
      let replacementStarted = false;
      try {
        await ctx.waitForIdle();
        directory = await createDirectory();
        // No sessionDir override: JSONL follows Pi's default per-project storage.
        seed = await createSessionFile(directory);
        const target = directory;
        replacementStarted = true;
        const result = await ctx.switchSession(seed.path, { withSession: async fresh => {
          startupPending = false;
          fresh.ui.notify(`已切换到：${target}`, "info");
          for (const input of inputs.splice(0)) {
            await fresh.sendUserMessage([{ type: "text", text: input.text }, ...(input.images ?? [])], { expandPromptTemplates: true });
          }
        } });
        if (result.cancelled) {
          replacementStarted = false;
          ctx.ui.notify("已取消切换，保留原会话。", "info");
        }
      } catch (error) {
        if (replacementStarted) throw error; // The old runtime may already be invalid.
        ctx.ui.notify(`创建临时会话失败：${String(error)}`, "error");
      } finally {
        if (!replacementStarted) {
          if (seed && await readFile(seed.path, "utf8").catch(() => undefined) === seed.snapshot) await unlink(seed.path).catch(() => {});
          if (directory) await rmdir(directory).catch(() => {}); // Never recursively remove user files on cancellation.
        }
        startupPending = false;
        inputs.length = 0;
        busy = false;
      }
    },
  });
  pi.on("input", (event, ctx) => {
    if (!startupPending) return;
    inputs.push(event);
    ctx.ui.notify("正在创建临时会话，输入将在切换后执行。", "info");
    return { action: "handled" };
  });
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || pi.getFlag("g") || startupConflict(process.argv.slice(2))) return;
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (await canonical(ctx.cwd) !== await canonical(homedir())) return;
    startupPending = true;
    timer = setTimeout(() => {
      timer = undefined;
      pi.sendUserMessage("/temp", { expandPromptTemplates: true });
    }, 0);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
}
