import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { inspectCatalogAvailability } from "../src/catalog-availability.ts";
import { buildCatalog } from "../src/catalog.ts";
import { emptyMetadata } from "../src/metadata-store.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-go-availability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current"), removed = join(root, "removed"), file = join(root, "session.jsonl");
  await mkdir(current);
  return { root, current, removed, file };
}
function info(path: string, cwd: string): SessionInfo {
  return { path, cwd, id: "id", name: "temporary session", created: new Date(1), modified: new Date(2),
    messageCount: 1, firstMessage: "hello", allMessagesText: "" };
}

test("deleted project and session remain hidden despite registered, alias, pin and visit metadata", async t => {
  const { current, removed, file } = await fixture(t);
  const meta = emptyMetadata();
  meta.projects[removed] = { registered: true, pinned: true, alias: "temp", lastUsedAt: 123 };
  meta.sessions[file] = { pinned: true, lastUsedAt: 123 };
  const before = JSON.stringify(meta);
  const infos = [info(file, removed)];
  const catalog = buildCatalog(infos, meta, current, await inspectCatalogAvailability(infos, meta, current));
  assert.equal(catalog.projects.has(removed), false);
  assert.equal(catalog.sessions.size, 0);
  assert.equal(catalog.pinnedSessionsGroup, undefined);
  assert.equal(catalog.projects.has(current), true);
  assert.equal(JSON.stringify(meta), before);
});

test("missing cwd hides its sessions even when the global JSONL file still exists", async t => {
  const { current, removed, file } = await fixture(t);
  await writeFile(file, "preserve transcript");
  const infos = [info(file, removed)], meta = emptyMetadata();
  meta.sessions[file] = { pinned: true };
  const catalog = buildCatalog(infos, meta, current, await inspectCatalogAvailability(infos, meta, current));
  assert.equal(catalog.sessions.size, 0);
  assert.equal(catalog.projects.has(removed), false);
  assert.equal(catalog.pinnedSessionsGroup, undefined);
});

test("only existing session files are selectable; existing registered project can remain without sessions", async t => {
  const { current, file } = await fixture(t), meta = emptyMetadata();
  meta.projects[current] = { registered: true };
  const infos = [info(file, current)];
  let catalog = buildCatalog(infos, meta, current, await inspectCatalogAvailability(infos, meta, current));
  assert.equal(catalog.sessions.size, 0);
  assert.equal(catalog.projects.has(current), true);
  await writeFile(file, "transcript");
  catalog = buildCatalog(infos, meta, current, await inspectCatalogAvailability(infos, meta, current));
  assert.equal(catalog.sessions.size, 1);
  await rm(file);
  catalog = buildCatalog(infos, meta, current, await inspectCatalogAvailability(infos, meta, current));
  assert.equal(catalog.sessions.size, 0);
});

test("deleted current cwd is not injected; remounted project retains its original metadata", async t => {
  const { current, removed } = await fixture(t), meta = emptyMetadata();
  meta.projects[removed] = { registered: true, pinned: true, alias: "saved alias", pinOrder: 2 };
  let catalog = buildCatalog([], meta, removed, await inspectCatalogAvailability([], meta, removed));
  assert.equal(catalog.projects.has(removed), false);
  await mkdir(removed);
  catalog = buildCatalog([], meta, current, await inspectCatalogAvailability([], meta, current));
  assert.equal(catalog.projects.get(removed)?.name, "saved alias");
  assert.equal(catalog.projects.get(removed)?.pinOrder, 2);
});

test("files cannot masquerade as project directories; cancellation is propagated", async t => {
  const { current, removed } = await fixture(t), meta = emptyMetadata();
  await writeFile(removed, "not a directory");
  meta.projects[removed] = { registered: true };
  const catalog = buildCatalog([], meta, current, await inspectCatalogAvailability([], meta, current));
  assert.equal(catalog.projects.has(removed), false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(inspectCatalogAvailability([], meta, current, abort.signal), { name: "AbortError" });
});
