import { TripCache } from "./cache/trip-cache.js";
import { loadConfig } from "./config.js";
import { RestClient } from "./transport/rest.js";
import { ShareDBPool } from "./transport/sharedb.js";
export function createContext() {
    const config = loadConfig();
    const rest = new RestClient(config);
    const pool = new ShareDBPool(config);
    const tripCache = new TripCache(rest, pool);
    return { config, rest, pool, tripCache, authenticated: false };
}
//# sourceMappingURL=context.js.map