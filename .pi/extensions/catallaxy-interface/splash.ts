import type { Theme } from "@mariozechner/pi-coding-agent";

export const GALAXY_TITLE = "catallaxy";
const RESERVED_UI_ROWS = 6;

export interface GalaxyWindow {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  titleRow: number;
  titleCol: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function mix32(n: number): number {
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n >>> 0;
}

function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededUnit(seed: number, salt: number): number {
  return mix32(seed ^ Math.imul(salt + 1, 0x9e3779b9)) / 0xffffffff;
}

function noise(x: number, y: number, seed: number, salt = 0): number {
  const n = Math.imul(x + 0x9e37, 0x85ebca6b)
    ^ Math.imul(y + 0xc2b2, 0x27d4eb2f)
    ^ Math.imul(seed ^ salt, 0x165667b1);
  return mix32(n) / 0xffffffff;
}

export function splashHeight(rows: number): number {
  const r = Number.isFinite(rows) ? Math.floor(rows) : 24;
  return clamp(r - RESERVED_UI_ROWS, 12, Math.max(12, r - 1));
}

export function computeGalaxyWindow(width: number, rows: number, title = GALAXY_TITLE): GalaxyWindow {
  const w = clamp(Math.floor(Number.isFinite(width) ? width : 80), Math.max(24, title.length + 4), 220);
  const h = splashHeight(rows);

  // Center the galaxy on the current terminal window, not merely on the
  // rendered header canvas. The canvas reserves a few rows for Pi's editor /
  // footer, so clamp the window center into the canvas when needed.
  const centerX = Math.floor((w - 1) / 2);
  const centerY = clamp(Math.floor((Number.isFinite(rows) ? rows : h) / 2), 0, h - 1);
  const titleCol = clamp(Math.floor((w - title.length) / 2), 0, Math.max(0, w - title.length));

  return { width: w, height: h, centerX, centerY, titleRow: centerY, titleCol };
}

export function renderGalaxySplash(width: number, rows: number, seed = process.env.CATALLAXY_GALAXY_SEED ?? GALAXY_TITLE): string[] {
  const win = computeGalaxyWindow(width, rows, GALAXY_TITLE);
  const s = seedHash(seed || GALAXY_TITLE);

  const arms = 2 + Math.floor(seededUnit(s, 1) * 3); // 2..4 arms
  const rotation = seededUnit(s, 2) * Math.PI * 2;
  const twist = 8 + seededUnit(s, 3) * 10;
  const armSharpness = 2.0 + seededUnit(s, 4) * 1.8;
  const tilt = -0.20 + seededUnit(s, 5) * 0.40;
  const dustPhase = seededUnit(s, 6) * Math.PI * 2;

  const cx = win.titleCol + (GALAXY_TITLE.length - 1) / 2;
  const cy = win.titleRow;
  const out: string[] = [];

  for (let y = 0; y < win.height; y++) {
    let line = "";
    for (let x = 0; x < win.width; x++) {
      const dx = x - cx;
      const dy = (y - cy) * 1.85; // terminal cells are taller than they are wide
      const nx = (dx + dy * tilt) / Math.max(1, win.width * 0.48);
      const ny = dy / Math.max(1, win.height * 0.74);
      const r = Math.sqrt(nx * nx + ny * ny);
      const theta = Math.atan2(ny, nx) + rotation;
      const spiral = Math.abs(Math.sin(theta * arms + r * twist));
      const core = Math.pow(Math.max(0, 1 - r * 3.3), 2.0);
      const arm = Math.pow(Math.max(0, 1 - spiral), armSharpness) * Math.max(0, 1 - r * 1.05);
      const dust = Math.max(0, 1 - Math.abs(ny + Math.sin(nx * 9 + dustPhase) * 0.10) * 5.0) * Math.max(0, 1 - r * 1.25);
      const density = core * 0.62 + arm * 0.70 + dust * 0.18;
      const rnd = noise(x, y, s);

      let ch = " ";
      if (rnd < density * 0.08) ch = "O";
      else if (rnd < density * 0.17) ch = "o";
      else if (rnd < density * 0.32) ch = "+";
      else if (rnd < density * 0.58) ch = "*";
      else if (rnd < density * 0.92) ch = ".";
      else if (rnd < 0.018 + seededUnit(s, 7) * 0.008) ch = rnd < 0.010 ? "'" : "`";
      line += ch;
    }
    out.push(line);
  }

  for (let y = Math.max(0, win.titleRow - 1); y <= Math.min(out.length - 1, win.titleRow + 1); y++) {
    const chars = out[y].split("");
    for (let x = Math.max(0, win.titleCol - 2); x < Math.min(chars.length, win.titleCol + GALAXY_TITLE.length + 2); x++) {
      chars[x] = " ";
    }
    out[y] = chars.join("");
  }

  const chars = out[win.titleRow].split("");
  for (let i = 0; i < GALAXY_TITLE.length && win.titleCol + i < chars.length; i++) {
    chars[win.titleCol + i] = GALAXY_TITLE[i];
  }
  out[win.titleRow] = chars.join("");

  return out;
}

function colorGalaxyLine(line: string, theme: Theme): string {
  let out = "";
  for (const ch of line) {
    if (ch === "O" || ch === "o") out += theme.fg("accent", ch);
    else if (ch === "+") out += theme.fg("toolTitle", ch);
    else if (ch === "*") out += theme.fg("muted", ch);
    else if (ch === "." || ch === "'" || ch === "`") out += theme.fg("dim", ch);
    else out += ch;
  }
  return out;
}

export function colorGalaxySplash(lines: string[], theme: Theme): string[] {
  return lines.map((line) => {
    const start = line.indexOf(GALAXY_TITLE);
    if (start < 0) return colorGalaxyLine(line, theme);
    return colorGalaxyLine(line.slice(0, start), theme)
      + theme.fg("accent", theme.bold(GALAXY_TITLE))
      + colorGalaxyLine(line.slice(start + GALAXY_TITLE.length), theme);
  });
}
