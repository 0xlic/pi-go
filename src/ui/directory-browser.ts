import { readdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { normalizePath, safeText } from "../path-utils.ts";

/** Non-recursive completion: only reads the directory currently being typed. */
export class DirectoryBrowser {
  candidates: string[] = [];
  selected = 0;
  private revision = 0;
  constructor(private base: string, private changed: () => void) {}
  async update(value: string): Promise<void> {
    const revision = ++this.revision;
    const path = normalizePath(value || ".", this.base);
    const parent = value.endsWith(sep) ? path : dirname(path);
    const prefix = value.endsWith(sep) ? "" : basename(path).toLocaleLowerCase();
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      if (revision !== this.revision) return;
      this.candidates = entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && e.name.toLocaleLowerCase().startsWith(prefix))
        .map(e => join(parent, e.name) + sep).sort();
      if (!prefix) this.candidates.unshift(dirname(parent) + sep);
    } catch { if (revision !== this.revision) return; this.candidates = []; }
    this.selected = 0;
    this.changed();
  }
  move(delta: number): void { this.selected = Math.max(0, Math.min(this.candidates.length - 1, this.selected + delta)); }
  get completion(): string | undefined { return this.candidates[this.selected]; }
  get visible(): string[] {
    const start = Math.max(0, this.selected - 4);
    return this.candidates.slice(start, start + 6).map((path, i) => `${start + i === this.selected ? "›" : " "} ${safeText(path)}`);
  }
  dispose(): void { this.revision++; }
}
