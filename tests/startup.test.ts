import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerStartup } from "../src/startup-adapter.ts";
import type { RuntimeGuard } from "../src/controller.ts";

function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const sent: unknown[] = [];
  const api = { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
    getFlag: (name: string) => name === "g", sendUserMessage: (...args: unknown[]) => sent.push(args) } as unknown as ExtensionAPI;
  const ctx = { mode: "tui" } as ExtensionContext;
  return { api, handlers, sent, ctx };
}

test("startup dispatch occurs outside lifecycle; only an opened selector consumes intent", async () => {
  const h = harness(), guard = { active: false, startupConsumed: false };
  registerStartup(h.api, guard);
  h.handlers.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.sent, []);
  await sleep(10);
  assert.deepEqual(h.sent, [["/go __pi_go_startup:1", { expandPromptTemplates: true }]]);
  assert.equal(guard.startupConsumed, false);
  guard.startupConsumed = true; // Controller marks this only after constructing the selector.
  h.handlers.get("session_start")!({}, h.ctx);
  registerStartup(h.api, guard); h.handlers.get("session_start")!({}, h.ctx);
  await sleep(10); assert.equal(h.sent.length, 1);
});

test("shutdown cancels pending startup dispatch", async () => {
  const h = harness(); registerStartup(h.api, { active: false, startupConsumed: false });
  h.handlers.get("session_start")!({}, h.ctx);
  h.handlers.get("session_shutdown")!({}, h.ctx);
  await sleep(10); assert.equal(h.sent.length, 0);
});

test("replacement retries unconsumed intent and aborts the previous runtime task", async () => {
  const guard: RuntimeGuard = { active: false, startupConsumed: false };
  const first = harness();
  registerStartup(first.api, guard);
  first.handlers.get("session_start")!({}, first.ctx);
  const oldTask = guard.startupTask!;
  await sleep(10);
  assert.equal(guard.startupConsumed, false);
  guard.active = true;
  guard.activeOwner = oldTask;
  first.handlers.get("session_shutdown")!({}, first.ctx);
  assert.equal(oldTask.controller.signal.aborted, true);
  assert.equal(guard.active, false);

  // An intermediate runtime is replaced even before its timer dispatches.
  const second = harness();
  registerStartup(second.api, guard);
  second.handlers.get("session_start")!({}, second.ctx);
  second.handlers.get("session_shutdown")!({}, second.ctx);
  const third = harness();
  registerStartup(third.api, guard);
  third.handlers.get("session_start")!({}, third.ctx);
  await sleep(10);
  assert.equal(second.sent.length, 0);
  assert.deepEqual(third.sent, [["/go __pi_go_startup:3", { expandPromptTemplates: true }]]);
  assert.equal(guard.startupTask?.controller.signal.aborted, false);
  third.handlers.get("session_shutdown")!({}, third.ctx);
});

test("RPC does not open a terminal custom component", async () => {
  const h = harness(), messages: string[] = [];
  registerStartup(h.api, { active: false, startupConsumed: false });
  h.handlers.get("session_start")!({}, { mode: "rpc", hasUI: true, ui: { notify: (s: string) => messages.push(s) } } as unknown as ExtensionContext);
  await sleep(10); assert.equal(h.sent.length, 0); assert.equal(messages.length, 1);
});
