import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MetadataStore } from "../src/metadata-store.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-go-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "state.json") };
}

test("persists aliases, pin and visits; merging does not discard fields", async t => {
  const { file, dir } = await fixture(t), a = new MetadataStore(file), b = new MetadataStore(file);
  await Promise.all([a.patchProject("/a", { alias: "A" }), b.patchProject("/a", { pinned: true }), a.patchSession("/s", { pinned: true })]);
  await b.visit("/a", "/s", 123);
  const state = await new MetadataStore(file).read();
  assert.deepEqual(state.projects["/a"], { alias: "A", pinned: true, registered: true, lastUsedAt: 123 });
  assert.deepEqual(state.sessions["/s"], { pinned: true, lastUsedAt: 123 });
  assert.deepEqual(await readdir(dir), ["state.json"]);
  await a.patchProject("/a", { alias: undefined });
  assert.equal((await a.read()).projects["/a"].alias, undefined);
});

test("corrupt or unknown state is never silently overwritten; lock released on failure", async t => {
  const { file, dir } = await fixture(t), store = new MetadataStore(file);
  for (const text of ["{broken", '{"version":2,"projects":{},"sessions":{}}', '{"version":1,"projects":{"/a":{"pinned":"yes"}},"sessions":{}}']) {
    await writeFile(file, text);
    await assert.rejects(store.patchProject("/a", { pinned: true }));
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(await readdir(dir), ["state.json"]);
  }
});

test("lock timeout does not delete somebody else's lock", async t => {
  const { file } = await fixture(t);
  await mkdir(`${file}.lock`);
  await assert.rejects(new MetadataStore(file, 40).patchProject("/a", { pinned: true }), /状态被锁定/);
  assert.deepEqual(await readdir(`${file}.lock`), []);
});

test("different processes retain independent field updates", async t => {
  const { file } = await fixture(t);
  const child = (id: string) => new Promise<void>((resolve, reject) => {
    const p = fork(new URL("./fixtures/write-state.ts", import.meta.url), [file, id], { execArgv: ["--import", "tsx"], stdio: "pipe" });
    let stderr = ""; p.stderr?.on("data", data => { stderr += data; });
    p.on("error", reject); p.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)));
  });
  await Promise.all([child("/a"), child("/b"), child("/c")]);
  const state = await new MetadataStore(file).read();
  assert.deepEqual(Object.keys(state.projects).sort(), ["/a", "/b", "/c"]);
});
