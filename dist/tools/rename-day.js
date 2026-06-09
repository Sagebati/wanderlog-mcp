import { z } from "zod";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { resolveDay } from "../resolvers/day.js";
import { findDaySectionByDate, submitOp } from "./shared.js";
export const renameDayInputSchema = {
    trip_key: z.string().min(1).describe("The trip containing the day to rename."),
    day: z
        .string()
        .min(1)
        .describe('Which day to rename. Accepts "day 3", "May 4", or "2026-05-04".'),
    heading: z
        .string()
        .describe('New heading for the day. Use "" (empty string) to clear the heading back to the auto-generated default.'),
};
export const renameDayDescription = `
Renames the heading/subheading of a specific day in a Wanderlog trip.

Day headings appear in the itinerary as the title for each day section (e.g. "Barcelona",
"Ronda + Malaga"). Use this tool to replace them with more descriptive titles.

Pass an empty string for "heading" to reset the day back to Wanderlog's auto-generated heading.
`.trim();
export async function renameDay(ctx, args) {
    try {
        const entry = await ctx.tripCache.getEntry(args.trip_key);
        const trip = entry.snapshot;
        const daySection = resolveDay(trip, args.day);
        const found = findDaySectionByDate(trip, daySection.date);
        if (!found) {
            throw new WanderlogValidationError(`Day ${args.day} not found in trip`);
        }
        const oldHeading = found.section.heading;
        const newHeading = args.heading;
        if (oldHeading === newHeading) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Day ${daySection.date} heading is already "${newHeading}" — no change made.`,
                    },
                ],
            };
        }
        const ops = [
            {
                p: ["itinerary", "sections", found.index, "heading"],
                od: oldHeading,
                oi: newHeading,
            },
        ];
        await submitOp(ctx, args.trip_key, ops);
        const oldLabel = oldHeading || "(auto-generated)";
        const newLabel = newHeading || "(auto-generated)";
        const text = `Renamed day ${daySection.date} in "${trip.title}": "${oldLabel}" → "${newLabel}"`;
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        const msg = err instanceof WanderlogError
            ? err.toUserMessage()
            : `Unexpected error: ${err.message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
    }
}
//# sourceMappingURL=rename-day.js.map