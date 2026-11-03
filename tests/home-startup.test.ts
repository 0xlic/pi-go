import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piGo from "../index.ts";
import type { RuntimeGuard } from "../src/controller.ts";

test("Home startup command creates a real temporary session without opening the panel", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-home-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const key = Symbol.for("pi-go.runtime-guard.v1");
  const globals = globalThis as typeof globalThis & { [key]?: RuntimeGuard };
  const oldGuard = globals[key];
  delete globals[key];
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldGuard) globals[key] = oldGuard;
    else delete globals[key];
    await rm(root, { recursive: true, force: true });
  });
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionCommandContext) => unknown)[]>();
  let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let dispatched: Promise<void> | undefined;
  let switched = 0;
  let switchedCwd: string | undefined;
  const ctx = {
    cwd: homedir(), mode: "tui", hasUI: true,
    sessionManager: { getSessionFile: () => undefined },
    waitForIdle: async () => {},
    ui: { notify: () => {}, custom: () => { throw new Error("must not open panel"); } },
    switchSession: async (file: string, options: { withSession: (fresh: ExtensionCommandContext) => Promise<void> }) => {
      switched++;
      const manager = SessionManager.open(file);
      switchedCwd = manager.getCwd();
      assert.ok(switchedCwd.startsWith(join(root, "temp-sessions")));
      assert.equal(globals[key]?.startupConsumed, true);
      await options.withSession({ ...ctx, cwd: switchedCwd, sessionManager: manager } as ExtensionCommandContext);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    registerFlag: () => {}, getFlag: () => false,
    registerCommand: (_: string, options: { handler: typeof command }) => { command = options.handler; },
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendUserMessage: (text: string) => { dispatched = command(text.slice("/go ".length), ctx); },
  } as unknown as ExtensionAPI;
  piGo(api);
  for (const handler of handlers.get("session_start")!) await handler({}, ctx);
  for (let i = 0; !dispatched && i < 100; i++) await sleep(10);
  assert.ok(dispatched);
  await dispatched;
  assert.equal(switched, 1);
  assert.notEqual(switchedCwd, homedir());
  assert.equal((await readdir(join(root, "temp-sessions"))).length, 1);
  for (const handler of handlers.get("session_shutdown")!) await handler({}, ctx);
  piGo(api); // Replacement/reload must not create another workspace.
  for (const handler of handlers.get("session_start")!) await handler({}, ctx);
  await sleep(20);
  assert.equal(switched, 1);
});
