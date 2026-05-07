#!/usr/bin/env bun
import { renderGalaxySplash, GALAXY_TITLE } from "../.pi/extensions/catallaxy-interface/splash";

const reset = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${reset}`;
const boldCyan = (s: string) => `\x1b[1;36m${s}${reset}`;
const cyan = (s: string) => `\x1b[36m${s}${reset}`;
const magenta = (s: string) => `\x1b[35m${s}${reset}`;
const white = (s: string) => `\x1b[37m${s}${reset}`;

function color(line: string): string {
  const start = line.indexOf(GALAXY_TITLE);
  if (start >= 0) {
    return color(line.slice(0, start)) + boldCyan(GALAXY_TITLE) + color(line.slice(start + GALAXY_TITLE.length));
  }
  let out = "";
  for (const ch of line) {
    if (ch === "O" || ch === "o") out += cyan(ch);
    else if (ch === "+") out += magenta(ch);
    else if (ch === "*") out += white(ch);
    else if (ch === "." || ch === "'" || ch === "`") out += dim(ch);
    else out += ch;
  }
  return out;
}

const columns = process.stdout.columns || Number(process.env.COLUMNS) || 80;
const rows = process.stdout.rows || Number(process.env.LINES) || 24;
const seed = process.env.CATALLAXY_GALAXY_SEED ?? GALAXY_TITLE;
const lines = renderGalaxySplash(columns, rows, seed).map(color);

process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
process.stdout.write(lines.join("\n"));
process.stdout.write("\x1b[H");
