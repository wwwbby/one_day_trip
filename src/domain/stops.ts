import { addClockMinutes, isDateInputValue, normalizeClockValue, normalizeStayMinutes, todayInputValue } from "./time";
import type { AnitabiSearchResult, DayPlan, LatLng, RoutePlan, Stop, StopRole } from "./types";

export const pilgrimageStayMinutes = 5;

export function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isStartStop(stop: Stop) {
  return Boolean(stop.isStart);
}

export function isEndStop(stop: Stop) {
  return Boolean(stop.isEnd || stop.role === "end");
}

export function isFixedStop(stop: Stop) {
  return stop.role === "fixed";
}

export function isPilgrimageStop(stop: Stop) {
  return stop.role === "pilgrimage" || isAnitabiStopLike(stop);
}

export function isFlexibleStop(stop: Stop) {
  return !isStartStop(stop) && !isEndStop(stop) && !isFixedStop(stop);
}

export function stopVisitMinutes(stop: Stop) {
  return normalizeStayMinutes(stop.stayMinutes, isEndStop(stop) ? 0 : pilgrimageStayMinutes);
}

export function stopKind(stop: Stop): "start" | "end" | StopRole {
  if (isStartStop(stop)) return "start";
  if (isEndStop(stop)) return "end";
  if (isFixedStop(stop)) return "fixed";
  if (isPilgrimageStop(stop)) return "pilgrimage";
  return "normal";
}

export function stopKindLabel(stop: Stop) {
  const kind = stopKind(stop);
  const labels = {
    start: "起点",
    normal: "普通点",
    pilgrimage: "巡礼点",
    fixed: "定点",
    end: "终点"
  };
  return labels[kind];
}

export function isAnitabiStopLike(value: Partial<Stop> | null | undefined) {
  return Boolean(
    value?.anitabiPointId ||
      value?.workTitle ||
      (typeof value?.source === "string" && value.source.toLowerCase().includes("anitabi"))
  );
}

export function createStop(input: Partial<Stop> & { name: string; location: LatLng }): Stop {
  const role = normalizeStopRole(input.role, isAnitabiStopLike(input));
  return normalizeStop({
    id: input.id || makeId(),
    name: input.name,
    location: input.location,
    address: input.address,
    placeId: input.placeId,
    stayMinutes: input.stayMinutes ?? (role === "end" ? 0 : pilgrimageStayMinutes),
    role,
    isStart: input.isStart,
    isEnd: input.isEnd || role === "end",
    windowStart: input.windowStart,
    note: input.note,
    source: input.source || "manual",
    imageUrl: input.imageUrl,
    thumbnailUrl: input.thumbnailUrl,
    episode: input.episode,
    sceneTimeSeconds: input.sceneTimeSeconds,
    origin: input.origin,
    originUrl: input.originUrl,
    anitabiPointId: input.anitabiPointId,
    workTitle: input.workTitle
  })!;
}

export function normalizeStopRole(rawRole: unknown, anitabiLike = false): StopRole {
  if (rawRole === "fixed" || rawRole === "end" || rawRole === "pilgrimage" || rawRole === "normal") {
    return rawRole;
  }
  if (rawRole === "special" || anitabiLike) return "pilgrimage";
  return "normal";
}

