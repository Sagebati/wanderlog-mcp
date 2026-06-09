import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  WanderlogError,
  WanderlogNotFoundError,
  WanderlogValidationError,
} from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { PlaceRefMatch } from "../resolvers/place-ref.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import type { Section, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const movePlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip to modify."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place (or any block) to move. Same syntax as wanderlog_remove_place: partial names, ordinal prefixes ('2nd X', 'last X') and day filters ('X on day 3').",
    ),
  before: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Place reference the block should be moved directly BEFORE. Mutually exclusive with `after`. Combine with `to_day` to disambiguate the anchor.",
    ),
  after: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Place reference the block should be moved directly AFTER. Mutually exclusive with `before`. Combine with `to_day` to disambiguate the anchor.",
    ),
  to_day: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Destination day ('day 2', 'May 4', or '2026-05-04'). Without before/after the block is appended to that day (or use `position`).",
    ),
  position: z
    .enum(["start", "end"])
    .optional()
    .describe(
      "Where in the destination day to place the block when no before/after anchor is given. Defaults to 'end'.",
    ),
};

export const movePlaceDescription = `
Moves a place (or note, hotel, flight — any block) within a Wanderlog trip: reorder it inside
its day, or move it to another day.

Destination is specified by exactly one of:
  - before: "Mackie Academy" — insert directly before that block
  - after: "Dunnottar Castle" — insert directly after that block
  - to_day: "day 6" (+ optional position: "start" | "end") — append to that day

Examples:
  - Reorder within a day: place_ref "Mackie Academy", after "Dunnottar Castle"
  - Move to another day, at the top: place_ref "Fairy Pools", to_day "day 9", position "start"
  - Anchor on a specific day: place_ref "Lunch", before "Quiraing", to_day "Jul 22"

If a reference is ambiguous, the tool lists the candidates and makes NO change — re-call with
an ordinal prefix ("1st X", "2nd X") or a day filter.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  before?: string;
  after?: string;
  to_day?: string;
  position?: "start" | "end";
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export async function movePlace(ctx: AppContext, args: Args): Promise<ToolResult> {
  try {
    if (args.before && args.after) {
      throw new WanderlogValidationError(
        "`before` and `after` are mutually exclusive",
        "Provide only one anchor.",
      );
    }
    if (!args.before && !args.after && !args.to_day) {
      throw new WanderlogValidationError(
        "No destination given",
        "Provide `before`, `after`, or `to_day`.",
      );
    }

    const trip = await ctx.tripCache.get(args.trip_key);

    const source = resolveOrReport(trip, args.place_ref);
    if (!("match" in source)) return source;

    const dest = resolveDestination(trip, args, source.match);
    if (!("sectionIndex" in dest)) return dest;

    const { sectionIndex: fromSection, blockIndex: fromIndex, block } = source.match;
    const { sectionIndex: toSection, insertIndex } = dest;

    const ops = buildMoveOps(fromSection, fromIndex, toSection, insertIndex, block);
    const name = blockName(source.match);

    if (ops.length === 0) {
      return {
        content: [
          { type: "text", text: `${name} is already at that position — nothing to do.` },
        ],
      };
    }

    await submitOp(ctx, args.trip_key, ops);

    const destSection = trip.itinerary.sections[toSection]!;
    const text = `Moved ${name} to ${formatLocation(destSection)} in "${trip.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/**
 * Builds the JSON0 ops for the move. Same section → a single `lm` (the
 * destination index is interpreted post-removal, so indices after the source
 * shift down by one). Cross-section → `ld` + `li`; the two paths touch
 * different arrays, so the insert index is unaffected by the removal.
 */
export function buildMoveOps(
  fromSection: number,
  fromIndex: number,
  toSection: number,
  insertIndex: number,
  block: unknown,
): Json0Op[] {
  if (fromSection === toSection) {
    const to = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
    if (to === fromIndex) return [];
    return [
      {
        p: ["itinerary", "sections", fromSection, "blocks", fromIndex],
        lm: to,
      },
    ];
  }
  return [
    {
      p: ["itinerary", "sections", fromSection, "blocks", fromIndex],
      ld: block,
    },
    {
      p: ["itinerary", "sections", toSection, "blocks", insertIndex],
      li: block,
    },
  ];
}

type Destination = { sectionIndex: number; insertIndex: number };

function resolveDestination(
  trip: TripPlan,
  args: Args,
  source: PlaceRefMatch,
): Destination | ToolResult {
  const anchorRef = args.before ?? args.after;

  if (anchorRef) {
    const scopedRef = args.to_day ? `${anchorRef} on ${args.to_day}` : anchorRef;
    const anchor = resolveOrReport(trip, scopedRef);
    if (!("match" in anchor)) return anchor;

    if (
      anchor.match.sectionIndex === source.sectionIndex &&
      anchor.match.blockIndex === source.blockIndex
    ) {
      throw new WanderlogValidationError(
        "Anchor and moved place are the same block",
        "Pick a different before/after anchor.",
      );
    }

    return {
      sectionIndex: anchor.match.sectionIndex,
      insertIndex: args.after
        ? anchor.match.blockIndex + 1
        : anchor.match.blockIndex,
    };
  }

  const section = resolveDay(trip, args.to_day!);
  const sectionIndex = trip.itinerary.sections.indexOf(section);
  if (sectionIndex === -1) {
    throw new WanderlogError(
      "Resolved day section not found in trip",
      "day_resolution_failed",
    );
  }
  return {
    sectionIndex,
    insertIndex: args.position === "start" ? 0 : section.blocks.length,
  };
}

function resolveOrReport(
  trip: TripPlan,
  ref: string,
): { match: PlaceRefMatch } | ToolResult {
  const result = resolvePlaceRef(trip, ref);

  if (result.kind === "none") {
    throw new WanderlogNotFoundError("Place", ref);
  }

  if (result.kind === "ambiguous") {
    const lines = result.candidates
      .slice(0, 10)
      .map((c, i) => {
        const name = blockName(c);
        return `  ${i + 1}. ${name} — ${formatLocation(c.section)}`;
      })
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `"${ref}" matches ${result.candidates.length} places:\n${lines}\n\nRe-call with an ordinal prefix ("1st X", "2nd X", "last X") or a day filter ("X on day 2") to pick one.`,
        },
      ],
      isError: true,
    };
  }

  return { match: result.match };
}

function blockName(match: PlaceRefMatch): string {
  return isPlaceBlock(match.block)
    ? match.block.place.name
    : `${match.block.type} block`;
}

function formatLocation(section: Section): string {
  if (section.mode === "dayPlan" && section.date) {
    return `day ${section.date}`;
  }
  if (section.heading) return `"${section.heading}"`;
  return `"${section.type ?? "section"}"`;
}
