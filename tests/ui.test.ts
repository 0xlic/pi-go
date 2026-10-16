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
  const deleted: string[] = [];
  const callbacks: SelectorCallbacks = {
    pinProject: async (id, pinned) => { meta.projects[id] = { ...meta.projects[id], pinned }; return catalog(); },
    pinSession: async (id, pinned) => { meta.sessions[id] = { ...meta.sessions[id], pinned }; return catalog(); },
    rename: async (id, alias) => { meta.projects[id] = { ...meta.projects[id], alias }; return catalog(); },
    copyPath: async cwd => { copied.push(cwd); },
    movePin: async () => catalog(),
    deleteSession: async key => { deleted.push(`session:${key}`); const result = catalog(); result.sessions.delete(key); return result; },
    deleteProject: async id => { deleted.push(`project:${id}`); const result = catalog(); result.projects.delete(id); result.sessions.clear(); return result; },
    deleteFolder: async cwd => { deleted.push(`folder:${cwd}`); return catalog(); },
  };
  const selector = new GoSelector({ requestRender: () => {}, terminal: { rows: 24 } } as Pick<TUI, "requestRender" | "terminal">,
    theme, kb, catalog(), "/work/a", callbacks, action => actions.push(action));
  selector.focused = true;
  return { selector, actions, copied, deleted, callbacks };
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

test("only the focused pane shows a search cursor and selection background", () => {
  const { selector } = fixture();
  const assertFocus = (pane: "projects" | "sessions" | null) => {
    const lines = selector.render(100);
    const screen = lines.join("\n");
    assert.equal(screen.split("\x1b[7m").length - 1, pane ? 1 : 0);
    assert.equal(screen.split(CURSOR_MARKER).length - 1, pane ? 1 : 0);
    assert.equal(screen.split("\x1b[44m").length - 1, pane ? 1 : 0);
    if (pane) {
      for (const token of [CURSOR_MARKER, "\x1b[44m"]) {
        const line = lines.find(line => line.includes(token))!;
        const column = visibleWidth(line.slice(0, line.indexOf(token)));
        const rightStart = 2 + Math.floor((100 - 7) * 0.44) + 3;
        assert.equal(column < rightStart, pane === "projects");
      }
    }
  };
  assertFocus("projects");
  selector.handleInput("\t");
  assertFocus("sessions");
  selector.handleInput("中文");
  assertFocus("sessions");
  selector.handleInput("\t");
  assertFocus("projects");
  assert.match(selector.render(100).join("\n"), /会话 › 中文/);
  selector.focused = false;
  assertFocus(null);
  selector.focused = true;
  assertFocus("projects");
});

test("Tab preserves queries, project change clears session input; Enter restores selected session", () => {
  const { selector, actions } = fixture();
  selector.handleInput("\t"); selector.handleInput("中文");
  assert.equal(selector.vm.sessionQuery, "中文");
  selector.handleInput("\x1b[Z"); assert.equal(selector.vm.sessionQuery, "中文");
  selector.handleInput("\x1b[A"); assert.equal(selector.vm.sessionQuery, "");
  selector.handleInput("\t"); selector.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "restore", path: "/s/a" }]);
});

test("Enter on a filtered project creates directly; Tab then Enter restores without Down", () => {
  const create = fixture();
  create.selector.handleInput("/work/a");
  assert.match(create.selector.render(100).join("\n"), /Enter 新建会话/);
  assert.doesNotMatch(create.selector.render(100).join("\n"), /Enter 恢复会话/);
  create.selector.handleInput("\r");
  assert.deepEqual(create.actions, [{ kind: "create", cwd: "/work/a" }]);

  const restore = fixture();
  restore.selector.handleInput("/work/a");
  restore.selector.handleInput("\t");
  assert.equal(restore.selector.vm.session?.key, "/s/a");
  assert.match(restore.selector.render(100).join("\n"), /Enter 恢复会话/);
  assert.doesNotMatch(restore.selector.render(100).join("\n"), /Enter 新建会话/);
  restore.selector.handleInput("\r");
  assert.deepEqual(restore.actions, [{ kind: "restore", path: "/s/a" }]);
  assert.doesNotMatch(restore.selector.render(100).join("\n"), /＋ 新建会话/);
});

test("projects without sessions keep focus on the left and only offer creation", () => {
  const { selector, actions } = fixture();
  selector.vm.catalog.sessions.clear();
  selector.vm.refresh();
  for (const key of ["\t", "\x1b[Z"]) {
    selector.handleInput(key);
    assert.equal(selector.vm.activePane, "projects");
  }
  const screen = selector.render(100).join("\n");
  assert.match(screen, /Enter 新建会话/);
  assert.doesNotMatch(screen, /Tab 切换|Enter 恢复会话/);
  assert.equal(screen.split(CURSOR_MARKER).length - 1, 1);
  selector.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "create", cwd: "/work/a" }]);
});

test("removing all sessions returns focus to projects", () => {
  const { selector } = fixture();
  selector.handleInput("\t");
  selector.vm.catalog.sessions.clear();
  selector.vm.refresh();
  assert.equal(selector.vm.activePane, "projects");
});

