interface Sortable {
  pinned: boolean;
  pinOrder?: number;
  lastUsedAt: number;
  name: string;
}

export function compareEntries(a: Sortable, b: Sortable): number {
  const pinned = Number(b.pinned) - Number(a.pinned);
  if (pinned) return pinned;
  if (a.pinned && b.pinned) {
    const left = a.pinOrder ?? Infinity, right = b.pinOrder ?? Infinity;
    if (left !== right) return left - right;
  }
  return b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name);
}
