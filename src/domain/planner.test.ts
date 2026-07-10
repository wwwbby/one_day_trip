import { describe, expect, it } from "vitest";
import {
  activeRouteAlternativeIndex,
  buildAutoRouteRequest,
  buildSchedule,
  optimizeDayOrder,
  rebuildRoutePlanFromLegs,
  repairOrderWithActualLegs,
  selectRouteAlternative
} from "./planner";
import { createStop } from "./stops";
import type { RouteLeg, Stop } from "./types";

function stop(id: string, input: Partial<Stop> = {}) {
  return createStop({
    id,
    name: id,
    location: { lat: 35, lng: 139 },
    stayMinutes: 5,
    ...input
  });
}

function estimator(table: Record<string, number>) {
  return (from: Stop, to: Stop) => table[`${from.id}->${to.id}`] ?? 20;
}

describe("route planner fixed-point constraints", () => {
  it("moves flexible stops after a fixed stop when they would make the fixed stop late", () => {
    const start = stop("start", { isStart: true, windowStart: "09:00", stayMinutes: 0 });
    const nearby = stop("nearby");
    const tooMuch = stop("too-much");
    const fixed = stop("fixed", { role: "fixed", windowStart: "10:00", stayMinutes: 30 });
    const end = stop("end", { role: "end", isEnd: true, stayMinutes: 0 });

    const result = optimizeDayOrder([start, nearby, tooMuch, fixed, end], {
      tripDate: "2026-07-19",
      startTime: "09:00",
      estimator: estimator({
        "start->nearby": 10,
        "nearby->fixed": 30,
        "start->too-much": 10,
        "too-much->fixed": 50,
        "nearby->too-much": 10,
        "too-much->end": 10,
        "fixed->too-much": 10,
        "fixed->end": 10
      })
    });

    expect(result.orderedStops.map((item) => item.id)).toEqual([
      "start",
      "nearby",
      "fixed",
      "too-much",
      "end"
    ]);
    expect(result.movedAfterFixedStopIds).toEqual(["too-much"]);
    expect(result.schedule.find((item) => item.stop.id === "fixed")?.isLate).toBe(false);
  });

  it("marks a fixed stop impossible when even going directly cannot arrive on time", () => {
    const start = stop("start", { isStart: true, windowStart: "09:00", stayMinutes: 0 });
    const fixed = stop("fixed", { role: "fixed", windowStart: "09:10", stayMinutes: 20 });

    const result = optimizeDayOrder([start, fixed], {
      tripDate: "2026-07-19",
      startTime: "09:00",
      estimator: estimator({
        "start->fixed": 25
      })
    });

    expect(result.impossibleFixedStopIds).toEqual(["fixed"]);
    expect(result.schedule.find((item) => item.stop.id === "fixed")?.lateByMinutes).toBe(15);
  });

  it("uses max(actual arrival, fixed start) plus stay time before leaving a fixed stop", () => {
    const start = stop("start", { isStart: true, windowStart: "09:00", stayMinutes: 0 });
    const fixed = stop("fixed", { role: "fixed", windowStart: "10:00", stayMinutes: 30 });
    const next = stop("next", { stayMinutes: 5 });
    const legs: RouteLeg[] = [
      { distanceMeters: 1000, durationSeconds: 20 * 60 },
      { distanceMeters: 1000, durationSeconds: 15 * 60 }
    ];

    const schedule = buildSchedule([start, fixed, next], {
      tripDate: "2026-07-19",
      startTime: "09:00"
    }, legs);

    expect(schedule[1].arrivalMinutes).toBe(9 * 60 + 20);
    expect(schedule[1].visitStartMinutes).toBe(10 * 60);
    expect(schedule[1].departureMinutes).toBe(10 * 60 + 30);
    expect(schedule[2].arrivalMinutes).toBe(10 * 60 + 45);
  });

  it("builds route request time from start time plus start stay minutes", () => {
    const start = stop("start", { isStart: true, windowStart: "09:00", stayMinutes: 15 });
    const next = stop("next");

    const request = buildAutoRouteRequest([start, next], {
      tripDate: "2026-07-19",
      startTime: "09:00"
    });

    expect(request.transitLocalDateTime).toBe("2026-07-19T09:15:00");
    expect(request.expectedLegs).toBe(1);
  });

  it("repairs actual-route lateness by moving the last flexible stop before the late fixed stop", () => {
    const start = stop("start", { isStart: true, windowStart: "09:00", stayMinutes: 0 });
    const a = stop("a");
    const b = stop("b");
    const fixed = stop("fixed", { role: "fixed", windowStart: "10:00", stayMinutes: 20 });
    const order = [start, a, b, fixed];
    const legs: RouteLeg[] = [
      { distanceMeters: 1, durationSeconds: 10 * 60 },
      { distanceMeters: 1, durationSeconds: 20 * 60 },
      { distanceMeters: 1, durationSeconds: 35 * 60 }
    ];

    const repaired = repairOrderWithActualLegs(order, legs, {
      tripDate: "2026-07-19",
      startTime: "09:00"
    });

    expect(repaired.movedStopId).toBe("b");
    expect(repaired.order.map((item) => item.id)).toEqual(["start", "a", "fixed", "b"]);
  });

  it("rebuilds route totals and geometry after selecting a route alternative", () => {
    const start = stop("start", { isStart: true });
    const middle = stop("middle");
    const end = stop("end", { role: "end", isEnd: true });
    const selectedAlternative: RouteLeg = {
      distanceMeters: 2000,
      durationSeconds: 900,
      coordinates: [
        [35, 139],
        [35.1, 139.1]
      ],
      summary: "alternative"
    };
    const routePlan = rebuildRoutePlanFromLegs(
      {
        distanceMeters: 0,
        durationSeconds: 0,
        legs: [
          selectedAlternative,
          {
            distanceMeters: 3000,
            durationSeconds: 1200,
            coordinates: [
              [35.1, 139.1],
              [35.2, 139.2]
            ],
            summary: "next"
          }
        ]
      },
      [start, middle, end]
    );

    expect(routePlan.distanceMeters).toBe(5000);
    expect(routePlan.durationSeconds).toBe(2100);
    expect(routePlan.coordinates).toEqual([
      [35, 139],
      [35.1, 139.1],
      [35.2, 139.2]
    ]);
    expect(routePlan.routeStopIds).toEqual(["start", "middle", "end"]);
  });

  it("selects a transit alternative for one leg and recalculates the whole route plan", () => {
    const start = stop("start", { isStart: true });
    const middle = stop("middle");
    const end = stop("end", { role: "end", isEnd: true });
    const fastAlternative: RouteLeg = {
      distanceMeters: 4000,
      durationSeconds: 1800,
      coordinates: [
        [35, 139],
        [35.05, 139.05]
      ],
      summary: "fast train",
      mode: "TRANSIT",
      transfers: 1,
      fare: 300
    };
    const cheapAlternative: RouteLeg = {
      distanceMeters: 4500,
      durationSeconds: 2100,
      coordinates: [
        [35, 139],
        [35.03, 139.03],
        [35.05, 139.05]
      ],
      summary: "cheap subway",
      mode: "TRANSIT",
      transfers: 2,
      fare: 180
    };
    const routePlan = rebuildRoutePlanFromLegs(
      {
        distanceMeters: 0,
        durationSeconds: 0,
        legs: [
          {
            ...fastAlternative,
            alternatives: [fastAlternative, cheapAlternative],
            selectedAlternativeIndex: 0,
            preferredMode: "TRANSIT",
            directDistanceMeters: 3600
          },
          {
            distanceMeters: 900,
            durationSeconds: 600,
            coordinates: [
              [35.05, 139.05],
              [35.07, 139.07]
            ],
            summary: "walk",
            mode: "WALK"
          }
        ]
      },
      [start, middle, end]
    );

    const selected = selectRouteAlternative(routePlan, [start, middle, end], 0, 1);

    expect(selected.legs[0].summary).toBe("cheap subway");
    expect(selected.legs[0].selectedAlternativeIndex).toBe(1);
    expect(selected.legs[0].alternatives).toHaveLength(2);
    expect(selected.legs[0].preferredMode).toBe("TRANSIT");
    expect(selected.legs[0].directDistanceMeters).toBe(3600);
    expect(activeRouteAlternativeIndex(selected.legs[0])).toBe(1);
    expect(selected.distanceMeters).toBe(5400);
    expect(selected.durationSeconds).toBe(2700);
    expect(selected.coordinates).toEqual([
      [35, 139],
      [35.03, 139.03],
      [35.05, 139.05],
      [35.07, 139.07]
    ]);
  });
});
