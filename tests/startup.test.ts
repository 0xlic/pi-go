import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerStartup } from "../src/startup-adapter.ts";

function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const sent: unknown[] = [];
  const api = { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
    getFlag: () => true, sendUserMessage: (...args: unknown[]) => sent.push(args) } as unknown as ExtensionAPI;
  const ctx = { mode: "tui" } as ExtensionContext;
  return { api, handlers, sent, ctx };
}

test("startup dispatch occurs outside lifecycle, once across replacement and reload", async () => {
  const h = harness(), guard = { active: false, startupConsumed: false };
  registerStartup(h.api, guard);
  h.handlers.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.sent, []);
  await sleep(10);
  assert.deepEqual(h.sent, [["/go", { expandPromptTemplates: true }]]);
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

test("RPC does not open a terminal custom component", async () => {
  const h = harness(), messages: string[] = [];
  registerStartup(h.api, { active: false, startupConsumed: false });
  h.handlers.get("session_start")!({}, { mode: "rpc", hasUI: true, ui: { notify: (s: string) => messages.push(s) } } as unknown as ExtensionContext);
  await sleep(10); assert.equal(h.sent.length, 0); assert.equal(messages.length, 1);
});
