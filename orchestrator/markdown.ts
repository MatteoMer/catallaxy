function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.includes("|");
}

function cells(line: string): string[] {
  return line.trim().slice(1, -1).split("|").map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((c) => /^:?-{3,}:?$/.test(c));
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}

function row(parts: string[], widths: number[]): string {
  return "│" + widths.map((w, i) => ` ${pad(parts[i] ?? "", w)} `).join("│") + "│";
}

function renderTable(rows: string[][]): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const out: string[] = [border("┌", "┬", "┐", widths), row(rows[0] ?? [], widths)];
  if (rows.length > 1) out.push(border("├", "┼", "┤", widths));
  for (const r of rows.slice(1)) out.push(row(r, widths));
  out.push(border("└", "┴", "┘", widths));
  return out;
}

export function renderMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && isTableRow(lines[i]) && isSeparator(lines[i + 1])) {
      const rows = [cells(lines[i])];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(...renderTable(rows));
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}
