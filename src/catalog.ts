import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizePath, safeText } from "./path-utils.ts";
import { searchText } from "./search.ts";
import type { CatalogAvailability } from "./catalog-availability.ts";
import { PINNED_SESSIONS_GROUP_ID, type Catalog, type Metadata, type Project, type PinnedSessionsGroup } from "./types.ts";

export function projectEntries(catalog: Catalog): (Project | PinnedSessionsGroup)[] {
  return [...catalog.projects.values(), ...(catalog.pinnedSessionsGroup ? [catalog.pinnedSessionsGroup] : [])];
}

export function buildCatalog(infos: readonly SessionInfo[], metadata: Metadata, currentCwd: string, availability?: CatalogAvailability): Catalog {
  const projects: Catalog["projects"] = new Map();
  const sessions: Catalog["sessions"] = new Map();
  function addProject(cwd: string): Project | undefined {
    const id = normalizePath(cwd);
    if (availability && !availability.projectPaths.has(id)) return undefined;
    const existing = projects.get(id);
    if (existing) return existing;
    const meta = metadata.projects[id];
    const name = safeText(meta?.alias || basename(id) || id);
    const project: Project = { id, cwd: id, name, pinned: !!meta?.pinned, lastUsedAt: meta?.lastUsedAt ?? 0,
      pinOrder: meta?.pinOrder, sessionKeys: [], searchFields: [searchText(name), searchText(id)] };
    projects.set(id, project);
    return project;
  }
  addProject(currentCwd);
  for (const [cwd, meta] of Object.entries(metadata.projects)) {
    if (meta.registered || meta.pinned || meta.alias || meta.lastUsedAt !== undefined) addProject(cwd);
  }
  for (const info of infos) {
    // Old sessions without a cwd cannot safely be assigned to the current project.
    if (!info.cwd) continue;
    const key = normalizePath(info.path);
    if (sessions.has(key) || (availability && !availability.sessionPaths.has(key))) continue;
    const project = addProject(info.cwd);
    if (!project) continue;
    const meta = metadata.sessions[key];
    const name = safeText(info.name?.trim() || info.firstMessage?.trim() || `未命名会话 ${info.id.slice(0, 8)}`);
    sessions.set(key, { key, projectId: project.id, name, pinned: !!meta?.pinned,
      pinOrder: meta?.pinOrder, lastUsedAt: meta?.lastUsedAt ?? (info.modified.getTime() || 0), searchTitle: searchText(name) });
    project.sessionKeys.push(key);
  }
  // Explicit visit records take precedence; file activity is only a fallback.
  for (const project of projects.values()) {
    const visits = project.sessionKeys.map(key => metadata.sessions[key]?.lastUsedAt).filter((x): x is number => x !== undefined);
    const explicit = metadata.projects[project.id]?.lastUsedAt;
    project.lastUsedAt = explicit !== undefined || visits.length
      ? Math.max(explicit ?? 0, ...visits)
      : Math.max(0, ...project.sessionKeys.map(key => sessions.get(key)!.lastUsedAt));
  }
  const pinned = [...sessions.values()].filter(session => session.pinned);
  const name = "【置顶会话】";
  return { projects, sessions, pinnedSessionsGroup: pinned.length ? {
    id: PINNED_SESSIONS_GROUP_ID, name, pinned: true,
    pinOrder: metadata.pinnedSessionsGroup?.pinOrder,
    lastUsedAt: Math.max(...pinned.map(session => session.lastUsedAt)),
    searchFields: [searchText(name)],
  } : undefined };
}
