import { matches } from "../search.ts";
import { compareEntries } from "../sort.ts";
import type { Catalog, Project, ProjectRow, GoSession, SessionRow } from "../types.ts";

type ProjectSelection = ProjectRow | { kind: "none" };
function projectKey(row: ProjectSelection): string { return row.kind === "project" ? row.id : row.kind; }
function sessionKey(row: SessionRow): string { return row.kind === "new" ? "new" : row.key; }

export class ViewModel {
  activePane: "projects" | "sessions" = "projects";
  projectQuery = "";
  sessionQuery = "";
  selectedProject: ProjectSelection;
  selectedSession: SessionRow = { kind: "new" };
  projectRows: ProjectRow[] = [];
  sessionRows: SessionRow[] = [];
  projectScroll = 0;
  sessionScroll = 0;

  constructor(public catalog: Catalog, currentCwd: string) {
    this.selectedProject = catalog.projects.has(currentCwd) ? { kind: "project", id: currentCwd } : { kind: "all" };
    this.refresh();
  }
  get project(): Project | undefined {
    return this.selectedProject.kind === "project" ? this.catalog.projects.get(this.selectedProject.id) : undefined;
  }
  get session(): GoSession | undefined {
    return this.selectedSession.kind === "session" ? this.catalog.sessions.get(this.selectedSession.key) : undefined;
  }
  togglePane(): void { this.activePane = this.activePane === "projects" ? "sessions" : "projects"; }
  setQuery(query: string): void {
    if (this.activePane === "projects") this.projectQuery = query;
    else this.sessionQuery = query;
    this.refresh();
  }
  selectProject(row: ProjectRow): void {
    if (projectKey(this.selectedProject) !== projectKey(row)) {
      this.selectedProject = row;
      this.sessionQuery = "";
      this.selectedSession = { kind: "new" };
      this.sessionScroll = 0;
    }
    this.refresh();
  }
  refresh(): void {
    const projects = [...this.catalog.projects.values()].filter(p => matches(this.projectQuery, p.searchFields))
      .sort((a, b) => compareEntries(a, b) || a.id.localeCompare(b.id));
    this.projectRows = projects.map(p => ({ kind: "project" as const, id: p.id }));
    if (!this.projectQuery.trim()) this.projectRows.unshift({ kind: "all" });
    if (!this.projectRows.some(row => projectKey(row) === projectKey(this.selectedProject))) {
      const next: ProjectSelection = this.projectRows[0] ?? { kind: "none" };
      if (projectKey(next) !== projectKey(this.selectedProject)) {
        this.selectedProject = next;
        this.sessionQuery = "";
        this.selectedSession = { kind: "new" };
        this.sessionScroll = 0;
      }
    }
    const selected = this.selectedProject;
    const sessions = [...this.catalog.sessions.values()]
      .filter(s => (selected.kind === "all" || (selected.kind === "project" && s.projectId === selected.id)) && matches(this.sessionQuery, [s.searchTitle]))
      .sort((a, b) => compareEntries(a, b) || a.key.localeCompare(b.key));
    this.sessionRows = selected.kind === "none" ? [] : [{ kind: "new" }, ...sessions.map(s => ({ kind: "session" as const, key: s.key }))];
    if (!this.sessionRows.some(row => sessionKey(row) === sessionKey(this.selectedSession))) this.selectedSession = { kind: "new" };
  }
  move(delta: number): void {
    if (this.activePane === "projects") {
      if (!this.projectRows.length) return;
      const index = this.projectRows.findIndex(row => projectKey(row) === projectKey(this.selectedProject));
      this.selectProject(this.projectRows[Math.max(0, Math.min(this.projectRows.length - 1, index + delta))]);
    } else {
      if (!this.sessionRows.length) return;
      const index = this.sessionRows.findIndex(row => sessionKey(row) === sessionKey(this.selectedSession));
      this.selectedSession = this.sessionRows[Math.max(0, Math.min(this.sessionRows.length - 1, index + delta))];
    }
  }
  ensureVisible(height: number): void {
    const adjust = (index: number, scroll: number, count: number) => Math.max(0, Math.min(
      index < scroll ? index : index >= scroll + height ? index - height + 1 : scroll, Math.max(0, count - height)));
    this.projectScroll = adjust(this.projectRows.findIndex(r => projectKey(r) === projectKey(this.selectedProject)), this.projectScroll, this.projectRows.length);
    this.sessionScroll = adjust(this.sessionRows.findIndex(r => sessionKey(r) === sessionKey(this.selectedSession)), this.sessionScroll, this.sessionRows.length);
  }
}