test("Enter on empty session results does not create; left pane still creates", () => {
  const { selector, actions } = fixture();
  selector.handleInput("\t");
  selector.handleInput("missing-session");
  selector.handleInput("\r");
  assert.deepEqual(actions, []);
  assert.equal(selector.vm.session, undefined);
  assert.equal(selector.vm.activePane, "sessions");
  assert.match(selector.render(100).join("\n"), /无匹配会话/);
  assert.doesNotMatch(selector.render(100).join("\n"), /Enter 恢复会话|Enter 新建会话/);
  selector.handleInput("\t"); selector.handleInput("\r");
  assert.deepEqual(actions, [{ kind: "create", cwd: "/work/a" }]);
});

test("Enter on all projects opens directory form; pinned group enters sessions", () => {
  const { selector, actions } = fixture();
  selector.vm.selectProject({ kind: "all" });
  selector.handleInput("\r");
  assert.match(selector.render(100).join("\n"), /选择目录/);
  assert.deepEqual(actions, []);
  selector.handleInput("\x1b");
  selector.vm.catalog.sessions.get("/s/a")!.pinned = true;
  // The group is normally rebuilt by the pin callback.
  selector.vm.catalog.pinnedSessionsGroup = { id: "pi-go:pinned-sessions", name: "【置顶会话】", pinned: true, lastUsedAt: 1, searchFields: [] };
  selector.vm.selectProject({ kind: "pinned-sessions" });
  selector.handleInput("\r");
  assert.equal(selector.vm.activePane, "sessions");
  selector.handleInput("\r");
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

test("typing a unique project hides all-project row and Tab immediately searches its sessions", () => {
  const { selector } = fixture();
  selector.vm.selectProject({ kind: "all" });
  selector.handleInput("/work/a");
  assert.deepEqual(selector.vm.projectRows, [{ kind: "project", id: "/work/a" }]);
  assert.equal(selector.vm.project?.cwd, "/work/a");
  assert.doesNotMatch(selector.render(100).join("\n"), /所有项目/);
  selector.handleInput("\t"); selector.handleInput("中文");
  assert.equal(selector.vm.sessionRows.length, 1);
});

test("Ctrl+D requires confirmation for sessions and defaults to no", async () => {
  const { selector, deleted, actions } = fixture();
  selector.handleInput("\t"); selector.handleInput("\x04");
  assert.match(selector.render(100).join("\n"), /确认删除会话/);
  selector.handleInput("\r");
  assert.deepEqual(deleted, []);
  selector.handleInput("\x04"); selector.handleInput("\x1b");
  assert.deepEqual(deleted, []);
  selector.handleInput("\x04"); selector.handleInput("\t"); selector.handleInput("\r");
  await sleep(5);
  assert.deepEqual(deleted, ["session:/s/a"]);
  assert.deepEqual(actions, []);
  assert.equal(selector.vm.session, undefined);
  assert.equal(selector.vm.activePane, "projects");
});

test("project deletion asks separately about folder; Enter defaults to retaining it", async () => {
  for (const removeFolder of [false, true]) {
    const { selector, deleted } = fixture();
    selector.handleInput("\x04");
    assert.match(selector.render(100).join("\n"), /全部 1 个会话/);
    selector.handleInput("\t"); selector.handleInput("\r");
    // Repeated Enter during the asynchronous operation cannot accept the next dialog.
    selector.handleInput("\r");
    await sleep(5);
    assert.deepEqual(deleted, ["project:/work/a"]);
    assert.match(selector.render(100).join("\n"), /永久删除项目文件夹/);
    assert.match(selector.render(100).join("\n"), /\[否\]/);
    for (const width of [54, 80, 120]) assert.ok(selector.render(width).every(line => visibleWidth(line) <= width));
    if (removeFolder) selector.handleInput("\t");
    selector.handleInput("\r");
    await sleep(5);
    assert.deepEqual(deleted, removeFolder ? ["project:/work/a", "folder:/work/a"] : ["project:/work/a"]);
  }
});

test("virtual project groups cannot be deleted", () => {
  for (const kind of ["all", "pinned-sessions", "temporary-sessions"] as const) {
    const { selector, deleted } = fixture();
    selector.vm.selectedProject = { kind };
    selector.handleInput("\x04");
    const screen = selector.render(100).join("\n");
    assert.match(screen, /虚拟分组不能删除/);
    assert.doesNotMatch(screen, /Ctrl\+D 删除|确认删除/);
    assert.deepEqual(deleted, []);
  }
});

test("deletion errors are visible and do not advance to folder deletion", async () => {
  const { selector, deleted, callbacks } = fixture();
  callbacks.deleteProject = async () => { throw new Error("拒绝删除"); };
  selector.handleInput("\x04"); selector.handleInput("\t"); selector.handleInput("\r");
  await sleep(5);
  assert.match(selector.render(100).join("\n"), /拒绝删除/);
  assert.doesNotMatch(selector.render(100).join("\n"), /永久删除项目文件夹/);
  assert.deepEqual(deleted, []);
});

test("empty project results render zero counts and Enter cannot create or restore", () => {
  const { selector, actions } = fixture();
  selector.handleInput("missing-project");
  selector.handleInput("\x1b[B"); selector.handleInput("\r");
  selector.handleInput("\t"); selector.handleInput("\x1b[B"); selector.handleInput("\r");
  assert.deepEqual(actions, []);
  const screen = selector.render(100).join("\n");
  assert.match(screen, /无匹配项目/);
  assert.match(screen, /0 个项目/);
  assert.match(screen, /0 个会话/);
  assert.doesNotMatch(screen, /新建会话|所有项目/);
});
