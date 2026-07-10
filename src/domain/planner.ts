import { estimateTravelMinutes } from "./geo";
import { formatClock, localDateTimeString, parseClock } from "./time";
import {
  isEndStop,
  isFixedStop,
  isFlexibleStop,
  isStartStop,
  stopKindLabel,
  stopVisitMinutes
} from "./stops";
import type { PlannerResult, PlannerWarning, RouteLeg, RoutePlan, ScheduleItem, Stop } from "./types";

export type TravelEstimator = (from: Stop, to: Stop) => number;

export type PlannerOptions = {
  tripDate: string;
  startTime: string;
  estimator?: TravelEstimator;
  fixedArrivalBufferMinutes?: number;
};

export type AutoRouteRequest = {
  stops: Stop[];
  transitLocalDateTime: string;
  transitTimePreference: "departure";
  expectedLegs: number;
};

export function getStartStop(stops: Stop[]) {
  return stops.find(isStartStop) || stops[0];
}

export function getEndStop(stops: Stop[], start?: Stop) {
  const endStops = stops.filter((stop) => isEndStop(stop) && stop.id !== start?.id);
  return endStops[endStops.length - 1];
}

export function startVisitStartMinutes(stop: Stop | undefined, options: PlannerOptions) {
  return parseClock(stop?.windowStart || options.startTime || "09:00");
}

export function fixedTargetMinutes(stop: Stop, options: PlannerOptions) {
  return parseClock(stop.windowStart || options.startTime || "09:00");
}

function travelMinutes(from: Stop, to: Stop, options: PlannerOptions) {
  return Math.max(0, Math.ceil((options.estimator || estimateTravelMinutes)(from, to)));
}

function departureAfterVisit(stop: Stop, arrivalMinutes: number, options: PlannerOptions) {
  const visitStart = isFixedStop(stop)
    ? Math.max(arrivalMinutes, fixedTargetMinutes(stop, options))
    : arrivalMinutes;
  return visitStart + stopVisitMinutes(stop);
}

function simulateInsertBeforeFixed(
  current: Stop,
  currentDepartureMinutes: number,
  candidate: Stop,
  fixed: Stop,
  options: PlannerOptions
) {
  const arrivalCandidate = currentDepartureMinutes + travelMinutes(current, candidate, options);
  const departureCandidate = departureAfterVisit(candidate, arrivalCandidate, options);
  const arrivalFixed = departureCandidate + travelMinutes(candidate, fixed, options);
  const target = fixedTargetMinutes(fixed, options) - (options.fixedArrivalBufferMinutes || 0);
  return {
    arrivalCandidate,
    departureCandidate,
    arrivalFixed,
    feasible: arrivalFixed <= target,
    score:
      travelMinutes(current, candidate, options) +
      travelMinutes(candidate, fixed, options) * 0.72 +
      stopVisitMinutes(candidate) * 0.18
  };
}

function sortFixedStops(stops: Stop[], options: PlannerOptions) {
  return [...stops].sort((a, b) => fixedTargetMinutes(a, options) - fixedTargetMinutes(b, options));
}

function nearestNext(current: Stop, candidates: Stop[], options: PlannerOptions) {
  return candidates.reduce<Stop | null>((best, candidate) => {
    if (!best) return candidate;
    const candidateScore = travelMinutes(current, candidate, options) + stopVisitMinutes(candidate) * 0.1;
    const bestScore = travelMinutes(current, best, options) + stopVisitMinutes(best) * 0.1;
    return candidateScore < bestScore ? candidate : best;
  }, null);
}

