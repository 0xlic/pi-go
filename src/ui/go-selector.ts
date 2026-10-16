import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { sep } from "node:path";
import { aliasFromInput, assertDirectory, normalizePath, safeText } from "../path-utils.ts";
import { PINNED_SESSIONS_GROUP_ID, type Catalog, type GoAction } from "../types.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { ViewModel } from "./view-model.ts";

export interface SelectorCallbacks {
  pinProject(id: string, pinned: boolean): Promise<Catalog>;
  pinSession(key: string, pinned: boolean): Promise<Catalog>;
  rename(id: string, alias: string | undefined): Promise<Catalog>;
  copyPath(cwd: string): Promise<void>;
  movePin(kind: "project" | "session", key: string, neighbor: string): Promise<Catalog>;
}
interface Form {
  kind: "rename" | "directory";
  input: Input;
  projectId?: string;
  browser?: DirectoryBrowser;
}

function cell(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class GoSelector implements Component, Focusable {
  readonly vm: ViewModel;
  private projectInput: Input;
  private sessionInput: Input;
  private form?: Form;
  private busy = false;
  private message = "";
  private disposed = false;
  private hasFocus = false;
  private pageHeight = 8;

  constructor(private tui: Pick<TUI, "requestRender" | "terminal">, private theme: Theme,
    private keybindings: KeybindingsManager, catalog: Catalog, private cwd: string,
    private callbacks: SelectorCallbacks, private done: (action: GoAction | null) => void) {
    this.vm = new ViewModel(catalog, normalizePath(cwd));
    this.projectInput = new Input({ prompt: "项目 › ", placeholder: "项目名称 / 目录路径", placeholderStyle: s => theme.fg("dim", s) });
    this.sessionInput = new Input({ prompt: "会话 › ", placeholder: "会话名称", placeholderStyle: s => theme.fg("dim", s) });
  }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.syncInputs(); }
  private syncInputs(): void {
    if (this.projectInput.getValue() !== this.vm.projectQuery) this.projectInput.setValue(this.vm.projectQuery);
    if (this.sessionInput.getValue() !== this.vm.sessionQuery) this.sessionInput.setValue(this.vm.sessionQuery);
    this.projectInput.focused = this.hasFocus && !this.form && this.vm.activePane === "projects";
    this.sessionInput.focused = this.hasFocus && !this.form && this.vm.activePane === "sessions";
    if (this.form) this.form.input.focused = this.hasFocus;
  }
  invalidate(): void {
    this.projectInput.invalidate(); this.sessionInput.invalidate(); this.form?.input.invalidate();
  }
  dispose(): void { this.disposed = true; this.form?.browser?.dispose(); }
  private changed(): void { if (!this.disposed) { this.syncInputs(); this.tui.requestRender(); } }
  private async run(work: () => Promise<void>, successMessage = ""): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.message = "保存 / 加载中…"; this.changed();
    try { await work(); this.message = successMessage; }
    catch (error) { this.message = safeText(error instanceof Error ? error.message : String(error)); }
    finally { this.busy = false; this.changed(); }
  }
  private movePin(delta: -1 | 1): void {
    const projectPane = this.vm.activePane === "projects";
    const entry = projectPane ? this.vm.projectEntry : this.vm.session;
    if (!entry?.pinned) { this.message = "只能移动已 pin 的项目或会话"; return; }
    const kind = projectPane ? "project" : "session";
    const key = projectPane ? this.vm.projectEntry!.id : this.vm.session!.key;
    const visible = projectPane
      ? this.vm.projectRows.flatMap(row => row.kind === "pinned-sessions" ? [PINNED_SESSIONS_GROUP_ID]
        : row.kind === "project" && this.vm.catalog.projects.get(row.id)?.pinned ? [row.id] : [])
      : this.vm.sessionRows.flatMap(row => row.kind === "session" && this.vm.catalog.sessions.get(row.key)?.pinned ? [row.key] : []);
    const neighbor = visible[visible.indexOf(key) + delta];
    if (!neighbor) { this.message = delta < 0 ? "已是首个可见置顶条目" : "已是最后一个可见置顶条目"; return; }
    void this.run(async () => {
      this.vm.catalog = await this.callbacks.movePin(kind, key, neighbor);
      this.vm.refresh();
    }, "置顶顺序已保存");
  }

  private openDirectory(): void {
    const input = new Input({ prompt: "目录 › " });
    input.setValue(this.cwd + (this.cwd.endsWith(sep) ? "" : sep));
    const browser = new DirectoryBrowser(this.cwd, () => this.changed());
    this.form = { kind: "directory", input, browser };
    void browser.update(input.getValue());
  }
  private closeForm(): void { this.form?.browser?.dispose(); this.form = undefined; this.message = ""; }
  private confirmForm(): void {
    const form = this.form!;
    void this.run(async () => {
      if (form.kind === "rename") {
        const catalog = await this.callbacks.rename(form.projectId!, aliasFromInput(form.input.getValue()));
        this.vm.catalog = catalog; this.vm.refresh(); this.closeForm();
      } else {
        const cwd = normalizePath(form.input.getValue().trim() || ".", this.cwd);
        await assertDirectory(cwd);
        this.done({ kind: "create", cwd });
      }
    });
  }
  private is(data: string, action: Parameters<KeybindingsManager["matches"]>[1], fallback: Parameters<typeof matchesKey>[1]): boolean {
    return this.keybindings.matches(data, action) || matchesKey(data, fallback);
  }
  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    this.message = "";
    if (this.form) {
      if (this.is(data, "tui.select.cancel", Key.escape)) this.closeForm();
      else if (this.is(data, "tui.select.confirm", Key.enter)) this.confirmForm();
      else if (this.form.browser && matchesKey(data, Key.tab)) {
        const path = this.form.browser.completion;
        if (path) { this.form.input.setValue(path); void this.form.browser.update(path); }
      } else if (this.form.browser && this.is(data, "tui.select.up", Key.up)) this.form.browser.move(-1);
      else if (this.form.browser && this.is(data, "tui.select.down", Key.down)) this.form.browser.move(1);
      else {
        this.form.input.handleInput(data);
        if (this.form.browser) void this.form.browser.update(this.form.input.getValue());
      }
      this.changed(); return;
    }
    if (this.is(data, "tui.select.cancel", Key.escape)) { this.done(null); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) this.vm.togglePane();
    else if (matchesKey(data, Key.alt("up"))) this.movePin(-1);
    else if (matchesKey(data, Key.alt("down"))) this.movePin(1);
    else if (this.is(data, "tui.select.up", Key.up)) this.vm.move(-1);
    else if (this.is(data, "tui.select.down", Key.down)) this.vm.move(1);
    else if (matchesKey(data, Key.pageUp)) this.vm.move(-this.pageHeight);
    else if (matchesKey(data, Key.pageDown)) this.vm.move(this.pageHeight);
    else if (matchesKey(data, Key.ctrl("y"))) {
      const sessionProject = this.vm.activePane === "sessions" && this.vm.session
        ? this.vm.catalog.projects.get(this.vm.session.projectId) : undefined;
      const project = sessionProject ?? (this.vm.activePane === "sessions" && this.vm.session?.cwd
        ? { cwd: this.vm.session.cwd } : this.vm.project);
      if (project) {
        void this.run(() => this.callbacks.copyPath(project.cwd), `已复制项目目录：${safeText(project.cwd)}`);
      } else this.message = "请先选择具体项目或会话，再复制项目目录";
    }
    else if (matchesKey(data, Key.ctrl("r")) && this.vm.activePane === "projects") {
      const project = this.vm.project;
      if (project) {
        const input = new Input({ prompt: "名称 › " }); input.setValue(project.name);
        this.form = { kind: "rename", input, projectId: project.id };
      } else this.message = "虚拟分组不能重命名";
    } else if (matchesKey(data, Key.ctrl("p"))) {
      const project = this.vm.project, session = this.vm.session;
      if (this.vm.activePane === "projects" && this.vm.selectedProject.kind === "pinned-sessions") {
        this.message = "【置顶会话】自动置顶，不能取消 pin";
      } else if (this.vm.activePane === "projects" && project) {
        void this.run(async () => { this.vm.catalog = await this.callbacks.pinProject(project.id, !project.pinned); this.vm.refresh(); });
      } else if (this.vm.activePane === "sessions" && session) {
        void this.run(async () => { this.vm.catalog = await this.callbacks.pinSession(session.key, !session.pinned); this.vm.refresh(); });
      } else this.message = "固定入口不能 pin";
    } else if (this.is(data, "tui.select.confirm", Key.enter)) {
      if (this.vm.selectedProject.kind === "none") this.message = "没有匹配项目，请调整项目搜索";
      else if (this.vm.activePane === "projects") {
        if (this.vm.project) { this.done({ kind: "create", cwd: this.vm.project.cwd }); return; }
        else if (this.vm.selectedProject.kind === "all") this.openDirectory();
        else this.vm.togglePane();
      } else if (this.vm.session) { this.done({ kind: "restore", path: this.vm.session.key }); return; }
      else this.message = "没有匹配会话，请调整会话搜索或在左栏选择项目新建";
    } else {
      const input = this.vm.activePane === "projects" ? this.projectInput : this.sessionInput;
      input.handleInput(data);
      this.vm.setQuery(input.getValue());
    }
    this.changed();
  }

  render(width: number): string[] {
    this.syncInputs();
    const fg = (text: string) => this.theme.fg("borderMuted", text);
    if (width < 54) return [truncateToWidth(this.theme.fg("warning", "pi-go：请扩大窗口（至少 54 列），Esc 取消"), width)];
    const inner = width - 4;
    const frame = (text: string) => `${fg("│")} ${cell(text, inner)} ${fg("│")}`;
    const border = (left: string, right: string) => fg(left + "─".repeat(width - 2) + right);
    const lines = [border("╭", "╮")];
    if (this.form) {
      lines.push(frame(this.theme.bold(this.form.kind === "rename" ? "重命名项目（留空恢复默认名称）" : "选择目录（不会创建不存在的文件夹）")));
      lines.push(frame(this.form.input.render(inner)[0]));
      lines.push(frame(this.theme.fg("dim", this.form.browser ? "↑↓ 候选 · Tab 补全 / 进入 · Enter 使用输入目录 · Esc 返回" : "Enter 保存 · Esc 返回")));
      for (const candidate of this.form.browser?.visible ?? []) lines.push(frame(candidate));
      lines.push(frame(this.theme.fg("warning", this.message)), border("╰", "╯"));
      return lines;
    }
    const leftWidth = Math.floor((inner - 3) * 0.44), rightWidth = inner - leftWidth - 3;
    const pair = (left: string, right: string) => frame(`${cell(left, leftWidth)} ${fg("│")} ${cell(right, rightWidth)}`);
    const projectsActive = this.hasFocus && this.vm.activePane === "projects";
    const sessionsActive = this.hasFocus && this.vm.activePane === "sessions";
    // Input.focused only controls the IME marker in some pi-tui versions;
    // render inactive fields as text so their fake cursors cannot remain visible.
    const search = (input: Input, prompt: string, placeholder: string, columns: number, active: boolean) => active
      ? this.theme.fg("accent", input.render(columns)[0])
      : this.theme.fg("dim", cell(prompt + (input.getValue() || placeholder), columns));
    lines.push(pair(
      search(this.projectInput, "项目 › ", "项目名称 / 目录路径", leftWidth, projectsActive),
      search(this.sessionInput, "会话 › ", "会话名称", rightWidth, sessionsActive)));
    const enterHint = this.vm.activePane === "sessions"
      ? (this.vm.session ? "Enter 恢复会话" : "")
      : this.vm.project || this.vm.selectedProject.kind === "all" ? "Enter 新建会话"
        : (this.vm.selectedProject.kind === "pinned-sessions" || this.vm.selectedProject.kind === "temporary-sessions") && this.vm.canFocusSessions ? "Enter 选择会话" : "";
    const hints = [this.vm.canFocusSessions ? "Tab 切换" : "", "↑↓ 选择", enterHint, "Esc 取消"];
    lines.push(frame(this.theme.fg("dim", hints.filter(Boolean).join(" · "))));
    lines.push(frame(this.theme.fg("dim", "Ctrl+P pin · Alt+↑↓ 移动置顶 · Ctrl+R 重命名 · Ctrl+Y 复制路径")));
    lines.push(pair(
      this.theme.fg(projectsActive ? "accent" : "borderMuted", "─".repeat(leftWidth)),
      this.theme.fg(sessionsActive ? "accent" : "borderMuted", "─".repeat(rightWidth))));
    this.pageHeight = Math.max(2, Math.min(14, this.tui.terminal.rows - 11));
    this.vm.ensureVisible(this.pageHeight);
    const styleRow = (text: string, selected: boolean, active: boolean, columns: number): string => {
      const padded = cell(text, columns);
      if (!selected) return padded;
      return active ? this.theme.bg("selectedBg", this.theme.fg("accent", padded)) : this.theme.fg("dim", padded);
    };
    for (let offset = 0; offset < this.pageHeight; offset++) {
      const p = this.vm.projectRows[this.vm.projectScroll + offset];
      const s = this.vm.sessionRows[this.vm.sessionScroll + offset];
      let left = offset === 0 && !this.vm.projectRows.length ? this.theme.fg("dim", "无匹配项目") : "";
      let right = offset === 0 && !this.vm.sessionRows.length ? this.theme.fg("dim", this.vm.selectedProject.kind === "none" ? "请调整项目搜索" : "无匹配会话") : "";
      if (p) {
        const project = p.kind === "project" ? this.vm.catalog.projects.get(p.id)
          : p.kind === "pinned-sessions" ? this.vm.catalog.pinnedSessionsGroup
            : p.kind === "temporary-sessions" ? { ...this.vm.catalog.temporarySessionsGroup!, pinned: false } : undefined;
        const selected = p.kind === "all" ? this.vm.selectedProject.kind === "all"
          : p.kind === "pinned-sessions" || p.kind === "temporary-sessions" ? this.vm.selectedProject.kind === p.kind : this.vm.project?.id === p.id;
        left = styleRow(`${selected ? "›" : " "} ${project?.pinned ? "★ " : "  "}${project?.name ?? "所有项目"}`,
          selected, projectsActive, leftWidth);
      }
      if (s) {
        const session = this.vm.catalog.sessions.get(s.key);
        const selected = this.vm.session?.key === s.key;
        const projectName = session && (this.vm.selectedProject.kind === "all" || this.vm.selectedProject.kind === "pinned-sessions") ? ` [${(session.temporary ? this.vm.catalog.temporarySessionsGroup?.name : this.vm.catalog.projects.get(session.projectId)?.name) ?? ""}]` : "";
        right = styleRow(`${selected ? "›" : " "} ${session?.pinned ? "★ " : "  "}${session ? session.name + projectName : ""}`,
          selected, sessionsActive, rightWidth);
      }
      lines.push(pair(left, right));
    }
    lines.push(pair(this.theme.fg("dim", `${this.vm.projectRows.filter(row => row.kind === "project").length} 个项目`), this.theme.fg("dim", `${this.vm.sessionRows.filter(row => row.kind === "session").length} 个会话`)));
    const detail = this.vm.activePane === "sessions" && this.vm.session
      ? this.vm.session.cwd ?? this.vm.catalog.projects.get(this.vm.session.projectId)?.cwd ?? "项目目录不可用"
      : this.vm.project?.cwd ?? (this.vm.selectedProject.kind === "none" ? "没有匹配项目"
        : this.vm.selectedProject.kind === "temporary-sessions" ? "【临时会话】 · ~/.pi/agent/pi-temp-sessions"
        : this.vm.selectedProject.kind === "pinned-sessions" ? "【置顶会话】 · 所有项目的置顶会话" : "所有项目 · 全局会话搜索");
    lines.push(frame(this.theme.fg(this.message ? "warning" : "dim", this.message || safeText(detail))));
    lines.push(border("╰", "╯"));
    return lines;
  }
}
