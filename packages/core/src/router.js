/** Minimal router: exact segments and `:param` captures. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler, opts, pattern });
  }

  #matchSegments(route, parts) {
    if (route.segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) {
        try {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          return null;
        }
      } else if (seg !== parts[i]) {
        return null;
      }
    }
    return params;
  }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = this.#matchSegments(route, parts);
      if (params) return { handler: route.handler, opts: route.opts, params };
    }
    return null;
  }

  hasPath(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    return this.routes.some((r) => this.#matchSegments(r, parts));
  }
}
