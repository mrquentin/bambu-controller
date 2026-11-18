function current() {
  return location.hash.replace(/^#/, '') || '/';
}

export const route = $state({ path: current() });

window.addEventListener('hashchange', () => {
  route.path = current();
});

export function navigate(path: string) {
  location.hash = path;
}

/** Match a pattern like "/printer/:id" against the current path. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