export function normalizeStop(value: any): Stop | null {
  const lat = Number(value?.location?.lat ?? value?.lat);
  const lng = Number(value?.location?.lng ?? value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const anitabiLike = isAnitabiStopLike(value);
  const role = normalizeStopRole(value?.role, anitabiLike);
  const isStart = Boolean(value?.isStart);
  const isEnd = Boolean(value?.isEnd || role === "end") && !isStart;
  const stayMinutes = normalizeStayMinutes(value?.stayMinutes, isEnd ? 0 : pilgrimageStayMinutes);
  const windowStart =
    role === "fixed"
      ? normalizeClockValue(value?.windowStart) || "12:00"
      : isStart
        ? normalizeClockValue(value?.windowStart) || normalizeClockValue(value?.startTime)
        : undefined;

  return {
    ...value,
    id: String(value?.id || makeId()),
    name: String(value?.name || "未命名地点").slice(0, 180),
    address: typeof value?.address === "string" ? value.address : undefined,
    location: { lat, lng },
    role: isEnd ? "end" : role,
    isStart,
    isEnd,
    windowStart,
    stayMinutes,
    note: typeof value?.note === "string" ? value.note : anitabiLike ? "巡礼" : ""
  };
}

export function formatPlanDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

export function defaultPlanName(tripDate: string) {
  return `${formatPlanDate(tripDate)} 一日规划`;
}

export function createDayPlan(input: Partial<DayPlan> = {}): DayPlan {
  const now = new Date().toISOString();
  const tripDate = isDateInputValue(input.tripDate) ? input.tripDate! : todayInputValue();
  return {
    id: input.id || makeId(),
    name: input.name?.trim() || defaultPlanName(tripDate),
    tripDate,
    startTime: normalizeClockValue(input.startTime) || "09:00",
    transitTimePreference: input.transitTimePreference || "departure",
    stops: clonePlain(input.stops || []),
    routePlan: clonePlain(input.routePlan || null),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  };
}

export function normalizeDayPlan(value: any): DayPlan | null {
  if (!value || typeof value !== "object") return null;
  const tripDate = isDateInputValue(value.tripDate) ? value.tripDate : todayInputValue();
  const stops = Array.isArray(value.stops)
    ? (value.stops.map(normalizeStop).filter(Boolean) as Stop[])
    : [];
  const routePlan =
    value.routePlan && typeof value.routePlan === "object" && Array.isArray(value.routePlan.legs)
      ? (value.routePlan as RoutePlan)
      : null;

  return createDayPlan({
    id: String(value.id || makeId()),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : defaultPlanName(tripDate),
    tripDate,
    startTime: normalizeClockValue(value.startTime) || "09:00",
    transitTimePreference: value.transitTimePreference === "arrival" ? "arrival" : "departure",
    stops,
    routePlan,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined
  });
}

export function defaultDayPlans() {
  const today = todayInputValue();
  const sampleDate = today.replace(/-\d{2}$/, "-19");
  const kyotoStation = createStop({
    name: "京都站",
    address: "京都府京都市下京区",
    location: { lat: 34.985849, lng: 135.758766 },
    isStart: true,
    windowStart: "09:00",
    stayMinutes: 0,
    source: "sample"
  });
  const fushimi = createStop({
    name: "伏见稻荷大社",
    address: "京都府京都市伏见区深草薮之内町68",
    location: { lat: 34.96714, lng: 135.772672 },
    role: "pilgrimage",
    note: "巡礼",
    source: "sample"
  });
  const uji = createStop({
    name: "宇治桥",
    address: "京都府宇治市宇治",
    location: { lat: 34.89289, lng: 135.80754 },
    role: "pilgrimage",
    note: "巡礼",
    source: "sample"
  });

  return [
    createDayPlan({
      name: `${formatPlanDate(sampleDate)} 京都巡礼`,
      tripDate: sampleDate,
      stops: [kyotoStation, fushimi, uji]
    }),
    createDayPlan({
      name: `${formatPlanDate(today)} 一日规划`,
      tripDate: today,
      stops: []
    })
  ];
}

export function patchStopKind(stop: Stop, kind: "start" | "normal" | "pilgrimage" | "fixed" | "end"): Stop {
  const base: Stop = {
    ...stop,
    isStart: false,
    isEnd: false,
    role: kind === "start" ? "normal" : kind
  };

  if (kind === "start") {
    return {
      ...base,
      isStart: true,
      role: "normal",
      windowStart: normalizeClockValue(stop.windowStart) || "09:00"
    };
  }

  if (kind === "fixed") {
    return {
      ...base,
      role: "fixed",
      windowStart: normalizeClockValue(stop.windowStart) || "12:00"
    };
  }

  if (kind === "end") {
    return {
      ...base,
      role: "end",
      isEnd: true,
      windowStart: undefined,
      stayMinutes: normalizeStayMinutes(stop.stayMinutes, 0)
    };
  }

  return {
    ...base,
    role: kind,
    windowStart: undefined,
    stayMinutes: normalizeStayMinutes(stop.stayMinutes, pilgrimageStayMinutes)
  };
}

function imageFromAnitabiPoint(point: any) {
  const direct =
    point?.image ||
    point?.imageUrl ||
    point?.image_url ||
    point?.url ||
    point?.thumbnail ||
    point?.thumbnailUrl ||
    point?.thumbnail_url;
  if (typeof direct === "string") return direct;
  const image = Array.isArray(point?.images) ? point.images[0] : undefined;
  return image?.url || image?.image || image?.thumbnail || image?.thumbnailUrl || undefined;
}

function pointCoordinate(point: any) {
  const lat = Number(point?.lat ?? point?.latitude ?? point?.geo?.lat ?? point?.coordinate?.lat);
  const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.geo?.lng ?? point?.coordinate?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function anitabiPointToStop(point: any, subject?: AnitabiSearchResult | Record<string, any>): Stop | null {
  const location = pointCoordinate(point);
  if (!location) return null;
  const subjectValue = (subject || {}) as Record<string, any>;
  const workTitle =
    String(subjectValue.cn || subjectValue.title || subjectValue.name_cn || subjectValue.name || point?.workTitle || "").trim() ||
    undefined;
  const title = String(point?.name || point?.title || point?.cn || point?.address || "巡礼点").trim();
  const episode = Number(point?.ep || point?.episode);
  const sceneTimeSeconds = Number(point?.s || point?.sceneTimeSeconds || point?.time);
  const imageUrl = imageFromAnitabiPoint(point);
  const addressBits = [
    workTitle,
    Number.isFinite(episode) ? `第 ${episode} 话` : "",
    Number.isFinite(sceneTimeSeconds) ? addClockMinutes("00:00", Math.floor(sceneTimeSeconds / 60)) : "",
    point?.address || point?.description || point?.subtitle
  ].filter(Boolean);

  return createStop({
    id: `anitabi-${point?.id || makeId()}`,
    name: title,
    address: addressBits.join(" / "),
    location,
    stayMinutes: pilgrimageStayMinutes,
    role: "pilgrimage",
    note: "巡礼",
    source: "Anitabi",
    imageUrl,
    thumbnailUrl: imageUrl,
    episode: Number.isFinite(episode) ? episode : undefined,
    sceneTimeSeconds: Number.isFinite(sceneTimeSeconds) ? sceneTimeSeconds : undefined,
    origin: point?.origin || point?.user || point?.author,
    originUrl: point?.originUrl || point?.url,
    anitabiPointId: String(point?.id || ""),
    workTitle
  });
}
