import { applyOp } from "../ot/apply.js";
/**
 * Live trip cache. On first access, validates the trip exists via REST
 * (fast 404 path for bad keys), then subscribes via ShareDBPool for live
 * updates. Incoming remote ops are applied to the cached doc so reads stay
 * current without refetching.
 *
 * Callers can read `entry.snapshot` and `entry.version` to prepare submit
 * ops with the correct version vector.
 */
export class TripCache {
    rest;
    pool;
    entries = new Map();
    subscribing = new Map();
    /**
     * Trips whose client listeners are already registered. subscribeAndCache
     * can run again for the same trip after invalidate(); registering the
     * remoteOp listener twice would double-apply every incoming op.
     */
    wired = new Set();
    constructor(rest, pool) {
        this.rest = rest;
        this.pool = pool;
    }
    async get(tripKey) {
        const entry = await this.ensureEntry(tripKey);
        return entry.snapshot;
    }
    async getEntry(tripKey) {
        return this.ensureEntry(tripKey);
    }
    async ensureEntry(tripKey) {
        const existing = this.entries.get(tripKey);
        if (existing)
            return existing;
        const pending = this.subscribing.get(tripKey);
        if (pending)
            return pending;
        const promise = this.subscribeAndCache(tripKey);
        this.subscribing.set(tripKey, promise);
        try {
            return await promise;
        }
        finally {
            this.subscribing.delete(tripKey);
        }
    }
    async subscribeAndCache(tripKey) {
        // REST pre-check: fails fast with 404 → WanderlogNotFoundError.
        // Without this, a bogus trip key hangs on the WS subscribe timeout.
        // The response also gives us the trip's associated geos, which the
        // WebSocket snapshot doesn't include — we store them for search biasing.
        const { geos } = await this.rest.getTripWithResources(tripKey);
        const client = this.pool.get(tripKey);
        const snapshot = await client.subscribe();
        const entry = { snapshot, version: client.version, geos };
        this.entries.set(tripKey, entry);
        if (!this.wired.has(tripKey)) {
            this.wired.add(tripKey);
            client.on("remoteOp", (ops, version) => {
                const current = this.entries.get(tripKey);
                if (!current)
                    return;
                try {
                    current.snapshot = applyOp(current.snapshot, ops);
                    current.version = version;
                }
                catch {
                    // If a remote op fails to apply to our snapshot, our view is stale.
                    // Drop the entry; next get() re-subscribes from a fresh snapshot.
                    this.entries.delete(tripKey);
                }
            });
            // After a reconnect the client resubscribed and holds a fresh server
            // snapshot; ops may have been missed while the connection was down, so
            // replace our copy instead of patching it.
            client.on("reconnected", () => {
                const current = this.entries.get(tripKey);
                const fresh = client.currentSnapshot;
                if (!current)
                    return;
                if (fresh) {
                    current.snapshot = fresh;
                    current.version = client.version;
                }
                else {
                    this.entries.delete(tripKey);
                }
            });
        }
        return entry;
    }
    /**
     * Called after submitting an op ourselves. Applies the op locally and
     * bumps the version so the cache matches what the server just accepted.
     */
    applyLocalOp(tripKey, ops, newVersion) {
        const entry = this.entries.get(tripKey);
        if (!entry)
            return;
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = newVersion;
    }
    invalidate(tripKey) {
        this.entries.delete(tripKey);
    }
    clear() {
        this.entries.clear();
    }
}
//# sourceMappingURL=trip-cache.js.map