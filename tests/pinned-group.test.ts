import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../src/catalog.ts";
import { emptyMetadata } from "../src/metadata-store.ts";
import { ViewModel } from "../src/ui/view-model.ts";

const infos: SessionInfo[] = [
  { path: "/s/a", cwd: "/work/a", id: "a", name: "修复", created: new Date(1), modified: new Date(3), messageCount: 0, firstMessage: "", allMessagesText: "" },
  { path: "/s/b", cwd: "/work/b", id: "b", name: "发布", created: new Date(1), modified: new Date(2), messageCount: 0, firstMessage: "", allMessagesText: "" },
];

test("group appears only when actual sessions are pinned, not stale metadata", () => {
  const meta = emptyMetadata();
  assert.equal(buildCatalog(infos, meta, "/work/a").pinnedSessionsGroup, undefined);
  meta.sessions["/s/missing"] = { pinned: true };
  assert.equal(buildCatalog(infos, meta, "/work/a").pinnedSessionsGroup, undefined);
  meta.sessions["/s/b"] = { pinned: true };
  const vm = new ViewModel(buildCatalog(infos, meta, "/work/a"), "/work/a");
  assert.ok(vm.projectRows.some(row => row.kind === "pinned-sessions"));
  vm.selectProject({ kind: "pinned-sessions" });
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/s/b" }]);
  meta.sessions["/s/b"].pinned = false;
  vm.catalog = buildCatalog(infos, meta, "/work/a"); vm.refresh();
  assert.equal(vm.catalog.pinnedSessionsGroup, undefined);
  assert.equal(vm.selectedProject.kind, "all");
});

test("virtual group is searchable by its name only and right side filters pinned titles globally", () => {
  const meta = emptyMetadata();
  meta.sessions["/s/a"] = { pinned: true };
  meta.sessions["/s/b"] = { pinned: true };
  const vm = new ViewModel(buildCatalog(infos, meta, "/work/a"), "/work/a");
  vm.setQuery("置顶会话");
  assert.deepEqual(vm.projectRows, [{ kind: "pinned-sessions" }]);
  assert.equal(vm.selectedProject.kind, "pinned-sessions");
  vm.togglePane(); vm.setQuery("发布");
  assert.deepEqual(vm.sessionRows, [{ kind: "session", key: "/s/b" }]);
  vm.togglePane(); vm.setQuery("修复");
  assert.deepEqual(vm.projectRows, []);
  assert.equal(vm.selectedProject.kind, "none");
  assert.deepEqual(vm.sessionRows, []);
});