export function optimizeDayOrder(stops: Stop[], options: PlannerOptions): PlannerResult {
  if (stops.length === 0) {
    return {
      orderedStops: [],
      schedule: [],
      movedAfterFixedStopIds: [],
      impossibleFixedStopIds: [],
      warnings: []
    };
  }

  const warnings: PlannerWarning[] = [];
  const start = getStartStop(stops);
  if (!stops.some(isStartStop)) {
    warnings.push({
      code: "missing-start",
      message: "没有设置起点，已临时使用第一个地点作为出发点。"
    });
  }

  const end = getEndStop(stops, start);
  const remaining = stops.filter((stop) => stop.id !== start.id && stop.id !== end?.id);
  const fixedStops = sortFixedStops(remaining.filter(isFixedStop), options);
  let flexibleStops = remaining.filter((stop) => !isFixedStop(stop) && !isEndStop(stop));
  const movedAfterFixedStopIds: string[] = [];
  const impossibleFixedStopIds: string[] = [];
  const order: Stop[] = [start];
  let current = start;
  let currentDeparture = startVisitStartMinutes(start, options) + stopVisitMinutes(start);

  for (const fixed of fixedStops) {
    while (flexibleStops.length > 0) {
      const feasibleCandidates = flexibleStops
        .map((candidate) => ({
          candidate,
          simulation: simulateInsertBeforeFixed(current, currentDeparture, candidate, fixed, options)
        }))
        .filter((item) => item.simulation.feasible)
        .sort((a, b) => a.simulation.score - b.simulation.score);

      if (!feasibleCandidates.length) break;

      const next = feasibleCandidates[0];
      order.push(next.candidate);
      flexibleStops = flexibleStops.filter((stop) => stop.id !== next.candidate.id);
      currentDeparture = next.simulation.departureCandidate;
      current = next.candidate;
    }

    const fixedArrival = currentDeparture + travelMinutes(current, fixed, options);
    const fixedTarget = fixedTargetMinutes(fixed, options);
    if (fixedArrival > fixedTarget) {
      impossibleFixedStopIds.push(fixed.id);
      warnings.push({
        code: "fixed-impossible",
        stopId: fixed.id,
        message: `${fixed.name} 无法在 ${formatClock(fixedTarget)} 前到达。`
      });
    }

    order.push(fixed);
    currentDeparture = departureAfterVisit(fixed, fixedArrival, options);
    current = fixed;
  }

  if (fixedStops.length > 0) {
    movedAfterFixedStopIds.push(...flexibleStops.map((stop) => stop.id));
  }

  while (flexibleStops.length > 0) {
    const next = nearestNext(current, flexibleStops, options)!;
    order.push(next);
    flexibleStops = flexibleStops.filter((stop) => stop.id !== next.id);
    currentDeparture = departureAfterVisit(next, currentDeparture + travelMinutes(current, next, options), options);
    current = next;
  }

  if (end) {
    order.push(end);
  } else if (!stops.some(isEndStop)) {
    warnings.push({
      code: "missing-end",
      message: "没有设置终点，将以最后一个可访问地点结束当天行程。"
    });
  }

  const schedule = buildSchedule(order, options);
  return {
    orderedStops: order,
    schedule,
    movedAfterFixedStopIds,
    impossibleFixedStopIds,
    warnings
  };
}

export function buildSchedule(orderedStops: Stop[], options: PlannerOptions, routeLegs: RouteLeg[] = []) {
  const schedule: ScheduleItem[] = [];
  if (!orderedStops.length) return schedule;

  let arrival = startVisitStartMinutes(orderedStops[0], options);

  for (let index = 0; index < orderedStops.length; index += 1) {
    const stop = orderedStops[index];
    const target = isFixedStop(stop) ? fixedTargetMinutes(stop, options) : undefined;
    const visitStart = target === undefined ? arrival : Math.max(arrival, target);
    const waitMinutes = Math.max(0, visitStart - arrival);
    const departure = visitStart + stopVisitMinutes(stop);
    const leg = routeLegs[index];
    const travelToNextMinutes =
      index < orderedStops.length - 1
        ? leg?.durationSeconds
          ? Math.max(0, Math.round(leg.durationSeconds / 60))
          : travelMinutes(stop, orderedStops[index + 1], options)
        : 0;
    const lateByMinutes = target === undefined ? 0 : Math.max(0, arrival - target);

    schedule.push({
      stop,
      index,
      arrivalMinutes: arrival,
      visitStartMinutes: visitStart,
      departureMinutes: departure,
      waitMinutes,
      isLate: lateByMinutes > 0,
      lateByMinutes,
      travelToNextMinutes,
      leg
    });

    arrival = departure + travelToNextMinutes;
  }

  return schedule;
}

export function firstLateFixedItem(schedule: ScheduleItem[]) {
  return schedule.find((item) => isFixedStop(item.stop) && item.isLate);
}

export function repairOrderWithActualLegs(order: Stop[], routeLegs: RouteLeg[], options: PlannerOptions) {
  const schedule = buildSchedule(order, options, routeLegs);
  const lateFixed = firstLateFixedItem(schedule);
  if (!lateFixed) {
    return {
      order,
      movedStopId: null as string | null,
      impossibleFixedStopIds: [] as string[]
    };
  }

  const fixedIndex = lateFixed.index;
  let movableIndex = -1;
  for (let index = fixedIndex - 1; index >= 1; index -= 1) {
    if (isFlexibleStop(order[index])) {
      movableIndex = index;
      break;
    }
  }

  if (movableIndex < 0) {
    return {
      order,
      movedStopId: null,
      impossibleFixedStopIds: [lateFixed.stop.id]
    };
  }

  const nextOrder = [...order];
  const [moved] = nextOrder.splice(movableIndex, 1);
  const nextFixedIndex = nextOrder.findIndex((stop) => stop.id === lateFixed.stop.id);
  nextOrder.splice(nextFixedIndex + 1, 0, moved);

  return {
    order: nextOrder,
    movedStopId: moved.id,
    impossibleFixedStopIds: [] as string[]
  };
}

