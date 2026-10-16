import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../src/catalog.ts";
import { emptyMetadata } from "../src/metadata-store.ts";
import { isTemporaryPath, normalizePath } from "../src/path-utils.ts";
import { ViewModel } from "../src/ui/view-model.ts";

const root = normalizePath("~/.pi/agent/pi-temp-sessions");
function info(path: string, cwd: string): SessionInfo {
  return { path, cwd, id: path, name: "临时任务", created: new Date(1), modified: new Date(2),
    messageCount: 0, firstMessage: "", allMessagesText: "" };
}

test("temporary paths use directory boundaries", () => {
  assert.ok(isTemporaryPath(root));
  assert.ok(isTemporaryPath(root + "/2026-01-01"));
  assert.equal(isTemporaryPath(root + "-other/2026-01-01"), false);
});

test("temporary sessions aggregate below all projects without dated project entries", () => {
  const cwd = root + "/2026-01-01";
  const meta = emptyMetadata();
  meta.projects[cwd] = { pinned: true, alias: "旧临时项目", registered: true };
  meta.sessions["/sessions/temp"] = { pinned: true };
  const infos = [info("/sessions/temp", cwd), info(root + "/stored.jsonl", "/work/a"), info("/sessions/normal", "/work/a")];
  const catalog = buildCatalog(infos, meta, cwd);
  assert.deepEqual([...catalog.projects.keys()], ["/work/a"]);
  const vm = new ViewModel(catalog, cwd);
  assert.deepEqual(vm.projectRows.slice(0, 2), [{ kind: "all" }, { kind: "temporary-sessions" }]);
  assert.equal(vm.selectedProject.kind, "temporary-sessions");
  assert.equal(vm.sessionRows.length, 2);
  assert.equal(catalog.sessions.get("/sessions/temp")?.cwd, cwd);
  vm.setQuery("2026-01-01");
  assert.equal(vm.projectRows.length, 0);
  vm.setQuery("临时会话");
  assert.deepEqual(vm.projectRows, [{ kind: "temporary-sessions" }]);
  vm.selectProject({ kind: "project", id: "/work/a" });
  vm.setQuery("");
  vm.selectProject({ kind: "pinned-sessions" });
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/sessions/temp" }]);
  vm.catalog = buildCatalog([], meta, "/work/a");
  vm.refresh();
  assert.equal(vm.catalog.temporarySessionsGroup, undefined);
  assert.ok(!vm.projectRows.some(row => row.kind === "temporary-sessions"));
});

test("stale or unavailable temporary sessions do not create a virtual group", () => {
  const cwd = root + "/old";
  const meta = emptyMetadata();
  meta.projects[cwd] = { registered: true };
  const catalog = buildCatalog([info("/missing", cwd)], meta, cwd, {
    projectPaths: new Set([cwd]), sessionPaths: new Set(),
  });
  assert.equal(catalog.projects.size, 0);
  assert.equal(catalog.temporarySessionsGroup, undefined);
});
