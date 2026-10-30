import { basename } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteSessionFiles } from "./deletion.ts";
import type { MetadataStore } from "./metadata-store.ts";
import { isPathWithin } from "./path-utils.ts";
import { listSessions } from "./session-repository.ts";
import { canonical, cleanupRanges, deleteWorkspace, planCleanup, temporaryRoot } from "./temp-workspaces.ts";

export async function cleanTemporary(ctx: ExtensionCommandContext, store: MetadataStore): Promise<void> {
  const label = await ctx.ui.select("清理哪些临时会话？（按工作区创建时间）", cleanupRanges.map(r => r.label));
  const range = cleanupRanges.find(r => r.label === label);
  if (!range) return;
  const current = ctx.sessionManager.getSessionFile();
  const plan = await planCleanup(temporaryRoot(), range.days, [ctx.cwd, ...(current ? [current] : [])]);
  const skipped = plan.skippedActive ? `已跳过 ${plan.skippedActive} 个当前工作区。` : "";
  if (!plan.directories.length) { ctx.ui.notify(`没有可清理的临时会话。${skipped}`, "info"); return; }
  const metadata = await store.read();
  const infos = await listSessions(ctx.sessionManager.getSessionDir(), metadata.extraSessionDirs ?? []);
  const canonicalInfos = await Promise.all(infos.map(async info => ({ info, cwd: info.cwd ? await canonical(info.cwd) : undefined, path: await canonical(info.path) })));
  const confirmed = await ctx.ui.confirm("确认删除临时工作区和历史记录？", [
    `范围：${range.label}；共 ${plan.directories.length} 个工作区。`,
    `根目录：${plan.root}`,
    ...plan.directories.slice(0, 10).map(d => basename(d.path)),
    plan.directories.length > 10 ? `……另有 ${plan.directories.length - 10} 个` : "", skipped,
    "工作区所有文件及其会话记录（包括默认存储中的 JSONL）将永久删除。",
    "无法检测其他 Pi 进程是否正在使用这些工作区，请先关闭相关会话。",
  ].filter(Boolean).join("\n"));
  if (!confirmed) return;
  let deleted = 0;
  const failures: string[] = [];
  for (const directory of plan.directories) {
    try {
      const keys = [...new Set(canonicalInfos.filter(s => (s.cwd && isPathWithin(s.cwd, directory.path)) || isPathWithin(s.path, directory.path)).map(s => s.info.path))];
      // Protect the active JSONL even if its header or storage location is unusual.
      await deleteSessionFiles(keys, current);
      await store.removeEntries(keys);
      await deleteWorkspace(plan.root, directory);
      deleted++;
    } catch (error) { failures.push(`${directory.path}: ${String(error)}`); }
  }
  ctx.ui.notify(`已清理 ${deleted} 个临时工作区。${skipped}`, "info");
  if (failures.length) ctx.ui.notify(`部分清理失败：\n${failures.join("\n")}`, "warning");
}
