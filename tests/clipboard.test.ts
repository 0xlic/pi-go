import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsClipboardCommand } from "../src/clipboard.ts";

test("Windows clipboard command safely preserves Unicode, spaces and shell metacharacters", () => {
  for (const path of [String.raw`C:\Users\中文 用户\项目`, String.raw`\\server\共享目录\项目`, "C:\\a'\";$()&`b"]) {
    const { command, args } = windowsClipboardCommand(path);
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    assert.ok(args.includes("-STA"));
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    assert.match(script, /Set-Clipboard/);
    assert.match(script, /ErrorActionPreference = 'Stop'/);
    const data = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1];
    assert.equal(Buffer.from(data, "base64").toString("utf8"), path);
    assert.ok(!script.includes(path));
  }
});
