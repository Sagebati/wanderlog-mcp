import { z } from "zod";
import { WanderlogError } from "../errors.js";
export const getTripUrlInputSchema = {
    trip_key: z
        .string()
        .min(1)
        .describe("The trip key from wanderlog_list_trips."),
    mode: z
        .enum(["edit", "view", "suggest"])
        .default("edit")
        .describe("Which link variant to return. 'edit' (default) is the primary link with full permissions. 'view' is a read-only share link. 'suggest' is a suggest-mode share link where collaborators can propose changes."),
};
export const getTripUrlDescription = `
Returns the wanderlog.com URL for a trip so the user can open it in a browser.

Three link variants are available via the mode parameter:
  - edit    (default) — full-permission link for the owner
  - view    — read-only link that's safe to share with anyone
  - suggest — suggest-mode link where collaborators can propose changes

If you don't know which mode the user wants, default to edit.
`.trim();
export function pickKey(trip, mode) {
    if (mode === "view")
        return trip.viewKey ?? trip.editKey ?? trip.key;
    if (mode === "suggest")
        return trip.suggestKey ?? trip.editKey ?? trip.key;
    return trip.editKey ?? trip.key;
}
export function buildTripUrl(trip, mode, baseUrl = "https://wanderlog.com") {
    return `${baseUrl}/plan/${pickKey(trip, mode)}`;
}
export async function getTripUrl(ctx, args) {
    try {
        const trip = await ctx.tripCache.get(args.trip_key);
        const mode = args.mode ?? "edit";
        const url = buildTripUrl(trip, mode, ctx.config.baseUrl);
        const suffix = mode === "view"
            ? "\n(Read-only link — safe to share.)"
            : mode === "suggest"
                ? "\n(Suggest-mode link — collaborators can propose changes.)"
                : "";
        return { content: [{ type: "text", text: `${url}${suffix}` }] };
    }
    catch (err) {
        const msg = err instanceof WanderlogError
            ? err.toUserMessage()
            : `Unexpected error: ${err.message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
    }
}
//# sourceMappingURL=get-trip-url.js.map