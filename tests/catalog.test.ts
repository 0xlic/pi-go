import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../src/catalog.ts";
import { emptyMetadata } from "../src/metadata-store.ts";
import { aliasFromInput, normalizePath, safeText } from "../src/path-utils.ts";
import { ViewModel } from "../src/ui/view-model.ts";

function info(path: string, cwd: string, name: string, modified: number): SessionInfo {
  return { path, cwd, name, modified: new Date(modified), created: new Date(0), id: path,
    messageCount: 1, firstMessage: "fallback", allMessagesText: "secret body" };
}
const infos = [info("/sessions/a", "/work/a", "修复搜索", 10), info("/sessions/b", "/work/b", "登录流程", 30),
  info("/sessions/c", "/work/a", "插件设计", 20)];

test("project identity, fallback names, aliases and safe display", () => {
  const meta = emptyMetadata(); meta.projects["/work/a"] = { alias: "中文项目" };
  const catalog = buildCatalog([...infos, info("/sessions/other", "/other/a", "", 1)], meta, "/work/a");
  assert.equal(catalog.projects.size, 3);
  assert.equal(catalog.projects.get("/work/a")?.name, "中文项目");
  assert.equal(catalog.sessions.get("/sessions/other")?.name, "fallback");
  assert.equal(safeText("a\x1b[2J\nb"), "a [2J b");
  assert.equal(aliasFromInput("  别名  "), "别名");
  assert.equal(aliasFromInput("  "), undefined);
  assert.throws(() => aliasFromInput("bad\nname"));
  assert.equal(normalizePath("../a/", "/work/b"), "/work/a");
});

test("fixed rows, pin-first recency and filtering of pinned items", () => {
  const meta = emptyMetadata();
  meta.projects["/work/a"] = { pinned: true };
  meta.sessions["/sessions/a"] = { pinned: true };
  const vm = new ViewModel(buildCatalog(infos, meta, "/work/a"), "/work/a");
  assert.deepEqual(vm.projectRows, [{ kind: "all" }, { kind: "project", id: "/work/a" }, { kind: "pinned-sessions" }, { kind: "project", id: "/work/b" }]);
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/sessions/a" }, { kind: "session", key: "/sessions/c" }]);
  vm.activePane = "sessions"; vm.setQuery("插件");
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/sessions/c" }]);
  vm.activePane = "projects"; vm.setQuery("/work/b");
  assert.deepEqual(vm.projectRows, [{ kind: "project", id: "/work/b" }]);
  assert.deepEqual(vm.selectedProject, { kind: "project", id: "/work/b" });
  assert.equal(vm.sessionQuery, "");
});

test("left searches only project paths and aliases; session titles and bodies do not match", () => {
  const meta = emptyMetadata(); meta.projects["/work/a"] = { alias: "My Plugin" };
  const vm = new ViewModel(buildCatalog(infos, meta, "/work/a"), "/work/a");
  for (const query of ["mypl", "/wk/a"]) {
    vm.setQuery(query);
    assert.deepEqual(vm.projectRows, [{ kind: "project", id: "/work/a" }]);
  }
  for (const query of ["修搜", "插件设计", "登录流程", "secret body"]) {
    vm.setQuery(query);
    assert.deepEqual(vm.projectRows, []);
    assert.deepEqual(vm.selectedProject, { kind: "none" });
    assert.deepEqual(vm.sessionRows, []);
  }
  vm.setQuery("");
  vm.selectProject({ kind: "all" });
  vm.activePane = "sessions";
  vm.setQuery("修搜");
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/sessions/a" }]);
});

test("unique filtered project is selected automatically; Tab immediately searches its sessions", () => {
  const vm = new ViewModel(buildCatalog(infos, emptyMetadata(), "/work/a"), "/work/a");
  vm.selectProject({ kind: "all" });
  vm.setQuery("/work/b");
  assert.deepEqual(vm.projectRows, [{ kind: "project", id: "/work/b" }]);
  assert.deepEqual(vm.selectedProject, { kind: "project", id: "/work/b" });
  vm.togglePane(); vm.setQuery("登录");
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/sessions/b" }]);
  vm.togglePane(); assert.equal(vm.sessionQuery, "登录");
  vm.setQuery("/work/a");
  assert.equal(vm.sessionQuery, "");
  vm.activePane = "sessions"; vm.setQuery("插件");
  vm.selectProject({ kind: "project", id: "/work/a" });
  assert.equal(vm.sessionQuery, "插件");
});

test("empty results do not fall back to global sessions; clearing search restores all-project entry", () => {
  const vm = new ViewModel(buildCatalog(infos, emptyMetadata(), "/work/a"), "/work/a");
  vm.setQuery("missing-project");
  assert.deepEqual(vm.projectRows, []);
  assert.deepEqual(vm.selectedProject, { kind: "none" });
  assert.deepEqual(vm.sessionRows, []);
  vm.move(1); vm.togglePane(); vm.move(1); vm.ensureVisible(5);
  assert.equal(vm.projectScroll, 0);
  assert.equal(vm.sessionScroll, 0);
  vm.togglePane(); vm.setQuery("   ");
  assert.deepEqual(vm.projectRows[0], { kind: "all" });
  assert.deepEqual(vm.selectedProject, { kind: "all" });
  vm.togglePane(); vm.setQuery("登录");
  assert.equal(vm.sessionRows.length, 1);
});

test("stable selection after pin reordering and explicit recency wins over file mtime", () => {
  const meta = emptyMetadata(); meta.sessions["/sessions/a"] = { lastUsedAt: 5 };
  meta.projects["/work/a"] = { lastUsedAt: 6 };
  const catalog = buildCatalog(infos, meta, "/work/a");
  assert.equal(catalog.projects.get("/work/a")?.lastUsedAt, 6);
  const vm = new ViewModel(catalog, "/work/a"); vm.activePane = "sessions";
  const selected = vm.selectedSession;
  meta.sessions["/sessions/a"].pinned = true;
  vm.catalog = buildCatalog(infos, meta, "/work/a"); vm.refresh();
  assert.deepEqual(vm.selectedSession, selected);
  vm.ensureVisible(1); assert.equal(vm.sessionScroll, 1);
});
