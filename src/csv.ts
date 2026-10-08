/** Parses CSV with a header row into records keyed by column name. Quoted fields may hold commas, quotes and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) return [];
  const columns = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(columns.map((col, i) => [col, (r[i] ?? "").trim()])));
}

export function formatCsv(columns: readonly string[], records: Record<string, string | null>[]): string {
  const cell = (v: string | null) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.join(","), ...records.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
