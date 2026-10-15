import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** Encode data rather than interpolating paths into PowerShell source. */
export function windowsClipboardCommand(text: string): { command: string; args: string[] } {
  const data = Buffer.from(text, "utf8").toString("base64");
  const script = `$ErrorActionPreference = 'Stop'; Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${data}')))`;
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}

export async function copyProjectPath(cwd: string): Promise<void> {
  if (process.platform !== "win32") {
    await copyToClipboard(cwd);
    return;
  }
  // Avoid clip.exe's console code-page decoding of non-ASCII paths.
  const { command, args } = windowsClipboardCommand(cwd);
  await execFileAsync(command, args, { timeout: 5000, windowsHide: true });
}
