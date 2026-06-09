import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { buildMoveOps, movePlace } from "../../src/tools/move-place.ts";
import type { TripPlan } from "../../src/types.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
} {
  const submittedOps: Json0Op[][] = [];
  const ctx = {
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      get: async () => structuredClone(trip),
      applyLocalOp: () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps };
}

describe("buildMoveOps", () => {
  it("uses a single lm op for a same-section move", () => {
    const ops = buildMoveOps(4, 0, 4, 2, { id: 1 });
    expect(ops).toEqual([
      { p: ["itinerary", "sections", 4, "blocks", 0], lm: 1 },
    ]);
  });

  it("returns no ops when the move is a no-op", () => {
    // Inserting at its own index, or right after itself, changes nothing.
    expect(buildMoveOps(4, 1, 4, 1, { id: 1 })).toEqual([]);
    expect(buildMoveOps(4, 1, 4, 2, { id: 1 })).toEqual([]);
  });

  it("does not shift the lm target when moving backwards", () => {
    const ops = buildMoveOps(4, 3, 4, 1, { id: 1 });
    expect(ops).toEqual([
      { p: ["itinerary", "sections", 4, "blocks", 3], lm: 1 },
    ]);
  });

  it("uses ld + li for a cross-section move", () => {
    const block = { id: 42 };
    const ops = buildMoveOps(4, 0, 5, 0, block);
    expect(ops).toEqual([
      { p: ["itinerary", "sections", 4, "blocks", 0], ld: block },
      { p: ["itinerary", "sections", 5, "blocks", 0], li: block },
    ]);
  });
});

describe("movePlace", () => {
  it("moves a place to another (empty) day", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Sensō-ji",
      to_day: "2025-11-14",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Moved Sensō-ji");
    expect(result.content[0]!.text).toContain("2025-11-14");
    expect(submittedOps).toHaveLength(1);

    // The submitted ops must actually produce the expected document.
    const after = applyOp(structuredClone(mixedBlocksTrip), submittedOps[0]!);
    const source = after.itinerary.sections[4]!;
    const dest = after.itinerary.sections[5]!;
    expect(source.blocks.some((b) => b.id === 10001)).toBe(false);
    expect(dest.blocks).toHaveLength(1);
    expect(dest.blocks[0]!.id).toBe(10001);
  });

  it("moves a place to the start of a day with position", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Sensō-ji",
      to_day: "2025-11-15",
      position: "start",
    });

    expect(result.isError).toBeUndefined();
    const after = applyOp(structuredClone(mixedBlocksTrip), submittedOps[0]!);
    const dest = after.itinerary.sections[6]!;
    expect(dest.blocks[0]!.id).toBe(10001);
    expect(dest.blocks).toHaveLength(2);
  });

  it("rejects when both before and after are given", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Sensō-ji",
      before: "X",
      after: "Y",
    });

    expect(result.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("rejects when no destination is given", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Sensō-ji",
    });

    expect(result.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("reports not-found for an unknown place", async () => {
    const { ctx, submittedOps } = makeFakeContext(mixedBlocksTrip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Atlantis Resort",
      to_day: "2025-11-14",
    });

    expect(result.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("moves a place after an anchor in another day", async () => {
    const trip = structuredClone(mixedBlocksTrip);
    // Add a second place on 2025-11-15 so we can anchor against it.
    trip.itinerary.sections[6]!.blocks.push({
      id: 30001,
      type: "place",
      place: {
        name: "Meiji Shrine",
        place_id: "ChIJzzz",
        geometry: { location: { lat: 35.6764, lng: 139.6993 } },
      },
    } as unknown as TripPlan["itinerary"]["sections"][0]["blocks"][0]);

    const { ctx, submittedOps } = makeFakeContext(trip);

    const result = await movePlace(ctx, {
      trip_key: "k",
      place_ref: "Sensō-ji",
      after: "Meiji Shrine",
    });

    expect(result.isError).toBeUndefined();
    const after = applyOp(structuredClone(trip), submittedOps[0]!);
    const dest = after.itinerary.sections[6]!;
    const ids = dest.blocks.map((b) => b.id);
    expect(ids.indexOf(10001)).toBe(ids.indexOf(30001) + 1);
  });
});
