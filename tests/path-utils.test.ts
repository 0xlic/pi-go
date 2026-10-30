import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSessionFiles } from "../src/deletion.ts";
import { isPathWithin, isTemporaryPath, normalizePath, samePath, temporaryRoots } from "../src/path-utils.ts";

test("home expansion accepts both separator styles", () => {
  assert.equal(normalizePath("~"), homedir());
  assert.equal(normalizePath("~/project"), join(homedir(), "project"));
  assert.equal(normalizePath("~\\project"), join(homedir(), "project"));
});

test("new and legacy temporary roots keep directory boundaries", () => {
  for (const root of temporaryRoots()) {
    assert.ok(isTemporaryPath(join(root, "2026-01-01_00-00-00")));
    assert.equal(isTemporaryPath(root + "-other"), false);
  }
});

test("Windows path equality handles drives, separators, casing and UNC shares", () => {
  assert.ok(samePath("C:\\Users\\Alice\\会话.jsonl", "c:/users/ALICE/会话.jsonl", "win32"));
  assert.ok(samePath("\\\\server\\share\\Project", "//SERVER/SHARE/project/", "win32"));
  assert.ok(isPathWithin("//SERVER/SHARE/project/child", "\\\\server\\share\\Project", "win32"));
  assert.equal(samePath("C:/project", "D:/project", "win32"), false);
  assert.equal(samePath("C:/project", "C:/project/child", "win32"), false);
  assert.equal(isPathWithin("//server/share-other/project", "//server/share", "win32"), false);
  assert.equal(samePath("/work/Alice", "/work/alice", "linux"), false);
});

test("Windows deletion preflight protects differently cased current paths", { skip: process.platform !== "win32" }, async () => {
  // No filesystem access should occur: the complete batch must fail preflight.
  await assert.rejects(deleteSessionFiles(["C:/missing/other.jsonl", "C:/Sessions/Current.jsonl"], "c:\\sessions\\current.jsonl"), /当前正在使用/);
});
