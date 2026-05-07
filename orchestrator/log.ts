/**
 * Tiny ANSI color helper for orchestrator logs.
 * Falls back to plain text when stdout isn't a TTY unless FORCE_COLOR is set.
 * watch-live.ts sets FORCE_COLOR=1 so shared watcher logs keep ANSI colors.
 */

const forceColor = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0";
const useColor = !!(process.stdout.isTTY || forceColor);

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

export function wrap(...codes: (string | undefined)[]): (text: string) => string {
  if (!useColor) return (t) => t;
  const prefix = codes.filter(Boolean).join("");
  return (text) => `${prefix}${text}${C.reset}`;
}

export const dim = wrap(C.dim);
export const bold = wrap(C.bold);
export const red = wrap(C.red);
export const green = wrap(C.green);
export const yellow = wrap(C.yellow);
export const blue = wrap(C.blue);
export const magenta = wrap(C.magenta);
export const cyan = wrap(C.cyan);
export const gray = wrap(C.gray);
export const brightRed = wrap(C.brightRed);
export const brightGreen = wrap(C.brightGreen);
export const brightYellow = wrap(C.brightYellow);
export const brightMagenta = wrap(C.brightMagenta);
export const brightCyan = wrap(C.brightCyan);
