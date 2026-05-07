export function isCatallaxyInterfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CATALLAXY_INTERFACE === "1" || env.CATALLAXY_INTERFACE === "true";
}
