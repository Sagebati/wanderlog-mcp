import { z } from "zod";
import { WanderlogError } from "../errors.js";
import { formatTripList } from "../formatters/trip-summary.js";
export const listTripsInputSchema = {
    response_format: z
        .enum(["concise", "detailed"])
        .default("concise")
        .describe("Output verbosity. 'concise' (default) gives a one-line summary per trip; 'detailed' includes key, owner, and last-edited time."),
};
export const listTripsDescription = `
Lists all Wanderlog trips in the authenticated user's account (owned and shared-with-you).

Returns a compact list with title, dates, place count, and trip_key. Use this tool first when
the user mentions a trip by name but you don't have its trip_key yet — the key is required by
wanderlog_get_trip and wanderlog_search_places.

Each line includes a [key: ...] suffix — extract that key for downstream tool calls.
`.trim();
export async function listTrips(ctx, args) {
    try {
        const trips = await ctx.rest.listTrips();
        const text = formatTripList(trips, args.response_format ?? "concise");
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        const e = err instanceof WanderlogError
            ? err.toUserMessage()
            : `Unexpected error: ${err.message}`;
        return { content: [{ type: "text", text: e }], isError: true };
    }
}
//# sourceMappingURL=list-trips.js.map