/** Convert an application route to its deployed public URL. Router routes stay relative to basename. */
export function applicationUrl(path: string): string {
  const base = import.meta.env.BASE_URL;
  return base.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
}
export function applicationPath(path: string): string {
  const prefix = import.meta.env.BASE_URL.replace(/\/$/, "");
  return prefix && (path === prefix || path.startsWith(prefix + "/")) ? path.slice(prefix.length) || "/" : path;
}