export function buildAutoRouteRequest(orderedStops: Stop[], options: PlannerOptions): AutoRouteRequest {
  const schedule = buildSchedule(orderedStops, options);
  const firstDeparture = schedule[0]?.departureMinutes ?? parseClock(options.startTime);
  return {
    stops: orderedStops,
    transitLocalDateTime: localDateTimeString(options.tripDate, firstDeparture),
    transitTimePreference: "departure",
    expectedLegs: Math.max(0, orderedStops.length - 1)
  };
}

export function normalizeRoutePlan(route: Partial<RoutePlan> | null | undefined, orderedStops: Stop[]): RoutePlan {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const fallbackCoordinates = orderedStops.map((stop) => [stop.location.lat, stop.location.lng] as [number, number]);
  const legCoordinates = coordinatesFromLegs(legs);
  const routeCoordinates = Array.isArray(route?.coordinates) && route.coordinates.length > 0
    ? route.coordinates
    : legCoordinates.length > 0
      ? legCoordinates
      : fallbackCoordinates;
  const distanceMeters = Number(route?.distanceMeters) || legs.reduce((sum, leg) => sum + (Number(leg.distanceMeters) || 0), 0);
  const durationSeconds = Number(route?.durationSeconds) || legs.reduce((sum, leg) => sum + (Number(leg.durationSeconds) || 0), 0);

  return {
    distanceMeters,
    durationSeconds,
    coordinates: routeCoordinates,
    legs,
    provider: route?.provider || "estimated",
    routeStopIds: orderedStops.map((stop) => stop.id),
    strategy: route?.strategy,
    warnings: route?.warnings
  };
}

function coordinatesFromLegs(legs: RouteLeg[]) {
  const coordinates: Array<[number, number]> = [];
  for (const leg of legs) {
    if (!Array.isArray(leg.coordinates) || leg.coordinates.length === 0) continue;
    const last = coordinates[coordinates.length - 1];
    const first = leg.coordinates[0];
    if (last && first && Math.abs(last[0] - first[0]) < 0.000001 && Math.abs(last[1] - first[1]) < 0.000001) {
      coordinates.push(...leg.coordinates.slice(1));
    } else {
      coordinates.push(...leg.coordinates);
    }
  }
  return coordinates;
}

export function rebuildRoutePlanFromLegs(routePlan: RoutePlan, orderedStops: Stop[]): RoutePlan {
  const legs = routePlan.legs || [];
  return {
    ...routePlan,
    distanceMeters: legs.reduce((sum, leg) => sum + (Number(leg.distanceMeters) || 0), 0),
    durationSeconds: legs.reduce((sum, leg) => sum + (Number(leg.durationSeconds) || 0), 0),
    coordinates: coordinatesFromLegs(legs),
    routeStopIds: orderedStops.map((stop) => stop.id)
  };
}

export function routeAlternativeOptions(leg: RouteLeg) {
  return Array.isArray(leg.alternatives) && leg.alternatives.length > 1 ? leg.alternatives : [];
}

export function activeRouteAlternativeIndex(leg: RouteLeg, alternatives = routeAlternativeOptions(leg)) {
  if (!alternatives.length) return -1;
  if (Number.isInteger(leg.selectedAlternativeIndex)) {
    return Math.max(0, Math.min(alternatives.length - 1, Number(leg.selectedAlternativeIndex)));
  }
  const index = alternatives.findIndex(
    (option) =>
      option.summary === leg.summary &&
      option.durationSeconds === leg.durationSeconds &&
      option.startTime === leg.startTime &&
      option.endTime === leg.endTime
  );
  return index >= 0 ? index : 0;
}

export function selectRouteAlternative(
  routePlan: RoutePlan,
  orderedStops: Stop[],
  legIndex: number,
  alternativeIndex: number
) {
  const currentLeg = routePlan.legs[legIndex];
  if (!currentLeg) return routePlan;
  const alternatives = routeAlternativeOptions(currentLeg);
  const selected = alternatives[alternativeIndex];
  if (!selected) return routePlan;

  const nextLeg: RouteLeg = {
    ...selected,
    alternatives,
    selectedAlternativeIndex: alternativeIndex,
    preferredMode: currentLeg.preferredMode,
    directDistanceMeters: currentLeg.directDistanceMeters
  };
  const nextLegs = [...routePlan.legs];
  nextLegs[legIndex] = nextLeg;
  return rebuildRoutePlanFromLegs(
    {
      ...routePlan,
      legs: nextLegs
    },
    orderedStops
  );
}

export function scheduleWarnings(schedule: ScheduleItem[]) {
  return schedule
    .filter((item) => item.isLate)
    .map((item) => `${stopKindLabel(item.stop)}「${item.stop.name}」预计迟到 ${item.lateByMinutes} 分钟`);
}
