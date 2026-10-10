export interface ProjectMeta {
  alias?: string;
  pinned?: boolean;
  lastUsedAt?: number;
  registered?: boolean;
}
export interface SessionMeta {
  pinned?: boolean;
  lastUsedAt?: number;
}
export interface Metadata {
  version: 1;
  projects: Record<string, ProjectMeta>;
  sessions: Record<string, SessionMeta>;
  extraSessionDirs?: string[];
}
export interface Project {
  id: string;
  cwd: string;
  name: string;
  pinned: boolean;
  lastUsedAt: number;
  sessionKeys: string[];
  searchFields: string[];
}
export interface GoSession {
  key: string;
  projectId: string;
  name: string;
  pinned: boolean;
  lastUsedAt: number;
  searchTitle: string;
}
export interface Catalog {
  projects: Map<string, Project>;
  sessions: Map<string, GoSession>;
}
export type ProjectRow = { kind: "all" } | { kind: "project"; id: string };
export type SessionRow = { kind: "new" } | { kind: "session"; key: string };
export type GoAction = { kind: "restore"; path: string } | { kind: "create"; cwd: string };
