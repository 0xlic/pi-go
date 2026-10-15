export interface ProjectMeta {
  alias?: string;
  pinned?: boolean;
  pinOrder?: number;
  lastUsedAt?: number;
  registered?: boolean;
}
export interface SessionMeta {
  pinned?: boolean;
  pinOrder?: number;
  lastUsedAt?: number;
}
export interface Metadata {
  version: 1;
  projects: Record<string, ProjectMeta>;
  sessions: Record<string, SessionMeta>;
  extraSessionDirs?: string[];
  pinnedSessionsGroup?: { pinOrder?: number };
}
export interface Project {
  id: string;
  cwd: string;
  name: string;
  pinned: boolean;
  lastUsedAt: number;
  pinOrder?: number;
  sessionKeys: string[];
  searchFields: string[];
}
export interface GoSession {
  key: string;
  projectId: string;
  name: string;
  pinned: boolean;
  lastUsedAt: number;
  pinOrder?: number;
  searchTitle: string;
}
export const PINNED_SESSIONS_GROUP_ID = "pi-go:pinned-sessions";
export interface PinnedSessionsGroup {
  id: typeof PINNED_SESSIONS_GROUP_ID;
  name: string;
  pinned: true;
  pinOrder?: number;
  lastUsedAt: number;
  searchFields: string[];
}
export interface Catalog {
  projects: Map<string, Project>;
  sessions: Map<string, GoSession>;
  pinnedSessionsGroup?: PinnedSessionsGroup;
}
export type ProjectRow = { kind: "all" } | { kind: "pinned-sessions" } | { kind: "project"; id: string };
export type SessionRow = { kind: "session"; key: string };
export type GoAction = { kind: "restore"; path: string } | { kind: "create"; cwd: string };
