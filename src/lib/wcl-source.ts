/**
 * Warcraft Logs source parsing — accepts what a raid leader will actually
 * paste: a full WCL guild URL ("https://www.warcraftlogs.com/guild/id/821324",
 * with or without protocol/query/fragment/trailing slash) or a raw numeric
 * id. Returns the guild id, or null when the input can't be read as one
 * (e.g. the /guild/name/… URL form, which has no id to extract — the UI
 * tells the user to use the id form).
 */
export function parseWclGuildSource(input: string): number | null {
  const s = input.trim();
  if (!s) return null;

  // Raw numeric id.
  if (/^\d+$/.test(s)) {
    const id = Number(s);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  // URL form: .../guild/id/<digits>(/...)?(?...)(#...)
  const m = /warcraftlogs\.com\/guild\/id\/(\d+)(?:[/?#]|$)/i.exec(s);
  if (m) {
    const id = Number(m[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  return null;
}
