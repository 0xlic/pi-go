import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createDirectory, deleteWorkspace, parseTimestamp, planCleanup, temporaryRoot } from "../src/temp-workspaces.ts";
import { cleanTemporary } from "../src/temp-cleanup.ts";
import { createSessionFile, executeAction } from "../src/session-gateway.ts";
import { MetadataStore } from "../src/metadata-store.ts";
import piGo from "../index.ts";

test("temporary action writes JSONL in the default store and cleans up cancellation", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-temp-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  let targetFile = "", targetCwd = "";
  const ctx = {
    waitForIdle: async () => {}, ui: { notify: () => {} },
    switchSession: async (path: string) => {
      targetFile = path;
      targetCwd = JSON.parse((await readFile(path, "utf8")).split("\n")[0]).cwd;
      assert.ok(targetCwd.startsWith(temporaryRoot()));
      assert.ok(path.startsWith(join(root, "sessions")));
      assert.deepEqual(await readdir(targetCwd), []);
      return { cancelled: true };
    },
  } as unknown as ExtensionCommandContext;
  await executeAction(ctx, { kind: "create-temporary" }, new MetadataStore(join(root, "state.json")), async () => {});
  assert.ok(targetFile);
  await assert.rejects(readFile(targetFile));
  await assert.rejects(readdir(targetCwd));
});

test("only go is registered as a command", () => {
  const commands: string[] = [];
  piGo({ registerCommand: (name: string) => commands.push(name), registerFlag: () => {}, on: () => {} } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["go"]);
});

test("temporary creation records a visit and preserves the accepted session", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-temp-success-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const store = new MetadataStore(join(root, "state.json"));
  let path = "", cwd = "", copied = "";
  const ctx = {
    switchSession: async (file: string, options: { withSession: (fresh: ExtensionCommandContext) => Promise<void> }) => {
      path = file;
      cwd = JSON.parse((await readFile(file, "utf8")).split("\n")[0]).cwd;
      await options.withSession({ cwd, sessionManager: { getSessionFile: () => file }, ui: { notify: () => {} } } as unknown as ExtensionCommandContext);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  await executeAction(ctx, { kind: "create-temporary" }, store, async value => { copied = value; });
  assert.ok(await readFile(path));
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(copied, cwd);
  assert.ok((await store.read()).sessions[path]?.lastUsedAt);
});

test("cleanup protects active workspaces, rejects symlink swaps and deletes external JSONL", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-clean-temp-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createDirectory();
  assert.ok(parseTimestamp(basename(workspace)));
  assert.equal(parseTimestamp("2026-02-31_00-00-00"), undefined);
  assert.equal(basename(temporaryRoot()), "temp-sessions");
  const legacy = join(root, "pi-temp-sessions", "2024-02-01_00-00-00");
  await mkdir(legacy, { recursive: true });
  const legacySeed = await createSessionFile(legacy);
  const legacyOrphan = await createSessionFile(join(root, "pi-temp-sessions", "2024-03-01_00-00-00"));
  const seed = await createSessionFile(workspace);
  // Flat JSONL at the sessions root is not returned by Pi's global scan.
  const flatPath = join(root, "sessions", "flat.jsonl");
  await writeFile(flatPath, await readFile(seed.path));
  const retainedFile = join(dirname(seed.path), "keep.txt");
  await writeFile(retainedFile, "unrelated file");
  const activePlan = await planCleanup(temporaryRoot(), null, [workspace]);
  assert.equal(activePlan.skippedActive, 1);
  const store = new MetadataStore(join(root, "state.json"));
  await store.visit(workspace, seed.path);
  const ctx = {
    cwd: root, sessionManager: { getSessionFile: () => undefined, getSessionDir: () => join(root, "sessions") },
    ui: { select: async () => "所有临时会话", confirm: async () => true, notify: () => {} },
  } as unknown as ExtensionCommandContext;
  await cleanTemporary(ctx, store);
  await assert.rejects(readFile(seed.path));
  await assert.rejects(readFile(legacySeed.path));
  await assert.rejects(readdir(legacy));
  await assert.rejects(readFile(legacyOrphan.path));
  await assert.rejects(readFile(flatPath));
  assert.equal(await readFile(retainedFile, "utf8"), "unrelated file");
  assert.ok(await readdir(join(root, "sessions")));
  await assert.rejects(readdir(workspace));
  assert.equal((await store.read()).sessions[seed.path], undefined);
  // A previous cleanup may already have removed the workspace but left JSONL.
  const orphan = join(temporaryRoot(), "2024-01-01_00-00-00");
  const orphanSeed = await createSessionFile(orphan);
  await store.visit(orphan, orphanSeed.path);
  await cleanTemporary(ctx, store);
  await assert.rejects(readFile(orphanSeed.path));
  await assert.rejects(readdir(dirname(orphanSeed.path)), { code: "ENOENT" });
  assert.equal((await store.read()).sessions[orphanSeed.path], undefined);
  // Active history is protected even when its workspace is absent.
  const activeSeed = await createSessionFile(orphan);
  await cleanTemporary({ ...ctx, cwd: orphan } as ExtensionCommandContext, store);
  assert.ok(await readFile(activeSeed.path));
  await cleanTemporary({ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => activeSeed.path } } as ExtensionCommandContext, store);
  assert.ok(await readFile(activeSeed.path));
  const path = join(temporaryRoot(), "2025-01-01_00-00-00");
  await mkdir(path);
  const plan = await planCleanup(temporaryRoot(), null, []);
  await rm(path, { recursive: true });
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "safe");
  await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(deleteWorkspace(plan.root, plan.directories[0]));
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "safe");
});
