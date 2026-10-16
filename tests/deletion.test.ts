import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { deleteProjectFolder, deleteSessionFiles } from "../src/deletion.ts";
import { MetadataStore } from "../src/metadata-store.ts";

test("session deletion removes exact files, tolerates missing files and never deletes directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  const dir = join(root, "directory");
  await writeFile(file, "session"); await mkdir(dir);
  await assert.rejects(deleteSessionFiles([file], file), /当前正在使用/);
  assert.equal(await readFile(file, "utf8"), "session");
  await deleteSessionFiles([file, join(root, "missing")]);
  await assert.rejects(access(file));
  await assert.rejects(deleteSessionFiles([dir]));
  await access(dir);
});

test("current session preflight prevents partial project deletion", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [join(root, "one.jsonl"), join(root, "current.jsonl")];
  for (const file of files) await writeFile(file, "keep");
  await assert.rejects(deleteSessionFiles(files, files[1]), /当前正在使用/);
  for (const file of files) await access(file);
});

test("folder deletion is recursive but rejects protected paths, home, root and symlinks", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(join(project, "child"), { recursive: true });
  await writeFile(join(project, "child", "source.ts"), "keep");
  await assert.rejects(deleteProjectFolder(project, [join(project, "child")]), /当前工作目录/);
  await assert.rejects(deleteProjectFolder(homedir(), []), /主目录/);
  await assert.rejects(deleteProjectFolder(parse(root).root, []), /根目录/);
  const link = join(root, "link");
  await symlink(project, link);
  await assert.rejects(deleteProjectFolder(link, []), /符号链接/);
  await access(join(project, "child", "source.ts"));
  await deleteProjectFolder(project, [join(root, "elsewhere")]);
  await assert.rejects(access(project));
});

test("deletion removes project/session metadata and preserves unrelated entries", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MetadataStore(join(root, "state.json"));
  await store.patchProject("/a", { registered: true, pinned: true });
  await store.patchProject("/b", { alias: "keep" });
  await store.patchSession("/s/a", { pinned: true });
  await store.patchSession("/s/b", { pinned: true });
  const state = await store.removeEntries(["/s/a"], "/a");
  assert.equal(state.projects["/a"], undefined);
  assert.equal(state.sessions["/s/a"], undefined);
  assert.equal(state.projects["/b"].alias, "keep");
  assert.equal(state.sessions["/s/b"].pinned, true);
});
