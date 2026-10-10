import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { initTheme, type ExtensionCommandContext, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { loadWithProgress } from "../src/ui/load-with-progress.ts";

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
