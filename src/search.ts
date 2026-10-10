import { fuzzyMatch } from "@earendil-works/pi-tui";

export function searchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}
export function matches(query: string, fields: readonly string[]): boolean {
  const tokens = searchText(query).trim().split(/\s+/).filter(Boolean);
  return tokens.every(token => fields.some(field => fuzzyMatch(token, field).matches));
}
