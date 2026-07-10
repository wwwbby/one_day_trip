import { describe, expect, it } from "vitest";
import { anitabiPointToStop, normalizeDayPlan, patchStopKind, stopKindLabel } from "./stops";

describe("stop normalization", () => {
  it("imports Anitabi points as pilgrimage stops with fixed default visit rules", () => {
    const imported = anitabiPointToStop(
      {
        id: 42,
        name: "踏切",
        lat: 35.1,
        lng: 139.2,
        image: "https://example.com/shot.jpg",
        ep: 7
      },
      { id: 1, cn: "某作品" }
    );

    expect(imported?.role).toBe("pilgrimage");
    expect(imported?.stayMinutes).toBe(5);
    expect(imported?.note).toBe("巡礼");
    expect(imported?.workTitle).toBe("某作品");
  });

  it("migrates legacy Anitabi-like stops to pilgrimage role", () => {
    const plan = normalizeDayPlan({
      id: "plan",
      name: "test",
      tripDate: "2026-07-19",
      stops: [
        {
          id: "old",
          name: "old",
          location: { lat: 35, lng: 139 },
          source: "Anitabi",
          stayMinutes: 20
        }
      ]
    });

    expect(plan?.stops[0].role).toBe("pilgrimage");
  });

  it("keeps type names stable for the UI", () => {
    const stop = patchStopKind(
      {
        id: "normal",
        name: "normal",
        location: { lat: 35, lng: 139 },
        stayMinutes: 5,
        role: "normal"
      },
      "normal"
    );

    expect(stopKindLabel(stop)).toBe("普通点");
  });
});
