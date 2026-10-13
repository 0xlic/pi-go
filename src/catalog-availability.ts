import { stat } from "node:fs/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizePath } from "./path-utils.ts";
import type { Metadata } from "./types.ts";

export interface CatalogAvailability {
  projectPaths: ReadonlySet<string>;
  sessionPaths: ReadonlySet<string>;
}

async function existingPaths(paths: string[], kind: "directory" | "file", signal?: AbortSignal): Promise<Set<string>> {
  const existing = new Set<string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
    while (next < paths.length) {
      signal?.throwIfAborted();
      const path = paths[next++];
      try {
        const info = await stat(path);
        if (kind === "directory" ? info.isDirectory() : info.isFile()) existing.add(path);
      } catch {
        // Missing/unreachable paths are hidden, not removed from durable metadata.
      }
    }
  }));
  signal?.throwIfAborted();
  return existing;
}

/** Filesystem snapshot taken on each picker opening; never mutates state or transcript files. */
export async function inspectCatalogAvailability(infos: readonly SessionInfo[], metadata: Metadata,
  currentCwd: string, signal?: AbortSignal): Promise<CatalogAvailability> {
  const dirs = new Set([currentCwd, ...Object.keys(metadata.projects), ...infos.map(info => info.cwd).filter(Boolean)].map(path => normalizePath(path)));
  const files = new Set(infos.map(info => normalizePath(info.path)));
  const [projectPaths, sessionPaths] = await Promise.all([
    existingPaths([...dirs], "directory", signal), existingPaths([...files], "file", signal),
  ]);
  return { projectPaths, sessionPaths };
}
