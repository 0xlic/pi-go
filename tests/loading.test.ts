import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { initTheme, type ExtensionCommandContext, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { loadWithProgress } from "../src/ui/load-with-progress.ts";
import { openGo, type RuntimeGuard, type StartupTask } from "../src/controller.ts";
import type { MetadataStore } from "../src/metadata-store.ts";

initTheme("dark", false);
function fixture(cancel = false) {
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
  const tui = { requestRender: () => {} } as TUI;
  const ctx = { ui: { custom: (factory: Parameters<ExtensionUIContext["custom"]>[0]) => new Promise<unknown>((resolve, reject) => {
    let component: Component & { dispose?: () => void };
    Promise.resolve(factory(tui, theme, {} as never, value => { component.dispose?.(); resolve(value); })).then(c => {
      component = c;
      if (cancel) setImmediate(() => c.handleInput?.("\x1b"));
    }, reject);
  }) } } as unknown as ExtensionCommandContext;
  return ctx;
}

test("loading completes or propagates errors and disposes spinner", async () => {
  assert.equal(await loadWithProgress(fixture(), async () => 42), 42);
  await assert.rejects(loadWithProgress(fixture(), async () => { throw new Error("scan failed"); }), /scan failed/);
});

test("shutdown while waiting for idle does not access stale ctx or clear a new task's guard", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let stale = false;
  let staleAccesses = 0;
  const base = fixture();
  const ctx = new Proxy({ ...base, mode: "tui", waitForIdle: () => { started(); return waiting; } }, {
    get(target, key) {
      if (stale) { staleAccesses++; throw new Error("stale ctx"); }
      return Reflect.get(target, key);
    },
  }) as ExtensionCommandContext;
  const task: StartupTask = { id: 1, controller: new AbortController() };
  const guard: RuntimeGuard = { active: false, startupConsumed: false };
  const old = openGo(ctx, {} as MetadataStore, guard, task);
  await entered;
  task.controller.abort();
  stale = true;
  const newOwner = {};
  guard.activeOwner = newOwner;
  guard.active = true;
  await old;
  release();
  await sleep(10);
  assert.equal(staleAccesses, 0);
  assert.equal(guard.startupConsumed, false);
  assert.equal(guard.active, true);
  assert.equal(guard.activeOwner, newOwner);
});

test("metadata loading that finishes after replacement never reads the old session manager", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const metadata = new Promise(resolve => { release = () => resolve({}); });
  let sessionReads = 0;
  const ctx = { ...fixture(), mode: "tui", waitForIdle: async () => {},
    get sessionManager() { sessionReads++; throw new Error("stale session manager"); },
  } as unknown as ExtensionCommandContext;
  const store = { read: () => { started(); return metadata; } } as unknown as MetadataStore;
  const task: StartupTask = { id: 1, controller: new AbortController() };
  const guard: RuntimeGuard = { active: false, startupConsumed: false };
  const running = openGo(ctx, store, guard, task);
  await entered;
  task.controller.abort();
  await running;
  release();
  await sleep(10);
  assert.equal(sessionReads, 0);
  assert.equal(guard.startupConsumed, false);
});

test("external cancellation ignores late loading failures", async () => {
  const abort = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let fail!: (error: Error) => void;
  const result = loadWithProgress(fixture(), async () => {
    started();
    return new Promise<number>((_resolve, reject) => { fail = reject; });
  }, abort.signal);
  await entered;
  abort.abort();
  assert.equal(await result, undefined);
  fail(new Error("late scan failure"));
  await sleep(10);
});

test("loading cancellation returns immediately while pending work receives abort signal", async () => {
  let aborted = false;
  const result = await loadWithProgress(fixture(true), async signal => {
    await sleep(20);
    aborted = signal.aborted;
    signal.throwIfAborted();
    return 42;
  });
  assert.equal(result, undefined);
  await sleep(30);
  assert.equal(aborted, true);
});
