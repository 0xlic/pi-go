import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { buildCatalog } from "../src/catalog.ts";
import { emptyMetadata } from "../src/metadata-store.ts";
import type { GoAction } from "../src/types.ts";
import { GoSelector, type SelectorCallbacks } from "../src/ui/go-selector.ts";

const theme = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[39m`, bg: (_: string, s: string) => `\x1b[44m${s}\x1b[49m`, bold: (s: string) => s } as Theme;
const kb = { matches: () => false } as unknown as KeybindingsManager;
function fixture() {
  const meta = emptyMetadata();
  const catalog = () => buildCatalog([{ path: "/s/a", id: "abc", cwd: "/work/a", name: "中文会话 🚀 " + "很长标题".repeat(30),
    modified: new Date(1), created: new Date(1), messageCount: 0, firstMessage: "", allMessagesText: "" }], meta, "/work/a");
  const actions: (GoAction | null)[] = [];
  const copied: string[] = [];
  const callbacks: SelectorCallbacks = {
    pinProject: async (id, pinned) => { meta.projects[id] = { ...meta.projects[id], pinned }; return catalog(); },
    pinSession: async (id, pinned) => { meta.sessions[id] = { ...meta.sessions[id], pinned }; return catalog(); },
    rename: async (id, alias) => { meta.projects[id] = { ...meta.projects[id], alias }; return catalog(); },
    copyPath: async cwd => { copied.push(cwd); },
  };
  const selector = new GoSelector({ requestRender: () => {}, terminal: { rows: 24 } } as Pick<TUI, "requestRender" | "terminal">,
    theme, kb, catalog(), "/work/a", callbacks, action => actions.push(action));
  selector.focused = true;
  return { selector, actions, copied };
}

test("dual pane rendering fits terminal columns, including ANSI, Chinese and cursor marker", () => {
  const { selector } = fixture();
  for (const width of [54, 80, 120, 200]) {
    const lines = selector.render(width);
    assert.ok(lines.length <= 24);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.equal(lines.join("\n").split(CURSOR_MARKER).length - 1, 1);
  }
  selector.handleInput("\t");
  const lines = selector.render(80);
  assert.equal(lines.join("\n").split(CURSOR_MARKER).length - 1, 1);
  assert.equal(selector.vm.activePane, "sessions");
  assert.ok(selector.render(20).every(line => visibleWidth(line) <= 20));
});

test("Tab preserves queries, project change clears session input; Enter restores selected session", () => {
  const { selector, actions } = fixture();
  selector.handleInput("\t"); selector.handleInput("中文");
  assert.equal(selector.vm.sessionQuery, "中文");
  selector.handleInput("\x1b[Z"); assert.equal(selector.vm.sessionQuery, "中文");
  selector.handleInput("\x1b[A"); assert.equal(selector.vm.sessionQuery, "");
  selector.handleInput("\t"); selector.handleInput("\x1b[B"); selector.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "restore", path: "/s/a" }]);
});

test("pin persists asynchronously and retains selection; rename substep cancels independently", async () => {
  const { selector, actions } = fixture();
  selector.handleInput("\x10"); await sleep(10);
  assert.equal(selector.vm.project?.pinned, true);
  selector.handleInput("\x12");
  assert.match(selector.render(80).join("\n"), /重命名项目/);
  selector.handleInput("\x1b"); assert.deepEqual(actions, []);
  selector.handleInput("\x1b"); assert.deepEqual(actions, [null]);
});

test("Ctrl+Y copies project cwd without opening directory form or closing picker", async () => {
  const { selector, actions, copied } = fixture();
  selector.handleInput("\x19"); await sleep(10);
  assert.deepEqual(copied, ["/work/a"]);
  assert.deepEqual(actions, []);
  assert.match(selector.render(100).join("\n"), /已复制项目目录/);
  assert.doesNotMatch(selector.render(100).join("\n"), /选择目录/);
});

test("global session selection copies its project cwd, never session file path", async () => {
  const { selector, actions, copied } = fixture();
  selector.vm.selectProject({ kind: "all" });
  selector.handleInput("\x19"); await sleep(10);
  assert.deepEqual(copied, []);
  assert.match(selector.render(100).join("\n"), /请先选择具体项目或会话/);
  selector.handleInput("\t"); selector.handleInput("\x1b[B");
  selector.handleInput("\x19"); await sleep(10);
  assert.deepEqual(copied, ["/work/a"]);
  assert.deepEqual(actions, []);
  assert.doesNotMatch(selector.render(100).join("\n"), /\/s\/a/);
});
