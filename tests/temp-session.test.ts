import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerTemp } from "../src/temp-session.ts";
import { createDirectory, deleteWorkspace, parseTimestamp, planCleanup, startupConflict, temporaryRoot } from "../src/temp-workspaces.ts";
import { cleanTemporary } from "../src/temp-cleanup.ts";
import { createSessionFile } from "../src/session-gateway.ts";
import { MetadataStore } from "../src/metadata-store.ts";

test("temporary command exposes only /temp and writes JSONL in the default store", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-temp-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  registerTemp({ registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command), on: () => {} } as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["temp"]);
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
  await commands.get("temp")!.handler("", ctx);
  assert.ok(targetFile);
  await assert.rejects(readFile(targetFile));
  await assert.rejects(readdir(targetCwd));
  assert.equal(startupConflict(["--session=x"]), true);
  assert.equal(startupConflict(["--", "--resume"]), false);
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
  assert.ok(parseTimestamp(workspace.split("/").at(-1)!));
  assert.equal(parseTimestamp("2026-02-31_00-00-00"), undefined);
  const seed = await createSessionFile(workspace);
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
  await assert.rejects(readdir(workspace));
  assert.equal((await store.read()).sessions[seed.path], undefined);
  const path = join(temporaryRoot(), "2025-01-01_00-00-00");
  await mkdir(path);
  const plan = await planCleanup(temporaryRoot(), null, []);
  await rm(path, { recursive: true });
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "safe");
  await symlink(outside, path);
  await assert.rejects(deleteWorkspace(plan.root, plan.directories[0]));
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "safe");
});
