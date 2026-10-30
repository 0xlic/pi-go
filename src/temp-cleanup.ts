import { lstat, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteSessionFiles } from "./deletion.ts";
import type { MetadataStore } from "./metadata-store.ts";
import { isPathWithin } from "./path-utils.ts";
import { listSessions } from "./session-repository.ts";
import { canonical, cleanupRanges, deleteWorkspace, planCleanup, parseTimestamp, temporaryRoot, type Workspace } from "./temp-workspaces.ts";

export async function cleanTemporary(ctx: ExtensionCommandContext, store: MetadataStore): Promise<void> {
  const label = await ctx.ui.select("清理哪些临时会话？（按工作区创建时间）", cleanupRanges.map(r => r.label));
  const range = cleanupRanges.find(r => r.label === label);
  if (!range) return;
  const current = ctx.sessionManager.getSessionFile();
  const plan = await planCleanup(temporaryRoot(), range.days, [ctx.cwd, ...(current ? [current] : [])]);
  const skipped = plan.skippedActive ? `已跳过 ${plan.skippedActive} 个当前工作区。` : "";
  const metadata = await store.read();
  const infos = await listSessions(ctx.sessionManager.getSessionDir(), metadata.extraSessionDirs ?? []);
  const canonicalInfos = await Promise.all(infos.map(async info => ({ info, cwd: info.cwd ? await canonical(info.cwd) : undefined, path: await canonical(info.path) })));
  // Missing workspaces still own their history. Derive candidates from header cwd,
  // never from the encoded storage directory name (which is not reversible).
  const targets = new Map<string, Workspace | undefined>(plan.directories.map(d => [d.path, d]));
  const protectedPaths = await Promise.all([ctx.cwd, ...(current ? [current] : [])].map(canonical));
  const now = Date.now();
  for (const session of canonicalInfos) {
    if (!session.cwd || !isPathWithin(session.cwd, plan.root)) continue;
    const name = relative(plan.root, session.cwd).split(/[\\/]/)[0];
    const date = parseTimestamp(name);
    if (!date || (range.days !== null && (date.getTime() < now - range.days * 86400000 || date.getTime() > now))) continue;
    const path = join(plan.root, name);
    if (targets.has(path) || protectedPaths.some(p => isPathWithin(p, path))) continue;
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targets.set(path, undefined);
    }
  }
  if (!targets.size) { ctx.ui.notify(`没有可清理的临时会话。${skipped}`, "info"); return; }
  const paths = [...targets.keys()];
  const confirmed = await ctx.ui.confirm("确认删除临时工作区和历史记录？", [
    `范围：${range.label}；共 ${plan.directories.length} 个工作区，${targets.size - plan.directories.length} 个已删除工作区的残留历史。`,
    `根目录：${plan.root}`,
    ...paths.slice(0, 10).map(p => basename(p)),
    paths.length > 10 ? `……另有 ${paths.length - 10} 个` : "", skipped,
    "工作区所有文件及其会话记录（包括默认存储中的 JSONL）将永久删除。",
    "无法检测其他 Pi 进程是否正在使用这些工作区，请先关闭相关会话。",
  ].filter(Boolean).join("\n"));
  if (!confirmed) return;
  const sessionRoot = await canonical(join(getAgentDir(), "sessions"));
  let deleted = 0, histories = 0;
  const failures: string[] = [];
  for (const [path, directory] of targets) {
    try {
      const keys = [...new Set(canonicalInfos.filter(s => (s.cwd && isPathWithin(s.cwd, path)) || isPathWithin(s.path, path)).map(s => s.info.path))];
      // Protect the active JSONL even if its header or storage location is unusual.
      await deleteSessionFiles(keys, current);
      await store.removeEntries(keys);
      // Remove only empty default project stores, never the sessions root or custom stores.
      for (const parent of new Set(keys.map(key => dirname(key)))) {
        const resolved = await canonical(parent);
        if (dirname(resolved) !== sessionRoot) continue;
        try { await rmdir(parent); }
        catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      if (directory) { await deleteWorkspace(plan.root, directory); deleted++; }
      histories += keys.length;
    } catch (error) { failures.push(`${path}: ${String(error)}`); }
  }
  ctx.ui.notify(`已清理 ${deleted} 个临时工作区、${histories} 个会话记录。${skipped}`, "info");
  if (failures.length) ctx.ui.notify(`部分清理失败：\n${failures.join("\n")}`, "warning");
}
