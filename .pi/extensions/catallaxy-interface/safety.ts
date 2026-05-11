const SAFE_FIRST_WORDS = new Set([
  "pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "file", "tree",
]);

const UNSAFE_SHELL_TOKENS = /(?:^|\s)(?:>|>>|2>|&>|tee|xargs|rm|mv|cp|mkdir|touch|chmod|chown|ln|install|git\s+(?:add|commit|checkout|switch|reset|clean|merge|rebase|apply|am|stash|branch\s+-D)|bun\s+(?:install|add|remove|x)|npm\s+(?:install|i|add|remove|run)|pnpm\s+(?:install|add|remove|run)|yarn\s+(?:install|add|remove|run))(?:\s|$)/;

export function isSafePlanningBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (UNSAFE_SHELL_TOKENS.test(trimmed)) return false;
  if (/[;&|`$()]/.test(trimmed.replace(/\|\s*(?:head|tail|grep|rg|wc|sed)\b/g, ""))) return false;

  const first = trimmed.split(/\s+/)[0] ?? "";
  if (SAFE_FIRST_WORDS.has(first)) return true;

  if (/^sed\s+-n\b/.test(trimmed)) return true;
  if (/^git\s+(status|diff|log|show|grep)\b/.test(trimmed)) return true;
  if (/^git\s+branch\s+--show-current\b/.test(trimmed)) return true;

  return false;
}

export function isWriteTool(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}
