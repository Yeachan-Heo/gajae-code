export const RECENT_PATH_LIMIT = 10;

export function recentPaths(records, limit = RECENT_PATH_LIMIT) {
  const ordered = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
  const seen = new Set();
  const paths = [];
  for (const record of ordered) {
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length === limit) break;
  }
  return paths;
}

export function selectedNavigationPath(paths, index) {
  if (paths.length === 0) return null;
  const normalized = ((index % paths.length) + paths.length) % paths.length;
  return paths[normalized];
}

export function moveNavigation(paths, index, delta) {
  if (paths.length === 0) return { index: 0, path: null };
  const next = ((index + delta) % paths.length + paths.length) % paths.length;
  return { index: next, path: paths[next] };
}
