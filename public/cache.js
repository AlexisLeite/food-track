import { QueryClient, dehydrate, hydrate, isCancelledError } from './vendor/query-core.js';
export { isCancelledError };
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const normalized = url => { const value = new URL(url, 'https://foodtrack.local'); value.searchParams.sort(); return value.pathname + value.search; };
function browserStorage() { try { return globalThis.localStorage || null; } catch { return null; } }
export function createUserCache({ storage = browserStorage(), staleTime = 0, gcTime = 600000, maxAge = 86400000 } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime, gcTime, retry: false, networkMode: 'always' } } });
  let owner = null, timer;
  const storageKey = id => `foodtrack:cache:v3:${id}`;
  const key = url => ['foodtrack', owner, normalized(url)];
  function persist() {
    clearTimeout(timer);
    if (!owner || !storage) return;
    try { storage.setItem(storageKey(owner), JSON.stringify({ version: 3, savedAt: Date.now(), owner, state: dehydrate(client, { shouldDehydrateQuery: query => query.state.data !== undefined }) })); } catch { /* Storage unavailable: keep the in-memory cache usable. */ }
  }
  client.getQueryCache().subscribe(event => {
    if (owner && (event.type === 'updated' || event.type === 'removed')) { clearTimeout(timer); timer = setTimeout(persist, 100); }
  });
  function clear(remove = false) {
    const previous = owner; owner = null; clearTimeout(timer); client.clear();
    if (remove && previous && storage) { try { storage.removeItem(storageKey(previous)); } catch {} }
  }
  return {
    setUser(id) {
      if (owner === id) return;
      persist(); clear(); owner = id;
      if (!id || !storage) return;
      try {
        const raw = storage.getItem(storageKey(id));
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.version !== 3 || saved.owner !== id || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > maxAge) { storage.removeItem(storageKey(id)); return; }
        // Only hydrate this account's entries; no global or other-account queries.
        saved.state.queries = saved.state.queries.filter(q => q.queryKey?.[0] === 'foodtrack' && q.queryKey[1] === id);
        hydrate(client, saved.state);
      } catch { try { storage.removeItem(storageKey(id)); } catch {} }
    },
    peek(url) { return owner ? clone(client.getQueryData(key(url))?.data) : undefined; },
    async fetch(url, load) {
      if (!owner) return load({});
      const data = await client.fetchQuery({ queryKey: key(url), queryFn: ({ signal }) => load({ signal, known: clone(client.getQueryData(key(url))) }) });
      return clone(data.data);
    },
    setProfile(profile) { if (owner) client.setQueryData(key('/api/profile'), { data: clone(profile), etag: null }); },
    invalidate(section, date) {
      if (!owner) return;
      client.removeQueries({ predicate: q => {
        if (q.queryKey[0] !== 'foodtrack' || q.queryKey[1] !== owner) return false;
        if (!section) return true;
        const url = new URL(q.queryKey[2], 'https://foodtrack.local');
        return url.pathname === `/api/${section}` && (!date || url.searchParams.get('date') === date);
      } });
      persist();
    },
    persist, clear,
    destroy() { persist(); clear(); }
  };
}
