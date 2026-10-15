import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MetadataStore } from "../src/metadata-store.ts";
import { createSessionFile, executeAction as executeWithClipboard } from "../src/session-gateway.ts";

// Never modify the developer's clipboard in automated tests.
const executeAction: typeof executeWithClipboard = (ctx, action, store, copy = async () => {}) =>
  executeWithClipboard(ctx, action, store, copy);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-go-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a"), b = join(root, "b"), storage = join(root, "storage");
  await Promise.all([mkdir(a), mkdir(b)]);
  return { root, a, b, storage, store: new MetadataStore(join(root, "state.json")) };
}

test("public Pi snapshot opens with correct cwd and no model messages; subsequent messages append", async t => {
  const { b, storage } = await fixture(t);
  const seed = await createSessionFile(b, storage);
  const restored = SessionManager.open(seed.path);
  assert.equal(restored.getCwd(), b);
  assert.deepEqual(restored.buildSessionContext().messages, []);
  assert.equal(restored.getEntries()[0]?.type, "custom");
  restored.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  assert.equal(SessionManager.open(seed.path).buildSessionContext().messages.length, 1);
  assert.equal((await SessionManager.list(b, storage)).length, 1);
});

test("cancelled cross-directory creation removes only its seed and records no visit", async t => {
  const { a, b, storage, store } = await fixture(t);
  const manager = SessionManager.create(a, storage);
  const ctx = { cwd: a, sessionManager: manager, switchSession: async () => ({ cancelled: true }) } as unknown as ExtensionCommandContext;
  const copied: string[] = [];
  await executeAction(ctx, { kind: "create", cwd: b }, store, async cwd => { copied.push(cwd); });
  assert.deepEqual(copied, []);
  assert.deepEqual(await readdir(storage), []);
  assert.deepEqual((await store.read()).projects, {});
});

test("successful cross-directory creation uses fresh context and records destination", async t => {
  const { a, b, storage, store } = await fixture(t);
  const manager = SessionManager.create(a, storage);
  let stale = false;
  const ctx = {
    get cwd() { assert.equal(stale, false); return a; },
    get sessionManager() { assert.equal(stale, false); return manager; },
    switchSession: async (path: string, options: { withSession: (ctx: ExtensionCommandContext) => Promise<void> }) => {
      const freshManager = SessionManager.open(path);
      stale = true;
      await options.withSession({ cwd: b, sessionManager: freshManager, ui: { notify: () => {} } } as unknown as ExtensionCommandContext);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  const copied: string[] = [];
  await executeAction(ctx, { kind: "create", cwd: b }, store, async cwd => { copied.push(cwd); });
  assert.deepEqual(copied, [b]);
  const state = await store.read();
  assert.equal(state.projects[b].registered, true);
  assert.equal(Object.keys(state.sessions).length, 1);
  await access(Object.keys(state.sessions)[0]);
});

test("same-directory creation copies only after success, not cancellation", async t => {
  const { a, storage, store } = await fixture(t);
  const copied: string[] = [];
  const manager = SessionManager.create(a, storage);
  let cancelled = true;
  const fresh = { cwd: a, sessionManager: manager, ui: { notify: () => {} } } as unknown as ExtensionCommandContext;
  const ctx = { ...fresh, newSession: async (options: { withSession: (ctx: ExtensionCommandContext) => Promise<void> }) => {
    if (!cancelled) await options.withSession(fresh);
    return { cancelled };
  } } as unknown as ExtensionCommandContext;
  const copy = async (cwd: string) => { copied.push(cwd); };
  await executeAction(ctx, { kind: "create", cwd: a }, store, copy);
  assert.deepEqual(copied, []);
  cancelled = false;
  await executeAction(ctx, { kind: "create", cwd: a }, store, copy);
  assert.deepEqual(copied, [a]);
});

test("restore copies destination cwd, not session path; clipboard failure only warns", async t => {
  const { a, b, storage, store } = await fixture(t);
  const manager = SessionManager.create(a, storage);
  const seed = await createSessionFile(b, storage);
  const warnings: string[] = [], copied: string[] = [];
  const fresh = { cwd: b, sessionManager: SessionManager.open(seed.path),
    ui: { notify: (message: string) => warnings.push(message) } } as unknown as ExtensionCommandContext;
  const ctx = { cwd: a, sessionManager: manager,
    switchSession: async (_path: string, options: { withSession: (ctx: ExtensionCommandContext) => Promise<void> }) => {
      await options.withSession(fresh);
      return { cancelled: false };
    } } as unknown as ExtensionCommandContext;
  await executeAction(ctx, { kind: "restore", path: seed.path }, store, async cwd => { copied.push(cwd); });
  assert.deepEqual(copied, [b]);
  await executeAction(ctx, { kind: "restore", path: seed.path }, store, async () => { throw new Error("unavailable"); });
  assert.match(warnings[0], /项目目录复制失败/);
  assert.equal((await store.read()).projects[b].registered, true);
});

test("current session is a no-op restore; missing/empty/malformed targets cannot switch", async t => {
  const { a, root, storage, store } = await fixture(t);
  const manager = SessionManager.create(a, storage);
  let switches = 0;
  const ctx = { cwd: a, sessionManager: manager, ui: { notify: () => {} }, switchSession: async () => { switches++; return { cancelled: false }; } } as unknown as ExtensionCommandContext;
  const copied: string[] = [];
  await executeAction(ctx, { kind: "restore", path: manager.getSessionFile()! }, store, async cwd => { copied.push(cwd); });
  assert.deepEqual(copied, [a]);
  assert.equal(switches, 0);
  for (const text of ["", "garbage", '{"type":"custom","id":"abc","timestamp":"now"}\n']) {
    const path = join(root, "bad.jsonl"); await writeFile(path, text);
    await assert.rejects(executeAction(ctx, { kind: "restore", path }, store));
    assert.equal(await readFile(path, "utf8"), text);
  }
  assert.equal(switches, 0);
});
