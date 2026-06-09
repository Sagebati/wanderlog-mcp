import { WanderlogAuthError, WanderlogError, WanderlogNetworkError, WanderlogNotFoundError, } from "../errors.js";
export class RestClient {
    config;
    constructor(config) {
        this.config = config;
    }
    headers(extra = {}) {
        return {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en",
            Cookie: this.config.cookieHeader,
            Origin: this.config.baseUrl,
            Referer: `${this.config.baseUrl}/`,
            "User-Agent": this.config.userAgent,
            ...extra,
        };
    }
    async request(method, path, opts = {}) {
        const url = `${this.config.baseUrl}${path}`;
        const init = {
            method,
            headers: this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        };
        if (opts.body !== undefined)
            init.body = JSON.stringify(opts.body);
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (err) {
            throw new WanderlogNetworkError(`Request to ${method} ${path} failed: ${err.message}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new WanderlogAuthError();
        }
        if (response.status === 404) {
            throw new WanderlogNotFoundError("Resource", path);
        }
        if (response.status >= 500) {
            throw new WanderlogError(`Wanderlog server error ${response.status} on ${path}`, "upstream_error", "This is a Wanderlog server issue; try again in a moment.");
        }
        if (!response.ok) {
            throw new WanderlogError(`Unexpected response ${response.status} on ${method} ${path}`, "unexpected_status");
        }
        try {
            return (await response.json());
        }
        catch (err) {
            throw new WanderlogError(`Failed to parse JSON from ${path}: ${err.message}`, "parse_error");
        }
    }
    async getUser() {
        const env = await this.request("GET", "/api/user");
        if (!env.user || typeof env.user.id !== "number") {
            throw new WanderlogAuthError("No user returned for current session — cookie may be invalid");
        }
        return env.user;
    }
    async listTrips() {
        const env = await this.request("GET", "/api/tripPlans/home");
        return [
            ...(env.ownTripPlans ?? []),
            ...(env.friendsPrivateSharedTripPlans ?? []),
            ...(env.friendsTripPlans ?? []),
        ];
    }
    async getTrip(tripKey) {
        const { tripPlan } = await this.getTripWithResources(tripKey);
        return tripPlan;
    }
    async getTripWithResources(tripKey) {
        const env = await this.request("GET", `/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2&registerView=true`);
        if (!env.tripPlan) {
            throw new WanderlogNotFoundError("Trip", tripKey);
        }
        return { tripPlan: env.tripPlan, geos: env.resources?.geos ?? [] };
    }
    async searchPlacesAutocomplete(args) {
        const request = {
            input: args.input,
            sessiontoken: args.sessionToken,
            location: args.location,
            radius: args.radius,
            language: args.language ?? "en",
        };
        const qs = `request=${encodeURIComponent(JSON.stringify(request))}`;
        const env = await this.request("GET", `/api/placesAPI/autocomplete/v2?${qs}`);
        return env.data ?? [];
    }
    async getPlaceDetails(placeId, language = "en") {
        const env = await this.request("GET", `/api/placesAPI/getPlaceDetails/v2?placeId=${encodeURIComponent(placeId)}&language=${language}`);
        if (!env.data) {
            throw new WanderlogNotFoundError("Place", placeId);
        }
        return env.data;
    }
    async geoAutocomplete(query) {
        const env = await this.request("GET", `/api/geo/autocomplete/${encodeURIComponent(query)}`);
        return env.data ?? [];
    }
    async listGoodGuides() {
        const env = await this.request("GET", "/api/geo/geosWithGoodGuides");
        return env.data ?? [];
    }
    async getGuidesForGeo(geoId) {
        const env = await this.request("GET", `/api/tripPlans/browse/guides/${encodeURIComponent(String(geoId))}`);
        const data = env.data?.geoWithGoodGuides;
        if (!data) {
            throw new WanderlogNotFoundError("Guides", String(geoId));
        }
        return data;
    }
    async getGuideContent(viewKey) {
        try {
            const env = await this.request("GET", `/api/tripPlans/${encodeURIComponent(viewKey)}?clientSchemaVersion=2`);
            if (!env.tripPlan) {
                throw new WanderlogNotFoundError("Guide", viewKey);
            }
            return env.tripPlan;
        }
        catch (err) {
            if (err instanceof WanderlogNotFoundError) {
                throw new WanderlogNotFoundError("Guide", viewKey);
            }
            throw err;
        }
    }
    async createTrip(args) {
        const env = await this.request("POST", "/api/tripPlans", {
            body: {
                geoIds: args.geoIds,
                initialMapsPlaceIds: [],
                initialEmailId: null,
                type: "plan",
                startDate: args.startDate,
                endDate: args.endDate,
                privacy: args.privacy ?? "private",
                isMapEmbed: false,
                title: args.title ?? null,
                language: "en",
            },
        });
        if (!env.data) {
            throw new WanderlogError("Trip creation returned no data", "create_failed");
        }
        return env.data;
    }
    async deleteTrip(tripKey) {
        await this.request("DELETE", `/api/tripPlans/${encodeURIComponent(tripKey)}`);
    }
}
//# sourceMappingURL=rest.js.map