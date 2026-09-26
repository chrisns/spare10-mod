// A module resolve hook: hooks/core/host.ts resolves to codex/src/host.ts (the Codex host words).
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx)
  return r.url.endsWith('/hooks/core/host.ts') ? { ...r, url: new URL('../src/host.ts', import.meta.url).href } : r
}
