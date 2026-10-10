import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { KeybindingsManager, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { buildCatalog } from "../src/catalog.ts";
import { MetadataStore } from "../src/metadata-store.ts";
import { compareEntries } from "../src/sort.ts";
import { GoSelector } from "../src/ui/go-selector.ts";

const info = (id: string, cwd: string, time: number): SessionInfo => ({ path: `/s/${id}`, cwd, id, name: id,
  modified: new Date(time), created: new Date(1), messageCount: 0, firstMessage: "", allMessagesText: "" });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-go-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MetadataStore(join(dir, "state.json"));
  for (const [id, time] of [["/work/a", 30], ["/work/b", 20], ["/work/c", 10]] as const) {
    await store.patchProject(id, { pinned: true, lastUsedAt: time });
  }
  for (const [id, time] of [["/s/a", 30], ["/s/b", 20], ["/s/c", 10]] as const) {
    await store.patchSession(id, { pinned: true, lastUsedAt: time });
  }
  const infos = [info("a", "/work/a", 30), info("b", "/work/b", 20), info("c", "/work/a", 10), info("ordinary", "/work/a", 100)];
  let metadata = await store.read();
  const catalog = () => buildCatalog(infos, metadata, "/work/a");
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as Theme;
  let moves = 0;
  const selector = new GoSelector({ requestRender: () => {}, terminal: { rows: 24 } } as Pick<TUI, "requestRender" | "terminal">,
    theme, { matches: () => false } as unknown as KeybindingsManager, catalog(), "/work/a", {
      pinProject: async (id, pinned) => { metadata = await store.patchProject(id, { pinned, pinOrder: undefined }); return catalog(); },
      pinSession: async (key, pinned) => { metadata = await store.patchSession(key, { pinned, pinOrder: undefined }); return catalog(); },
      rename: async () => catalog(), copyPath: async () => {},
      movePin: async (kind, key, neighbor) => {
        moves++;
        const current = catalog();
        const keys = kind === "project"
          ? [...current.projects.values()].filter(p => p.pinned).sort(compareEntries).map(p => p.id)
          : [...current.sessions.values()].filter(s => s.pinned).sort(compareEntries).map(s => s.key);
        metadata = await store.movePinned(kind, key, neighbor, keys);
        return catalog();
      },
    }, () => { throw new Error("Reordering must not close the picker"); });
  const settled = async () => {
    const deadline = Date.now() + 2000;
    while (selector.render(100).join("\n").includes("保存 / 加载中") && Date.now() < deadline) await sleep(5);
    assert.match(selector.render(100).join("\n"), /置顶顺序已保存/);
  };
  return { selector, store, infos, settled, moves: () => moves };
}

const projects = (selector: GoSelector) => selector.vm.projectRows.flatMap(row => row.kind === "project" ? [row.id] : []);
const sessions = (selector: GoSelector) => selector.vm.sessionRows.flatMap(row => row.kind === "session" ? [row.key] : []);

test("Alt+Down/Up reorders pinned projects, preserving selection, queries and visits across restart", async t => {
  const f = await fixture(t);
  f.selector.vm.sessionQuery = "kept";
  f.selector.handleInput("\x1b[1;3B"); await f.settled();
  assert.deepEqual(projects(f.selector), ["/work/b", "/work/a", "/work/c"]);
  assert.equal(f.selector.vm.project?.id, "/work/a");
  assert.equal(f.selector.vm.sessionQuery, "kept");
  const state = await f.store.read();
  assert.equal(state.projects["/work/a"].lastUsedAt, 30);
  const reopened = buildCatalog(f.infos, state, "/work/a");
  assert.deepEqual([...reopened.projects.values()].sort(compareEntries).map(p => p.id), ["/work/b", "/work/a", "/work/c"]);
  f.selector.handleInput("\x1b[1;3A"); await f.settled();
  assert.deepEqual(projects(f.selector), ["/work/a", "/work/b", "/work/c"]);
});

test("project session scope swaps visible pins without moving the hidden global pin", async t => {
  const f = await fixture(t);
  f.selector.vm.activePane = "sessions";
  f.selector.vm.move(1); // /s/a, with /s/b belonging to another project.
  f.selector.handleInput("\x1b[1;3B"); await f.settled();
  assert.deepEqual(sessions(f.selector), ["/s/c", "/s/a", "/s/ordinary"]);
  assert.equal(f.selector.vm.session?.key, "/s/a");
  const state = await f.store.read();
  assert.equal(state.sessions["/s/b"].pinOrder, 1);
  assert.equal(state.sessions["/s/a"].lastUsedAt, 30);
  f.selector.vm.selectProject({ kind: "all" });
  assert.deepEqual(sessions(f.selector), ["/s/c", "/s/b", "/s/a", "/s/ordinary"]);
});

test("filtered project pins swap only visible neighbors; boundaries and ordinary rows do not write", async t => {
  const f = await fixture(t);
  await f.store.patchProject("/work/a", { alias: "visible-a" });
  await f.store.patchProject("/work/c", { alias: "visible-c" });
  f.selector.vm.catalog = buildCatalog(f.infos, await f.store.read(), "/work/a");
  f.selector.vm.setQuery("visible");
  f.selector.handleInput("\x1b[1;3B"); await f.settled();
  assert.equal((await f.store.read()).projects["/work/b"].pinOrder, 1);
  assert.equal(f.selector.vm.projectQuery, "visible");
  assert.deepEqual(projects(f.selector), ["/work/c", "/work/a"]);
  const before = f.moves();
  f.selector.handleInput("\x1b[1;3B");
  assert.equal(f.moves(), before);
  assert.match(f.selector.render(100).join("\n"), /最后一个可见置顶/);
  f.selector.vm.activePane = "sessions";
  f.selector.vm.selectedSession = { kind: "session", key: "/s/ordinary" };
  f.selector.handleInput("\x1b[1;3A");
  assert.equal(f.moves(), before);
  assert.match(f.selector.render(100).join("\n"), /只能移动已 pin/);
  f.selector.vm.selectedSession = { kind: "new" };
  f.selector.handleInput("\x1b[1;3B");
  assert.equal(f.moves(), before);
});

test("manual order wins over later visits; normal entries retain recency sorting", async t => {
  const f = await fixture(t);
  await f.store.movePinned("project", "/work/a", "/work/b", ["/work/a", "/work/b", "/work/c"]);
  await f.store.visit("/work/a", "/s/a", 10000);
  const catalog = buildCatalog(f.infos, await f.store.read(), "/work/a");
  assert.deepEqual([...catalog.projects.values()].sort(compareEntries).map(p => p.id), ["/work/b", "/work/a", "/work/c"]);
  await f.store.patchProject("/work/a", { pinned: false, pinOrder: undefined });
  await assert.rejects(f.store.movePinned("project", "/work/a", "/work/b", []), /只能移动已 pin/);
});
