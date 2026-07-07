import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  Copy,
  Download,
  Footprints,
  GripVertical,
  Image as ImageIcon,
  LocateFixed,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Route,
  Save,
  Trash2,
  TrainFront,
  Upload,
  X
} from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ChangeEvent, DragEvent, Fragment, KeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type MapProvider = "google" | "osm";
type TransitTimePreference = "departure" | "arrival";
type StopRole = "normal" | "pilgrimage" | "fixed" | "end";

declare global {
  interface Window {
    __daytripGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

type Stop = {
  id: string;
  name: string;
  address?: string;
  placeId?: string;
  location: {
    lat: number;
    lng: number;
  };
  stayMinutes: number;
  role?: StopRole;
  isStart?: boolean;
  isEnd?: boolean;
  windowStart?: string;
  windowEnd?: string;
  note?: string;
  source?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  episode?: number;
  sceneTimeSeconds?: number;
  origin?: string;
  originUrl?: string;
  anitabiPointId?: string;
  workTitle?: string;
};

type RouteStep = {
  mode?: string;
  line?: string;
  headsign?: string;
  from?: string;
  to?: string;
  startTime?: string;
  endTime?: string;
  durationSeconds?: number;
  distanceMeters?: number;
  instructions?: string;
};

type RouteLeg = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline?: string;
  summary?: string;
  steps?: RouteStep[];
  mode?: "WALK" | "TRANSIT";
  preferredMode?: "WALK" | "TRANSIT";
  fallbackReason?: string;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  fare?: number | string;
};

type RoutePlan = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline?: string;
  coordinates?: Array<[number, number]>;
  legs: RouteLeg[];
  routeStopIds?: string[];
  optimizedIntermediateWaypointIndex?: number[];
  provider?: string;
};

type DayPlan = {
  id: string;
  name: string;
  tripDate: string;
  startTime: string;
  departureEndTime?: string;
  departureStop?: Stop | null;
  transitTimePreference: TransitTimePreference;
  stops: Stop[];
  routePlan: RoutePlan | null;
  createdAt: string;
  updatedAt: string;
};

type SearchResult = {
  id: number | string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  source: string;
};

type AnitabiSearchResult = {
  id: number;
  cn?: string;
  title?: string;
  date?: string;
  city?: string;
  cover?: string;
  pointsLength?: number;
  imagesLength?: number;
  samplePoints?: string[];
};

type ScheduleItem = {
  stop: Stop;
  arrival: number;
  visitStart: number;
  departure: number;
  waitMinutes: number;
  isLate: boolean;
  travelToNextMinutes: number;
};

type RouteOrderSimulation = {
  score: number;
  endMinutes: number;
  totalTravelMinutes: number;
  totalWaitMinutes: number;
  totalLatenessMinutes: number;
  bufferShortfallMinutes: number;
  missedFixedCount: number;
  distanceMeters: number;
};

type MapPoint = {
  x: number;
  y: number;
};

type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const browserApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const googleMapId = (import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined) || "DEMO_MAP_ID";
const defaultCenter = { lat: 34.985849, lng: 135.758766 };
const pilgrimageStayMinutes = 5;
const autoTransitThresholdMeters = 1000;
const routeRequestQuotaPerMinute = 50;
const fixedArrivalBufferMinutes = 8;
const maxInsertionCandidatesPerRound = 32;
const maxRelocationOptimizationStops = 72;
const planCacheStorageKey = "daytrip-planner.plans.v1";
const planServerMigrationKey = "daytrip-planner.server-migrated.v1";
const newPlanDraftStorageKey = "daytrip-planner.new-plan-draft.v1";
const activePlanStorageKey = "daytrip-planner.active-plan-id.v1";

const initialStops = (): Stop[] => [
  {
    id: makeId(),
    name: "京都站",
    address: "京都府京都市下京区",
    location: defaultCenter,
    stayMinutes: 0,
    note: "出发点",
    source: "sample"
  },
  {
    id: makeId(),
    name: "伏见稻荷大社",
    address: "京都府京都市伏见区深草薮之内町68",
    location: { lat: 34.96714, lng: 135.772672 },
    stayMinutes: pilgrimageStayMinutes,
    source: "sample"
  },
  {
    id: makeId(),
    name: "宇治桥",
    address: "京都府宇治市宇治",
    location: { lat: 34.89289, lng: 135.80754 },
    stayMinutes: pilgrimageStayMinutes,
    source: "sample"
  },
  {
    id: makeId(),
    name: "平等院",
    address: "京都府宇治市宇治莲华116",
    location: { lat: 34.889304, lng: 135.807681 },
    stayMinutes: pilgrimageStayMinutes,
    source: "sample"
  }
];

function makeId() {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayInputValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDateInputValue(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeClockValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return undefined;
  return value;
}

function loadNewPlanDraft() {
  const fallback = { date: todayInputValue(), name: "" };
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(newPlanDraftStorageKey);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored);
    return {
      date: isDateInputValue(parsed?.date) ? parsed.date : fallback.date,
      name: typeof parsed?.name === "string" ? parsed.name.slice(0, 180) : ""
    };
  } catch {
    return fallback;
  }
}

function clonePlain<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatPlanDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

function formatSavedAt(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function defaultPlanName(tripDate: string) {
  return `${formatPlanDate(tripDate)} 一日规划`;
}

function sampleDateForDay(day: number) {
  const [year, month] = todayInputValue().split("-");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

function createDayPlan(input: Partial<DayPlan> = {}): DayPlan {
  const now = new Date().toISOString();
  const tripDate = input.tripDate || todayInputValue();
  return {
    id: input.id || makeId(),
    name: input.name?.trim() || defaultPlanName(tripDate),
    tripDate,
    startTime: input.startTime || "09:00",
    departureEndTime: input.departureEndTime || input.startTime || "09:00",
    departureStop: input.departureStop ? clonePlain(input.departureStop) : null,
    transitTimePreference: input.transitTimePreference || "departure",
    stops: clonePlain(input.stops || []),
    routePlan: clonePlain(input.routePlan || null),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  };
}

function defaultDayPlans() {
  const firstDate = sampleDateForDay(18);
  const secondDate = sampleDateForDay(19);
  const sampleStops = initialStops();
  return [
    createDayPlan({
      name: `${formatPlanDate(firstDate)} 京都巡礼`,
      tripDate: firstDate,
      stops: [{ ...sampleStops[0], isStart: true }, ...sampleStops.slice(1)]
    }),
    createDayPlan({
      name: `${formatPlanDate(secondDate)} 一日规划`,
      tripDate: secondDate,
      stops: []
    })
  ];
}

function isAnitabiStopLike(value: any) {
  return Boolean(
    value?.anitabiPointId ||
    value?.workTitle ||
    (typeof value?.source === "string" && value.source.startsWith("Anitabi"))
  );
}

function normalizeStop(value: any): Stop | null {
  const lat = Number(value?.location?.lat);
  const lng = Number(value?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const legacyEnd = value?.role === "end";
  const isStart = Boolean(value?.isStart);
  const rawRole = value?.role;
  const role: StopRole =
    rawRole === "fixed" || rawRole === "pilgrimage"
      ? rawRole
      : rawRole === "special"
        ? "pilgrimage"
        : isAnitabiStopLike(value)
          ? "pilgrimage"
          : "normal";
  const isEnd = (Boolean(value?.isEnd) || legacyEnd) && !isStart;
  const windowStart = role === "fixed"
    ? normalizeClockValue(value?.windowStart) || "12:00"
    : isStart
      ? normalizeClockValue(value?.windowStart)
      : undefined;
  const stayMinutes = normalizeStayMinutes(value?.stayMinutes, isEnd ? 0 : pilgrimageStayMinutes);
  const windowEnd = role === "fixed" ? derivedFixedWindowEndClock(windowStart, stayMinutes) : undefined;
  return {
    ...value,
    id: String(value?.id || makeId()),
    name: String(value?.name || "未命名地点"),
    location: { lat, lng },
    role,
    isStart,
    isEnd,
    windowStart,
    windowEnd,
    stayMinutes
  };
}

function normalizeDayPlan(value: any): DayPlan | null {
  if (!value || typeof value !== "object") return null;
  const tripDate = typeof value.tripDate === "string" && value.tripDate ? value.tripDate : todayInputValue();
  const stops = Array.isArray(value.stops)
    ? (value.stops.map(normalizeStop).filter(Boolean) as Stop[])
    : [];
  const legacyDepartureStop = normalizeStop(value.departureStop);
  const legacyStartTime = normalizeClockValue(value.startTime) || "09:00";
  const legacyDepartureEndTime = normalizeClockValue(value.departureEndTime) || legacyStartTime;
  const legacyDepartureStay = clockDiffMinutes(legacyStartTime, legacyDepartureEndTime);
  const mergedStops = legacyDepartureStop
    ? [
        {
          ...legacyDepartureStop,
          isStart: true,
          role: (legacyDepartureStop.role === "fixed" ? "fixed" : "normal") as StopRole,
          windowStart: legacyDepartureStop.windowStart || legacyStartTime,
          windowEnd: undefined,
          stayMinutes: legacyDepartureStay ?? stopVisitMinutes(legacyDepartureStop)
        },
        ...stops.filter((stop) => stop.id !== legacyDepartureStop.id)
      ]
    : stops;
  const routePlan =
    value.routePlan && typeof value.routePlan === "object" && Array.isArray(value.routePlan.legs)
      ? (value.routePlan as RoutePlan)
      : null;

  return createDayPlan({
    id: String(value.id || makeId()),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : defaultPlanName(tripDate),
    tripDate,
    startTime: typeof value.startTime === "string" && value.startTime ? value.startTime : "09:00",
    departureEndTime: normalizeClockValue(value.departureEndTime) || normalizeClockValue(value.startTime) || "09:00",
    departureStop: null,
    transitTimePreference: value.transitTimePreference === "arrival" ? "arrival" : "departure",
    stops: mergedStops,
    routePlan,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined
  });
}

function loadLocalCachedPlans() {
  if (typeof window === "undefined") return defaultDayPlans();
  const stored = window.localStorage.getItem(planCacheStorageKey);
  if (!stored) return defaultDayPlans();

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return defaultDayPlans();
    return parsed.map(normalizeDayPlan).filter(Boolean) as DayPlan[];
  } catch (error) {
    console.error("Failed to load cached plans", error);
    return defaultDayPlans();
  }
}

function readStoredActivePlanId() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(activePlanStorageKey);
  } catch (error) {
    console.error("Failed to read active plan id", error);
    return null;
  }
}

function storeActivePlanId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) {
      window.sessionStorage.setItem(activePlanStorageKey, id);
    } else {
      window.sessionStorage.removeItem(activePlanStorageKey);
    }
  } catch (error) {
    console.error("Failed to persist active plan id", error);
  }
}

async function readPlansFromServer() {
  const response = await fetch("/api/plans");
  const data = await readApiJson(response, "服务端规划读取失败。");
  return Array.isArray(data?.plans)
    ? (data.plans.map(normalizeDayPlan).filter(Boolean) as DayPlan[])
    : [];
}

async function readApiJson(response: Response, fallback: string) {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const text = await response.text();
  let data: any = {};

  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(excerpt ? `${fallback}（${status}：返回内容不是 JSON：${excerpt}）` : `${fallback}（${status}：返回内容不是 JSON）`);
    }
  }

  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : "";
    throw new Error(message ? `${fallback}（${status}：${message}）` : `${fallback}（${status}）`);
  }

  return data;
}

async function writePlanToServer(plan: DayPlan) {
  const response = await fetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan })
  });
  const data = await readApiJson(response, "规划保存到服务端失败。");
  return normalizeDayPlan(data?.plan) || plan;
}

async function createPlanOnServer(plan: DayPlan) {
  const response = await fetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan })
  });
  const data = await readApiJson(response, "规划创建到服务端失败。");
  return normalizeDayPlan(data?.plan) || plan;
}

async function deletePlanFromServer(id: string) {
  const response = await fetch(`/api/plans?id=${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  await readApiJson(response, "服务端规划删除失败。");
}

function buildLocalDateTimeIso(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function parseDurationSeconds(value?: string) {
  if (!value) return 0;
  return Math.round(Number(value.replace("s", "")) || 0);
}

function formatDistance(meters?: number) {
  if (!meters) return "0 km";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatFare(value?: number | string) {
  if (value === undefined || value === null || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

function formatDuration(seconds?: number) {
  if (!seconds) return "0 分钟";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  if (!rest) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function formatRouteClock(value?: string) {
  if (!value) return "";
  const directMatch = value.match(/T(\d{2}):(\d{2})/);
  if (directMatch) return `${directMatch[1]}:${directMatch[2]}`;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function cleanInstruction(value?: string) {
  if (!value) return "";
  const normalized = value
    .replace(/<wbr\s*\/?>/gi, "")
    .replace(/<div[^>]*>/gi, " ")
    .replace(/<\/div>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (typeof document === "undefined") return normalized;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = normalized;
  return textarea.value;
}

function isWalkingStep(step: RouteStep) {
  const mode = String(step.mode || "").toUpperCase();
  return mode.includes("WALK") || step.line === "徒歩";
}

function routeStepTitle(step: RouteStep) {
  if (isWalkingStep(step)) {
    return `步行 ${formatDuration(step.durationSeconds)}`;
  }

  const line = step.line || "公共交通";
  return step.headsign ? `乘坐 ${line}，往 ${step.headsign}` : `乘坐 ${line}`;
}

function routeStepMeta(step: RouteStep) {
  const timeRange = [formatRouteClock(step.startTime), formatRouteClock(step.endTime)]
    .filter(Boolean)
    .join(" - ");
  const distance = step.distanceMeters ? formatDistance(step.distanceMeters) : "";
  return [timeRange, distance].filter(Boolean).join(" · ");
}

function routeStepStations(step: RouteStep) {
  if (step.from && step.to) return `${step.from} → ${step.to}`;
  return step.from || step.to || "";
}

function parseClock(value: string | undefined) {
  const [hour = "9", minute = "0"] = (normalizeClockValue(value) || "09:00").split(":");
  return Number(hour) * 60 + Number(minute);
}

function formatClock(totalMinutes: number) {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockDiffMinutes(start?: string, end?: string) {
  const startValue = normalizeClockValue(start);
  const endValue = normalizeClockValue(end);
  if (!startValue || !endValue) return null;
  const diff = parseClock(endValue) - parseClock(startValue);
  return diff >= 0 ? diff : null;
}

function normalizeStayMinutes(value: unknown, fallback = pilgrimageStayMinutes) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return fallback;
  return Math.max(0, Math.min(720, minutes));
}

function derivedFixedWindowEndClock(windowStart: string | undefined, stayMinutes: number) {
  const start = normalizeClockValue(windowStart);
  return start ? formatClock(parseClock(start) + stayMinutes) : undefined;
}

function getStopRole(stop: Stop): StopRole {
  if (stop.role === "fixed" || stop.role === "pilgrimage") return stop.role;
  if (isAnitabiStopLike(stop)) return "pilgrimage";
  return "normal";
}

function isStartStop(stop: Stop) {
  return Boolean(stop.isStart);
}

function isFixedStop(stop: Stop) {
  return getStopRole(stop) === "fixed";
}

function isPilgrimageStop(stop: Stop) {
  return getStopRole(stop) === "pilgrimage";
}

function isEndpointStop(stop: Stop) {
  return Boolean(stop.isEnd) || stop.role === "end";
}

function fixedWindowStartMinutes(stop: Stop) {
  return isFixedStop(stop) && normalizeClockValue(stop.windowStart) ? parseClock(stop.windowStart) : null;
}

function fixedWindowEndMinutes(stop: Stop) {
  const start = fixedWindowStartMinutes(stop);
  return start === null ? null : start + stopVisitMinutes(stop);
}

function fixedArrivalDeadlineMinutes(stop: Stop) {
  return fixedWindowStartMinutes(stop) ?? fixedWindowEndMinutes(stop);
}

function stopVisitMinutes(stop: Stop) {
  return normalizeStayMinutes(stop.stayMinutes, isEndpointStop(stop) ? 0 : pilgrimageStayMinutes);
}

function normalizeStopRolePatch(stop: Stop, role: StopRole): Stop {
  if (role === "end") {
    return {
      ...stop,
      role: "normal",
      isStart: false,
      isEnd: true,
      windowStart: undefined,
      windowEnd: undefined,
      stayMinutes: normalizeStayMinutes(stop.stayMinutes, 0)
    };
  }

  if (role === "fixed") {
    const start = normalizeClockValue(stop.windowStart) || "12:00";
    const stayMinutes = normalizeStayMinutes(stop.stayMinutes);
    return {
      ...stop,
      role,
      windowStart: start,
      windowEnd: derivedFixedWindowEndClock(start, stayMinutes),
      stayMinutes
    };
  }

  if (role === "pilgrimage") {
    return {
      ...stop,
      role,
      windowStart: undefined,
      windowEnd: undefined,
      stayMinutes: normalizeStayMinutes(stop.stayMinutes)
    };
  }

  return {
    ...stop,
    role: "normal",
    windowStart: undefined,
    windowEnd: undefined,
    stayMinutes: normalizeStayMinutes(stop.stayMinutes)
  };
}

type StopKindSelection = "normal" | "pilgrimage" | "departure" | "fixed" | "end";

function stopKindSelection(stop: Stop): StopKindSelection {
  if (isStartStop(stop)) return "departure";
  if (isEndpointStop(stop)) return "end";
  if (isFixedStop(stop)) return "fixed";
  if (isPilgrimageStop(stop)) return "pilgrimage";
  return "normal";
}

function stopKindClass(stop: Stop) {
  return stopKindSelection(stop);
}

function applyStopKindSelection(stop: Stop, selection: StopKindSelection): Stop {
  if (selection === "fixed") {
    const fixedStop = normalizeStopRolePatch(stop, "fixed");
    return { ...fixedStop, isStart: false, isEnd: false };
  }

  if (selection === "pilgrimage") {
    const pilgrimageStop = normalizeStopRolePatch(stop, "pilgrimage");
    return { ...pilgrimageStop, isStart: false, isEnd: false };
  }

  const baseStop = normalizeStopRolePatch(stop, "normal");
  const startWindowStart = normalizeClockValue(stop.windowStart) || "09:00";
  if (selection === "departure") {
    return { ...baseStop, isStart: true, isEnd: false, windowStart: startWindowStart, windowEnd: undefined };
  }
  if (selection === "end") return { ...baseStop, isStart: false, isEnd: true, stayMinutes: normalizeStayMinutes(stop.stayMinutes, 0) };
  return { ...baseStop, isStart: false, isEnd: false };
}

function stopRoleLabel(stop: Stop) {
  const role = getStopRole(stop);
  if (role === "fixed") return "定点";
  if (role === "end") return "终点";
  return "普通点";
}

function stopSequenceLabel(stop: Stop, index: number) {
  if (isEndpointStop(stop)) return "终";
  if (isFixedStop(stop)) return "定";
  return String(index + 1);
}

function stopDisplayRoleLabel(stop: Stop) {
  const labels: string[] = [];
  if (isStartStop(stop)) labels.push("起点");
  if (isFixedStop(stop)) labels.push("定点");
  if (isEndpointStop(stop)) labels.push("终点");
  return labels.length ? labels.join("+") : "普通点";
}

function stopKindLabel(stop: Stop) {
  const labels: string[] = [];
  if (isStartStop(stop)) labels.push("起点");
  if (isFixedStop(stop)) labels.push("定点");
  if (isPilgrimageStop(stop)) labels.push("巡礼点");
  if (isEndpointStop(stop)) labels.push("终点");
  return labels.length ? labels.join("+") : "普通点";
}

function routeStopSequenceLabel(stop: Stop, index: number) {
  if (isStartStop(stop)) return "起";
  if (isEndpointStop(stop)) return "终";
  if (isFixedStop(stop)) return "定";
  return String(index + 1);
}

function estimateTravelMinutes(a: Stop, b: Stop) {
  const distance = haversineMeters(a, b);
  if (distance <= autoTransitThresholdMeters) {
    return Math.max(3, Math.ceil(distance / 75));
  }
  return Math.max(12, Math.ceil(distance / 360) + 8);
}

function appendBeforeEndpoint(current: Stop[], additions: Stop[]) {
  const endpoint = current.find(isEndpointStop);
  if (endpoint && isStartStop(endpoint)) {
    return [
      endpoint,
      ...additions,
      ...current.filter((stop) => stop.id !== endpoint.id)
    ];
  }
  if (!endpoint) return [...current, ...additions];
  return [
    ...current.filter((stop) => !isEndpointStop(stop)),
    ...additions,
    endpoint
  ];
}

function buildScheduleItems(stops: Stop[], legs: RouteLeg[] | undefined, routeDepartureTime: string) {
  let cursor = parseClock(routeDepartureTime);
  return stops.map((stop, index) => {
    const inboundLegIndex = index - 1;
    if (inboundLegIndex >= 0) {
      cursor += Math.round((legs?.[inboundLegIndex]?.durationSeconds || 0) / 60);
    }
    const arrival = cursor;
    const fixedStart = fixedWindowStartMinutes(stop);
    const fixedEnd = fixedWindowEndMinutes(stop);
    const visitStart = isFixedStop(stop) && fixedStart !== null ? Math.max(arrival, fixedStart) : arrival;
    const departure = isFixedStop(stop) && fixedEnd !== null
      ? Math.max(visitStart + stopVisitMinutes(stop), fixedEnd)
      : visitStart + stopVisitMinutes(stop);
    const deadline = fixedArrivalDeadlineMinutes(stop);
    const isLate = isFixedStop(stop) && deadline !== null && arrival > deadline;
    const nextLegIndex = index;
    const travelToNextMinutes = Math.round((legs?.[nextLegIndex]?.durationSeconds || 0) / 60);
    cursor = departure;
    return {
      stop,
      arrival,
      visitStart,
      departure,
      waitMinutes: Math.max(0, visitStart - arrival),
      isLate,
      travelToNextMinutes
    };
  });
}

function stopToWaypointLabel(stop: Stop) {
  return `${stop.location.lat.toFixed(6)},${stop.location.lng.toFixed(6)}`;
}

function anitabiImageVariant(url?: string, plan = "h360") {
  if (!url) return "";
  try {
    const imageUrl = new URL(url);
    imageUrl.searchParams.set("plan", plan);
    return imageUrl.toString();
  } catch {
    if (url.includes("?plan=")) return url.replace(/\?plan=[^&]+/, `?plan=${plan}`);
    return `${url}?plan=${plan}`;
  }
}

function anitabiOriginalImageUrl(url?: string) {
  if (!url) return "";
  try {
    const imageUrl = new URL(url);
    imageUrl.searchParams.delete("plan");
    return imageUrl.toString();
  } catch {
    return url
      .replace(/[?&]plan=[^&]+/, "")
      .replace("?&", "?")
      .replace(/[?&]$/, "");
  }
}

function formatAnitabiSceneTime(seconds?: number) {
  if (seconds === undefined || seconds === null) return "";
  const value = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(value)) return "";
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatAnitabiMeta(stop: Stop) {
  return [
    stop.workTitle,
    stop.episode ? `EP ${stop.episode}` : "",
    formatAnitabiSceneTime(stop.sceneTimeSeconds)
  ].filter(Boolean).join(" / ");
}

function createAnitabiPreviewElement(stop: Stop) {
  const root = document.createElement("div");
  root.className = "anitabi-preview-card";

  const image = document.createElement("img");
  image.src = anitabiImageVariant(stop.imageUrl || stop.thumbnailUrl);
  image.alt = stop.name;
  image.loading = "lazy";
  root.appendChild(image);

  const body = document.createElement("div");
  body.className = "anitabi-preview-copy";

  const title = document.createElement("strong");
  title.textContent = stop.name;
  body.appendChild(title);

  const meta = formatAnitabiMeta(stop);
  if (meta) {
    const metaNode = document.createElement("span");
    metaNode.textContent = meta;
    body.appendChild(metaNode);
  }

  if (stop.origin) {
    const originNode = document.createElement("small");
    originNode.textContent = `来源：${stop.origin}`;
    body.appendChild(originNode);
  }

  root.appendChild(body);
  return root;
}

function tryParseCoordinates(text: string) {
  const normalized = decodeURIComponent(text.trim());
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

function parseKmlStops(text: string): Stop[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("KML 文件无法解析。");
  }

  return Array.from(doc.getElementsByTagName("Placemark"))
    .map((placemark) => {
      const name = placemark.getElementsByTagName("name")[0]?.textContent?.trim() || "KML 地点";
      const description = placemark.getElementsByTagName("description")[0]?.textContent?.trim();
      const coordinates = placemark.getElementsByTagName("coordinates")[0]?.textContent?.trim();
      if (!coordinates) return null;
      const [lngText, latText] = coordinates.split(/\s+/)[0].split(",");
      const lat = Number(latText);
      const lng = Number(lngText);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        id: makeId(),
        name,
        address: description,
        location: { lat, lng },
        stayMinutes: pilgrimageStayMinutes,
        source: "kml"
      } satisfies Stop;
    })
    .filter(Boolean) as Stop[];
}

function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildGoogleMapsUrl(stops: Stop[]) {
  const params = new URLSearchParams({
    api: "1",
    origin: stopToWaypointLabel(stops[0]),
    destination: stopToWaypointLabel(stops[stops.length - 1]),
    travelmode: "transit"
  });

  const waypoints = stops.slice(1, -1).map(stopToWaypointLabel);
  if (waypoints.length) {
    params.set("waypoints", waypoints.join("|"));
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function routeProviderLabel(provider?: string, mapProvider?: MapProvider) {
  if (provider === "navitime-auto") return "NAVITIME";
  if (provider === "google-auto") return "Google 自动";
  if (provider === "free-auto") return "自动";
  if (provider === "transitous-motis") return "Transitous";
  if (provider === "osrm-demo") return "OSRM";
  return mapProvider === "google" ? "Google" : "免费";
}

function haversineMeters(a: Stop, b: Stop) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRad(b.location.lat - a.location.lat);
  const dLng = toRad(b.location.lng - a.location.lng);
  const lat1 = toRad(a.location.lat);
  const lat2 = toRad(b.location.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function routeDistanceMeters(stops: Stop[]) {
  let distance = 0;
  for (let index = 0; index < stops.length - 1; index += 1) {
    distance += haversineMeters(stops[index], stops[index + 1]);
  }
  return distance;
}

function simulateStopOrder(stops: Stop[], startMinutes = parseClock("09:00")): RouteOrderSimulation {
  let cursor = startMinutes;
  let totalTravelMinutes = 0;
  let totalWaitMinutes = 0;
  let totalLatenessMinutes = 0;
  let bufferShortfallMinutes = 0;
  let missedFixedCount = 0;
  let distanceMeters = 0;

  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const stop = stops[index];
    const travelMinutes = estimateTravelMinutes(previous, stop);
    const legDistance = haversineMeters(previous, stop);
    totalTravelMinutes += travelMinutes;
    distanceMeters += legDistance;
    cursor += travelMinutes;

    if (isFixedStop(stop)) {
      const deadline = fixedArrivalDeadlineMinutes(stop);
      if (deadline !== null) {
        const lateness = Math.max(0, cursor - deadline);
        if (lateness > 0) missedFixedCount += 1;
        totalLatenessMinutes += lateness;
        bufferShortfallMinutes += Math.max(0, cursor - Math.max(startMinutes, deadline - fixedArrivalBufferMinutes));
        totalWaitMinutes += Math.max(0, deadline - cursor);
        cursor = Math.max(cursor, deadline);
      }
    }

    cursor += stopVisitMinutes(stop);
  }

  const elapsedMinutes = Math.max(0, cursor - startMinutes);
  return {
    endMinutes: cursor,
    totalTravelMinutes,
    totalWaitMinutes,
    totalLatenessMinutes,
    bufferShortfallMinutes,
    missedFixedCount,
    distanceMeters,
    score:
      missedFixedCount * 1_000_000_000 +
      totalLatenessMinutes * 1_000_000 +
      bufferShortfallMinutes * 12_000 +
      elapsedMinutes * 120 +
      totalTravelMinutes * 35 +
      totalWaitMinutes * 2 +
      distanceMeters / 1000
  };
}

function compareStopOrders(a: Stop[], b: Stop[], startMinutes: number) {
  const aScore = simulateStopOrder(a, startMinutes).score;
  const bScore = simulateStopOrder(b, startMinutes).score;
  return aScore - bScore;
}

function minDistanceToOrder(stop: Stop, order: Stop[]) {
  return order.reduce((best, placedStop) => Math.min(best, haversineMeters(stop, placedStop)), Number.POSITIVE_INFINITY);
}

function dedupeStopOrders(orders: Stop[][]) {
  const seen = new Set<string>();
  return orders.filter((order) => {
    const key = order.map((stop) => stop.id).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function transitCandidateLegCount(stops: Stop[]) {
  let count = 0;
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (haversineMeters(stops[index], stops[index + 1]) > autoTransitThresholdMeters) {
      count += 1;
    }
  }
  return count;
}

function nearestStopOrder(origin: Stop, candidates: Stop[]) {
  const remaining = [...candidates];
  const ordered: Stop[] = [];
  let current = origin;

  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((candidate, index) => {
      const distance = haversineMeters(current, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = next;
  }

  return ordered;
}

function deadlineGreedyStopOrder(
  origin: Stop,
  freeStopsInput: Stop[],
  fixedStopsInput: Stop[],
  endpoint: Stop | undefined,
  startMinutes: number
) {
  const fixedStops = [...fixedStopsInput].sort(
    (a, b) => (fixedArrivalDeadlineMinutes(a) ?? 1440) - (fixedArrivalDeadlineMinutes(b) ?? 1440)
  );
  const freeStops = [...freeStopsInput];
  const ordered: Stop[] = [origin];
  let current = origin;
  let cursor = startMinutes;

  for (const fixedStop of fixedStops) {
    const deadline = fixedArrivalDeadlineMinutes(fixedStop);
    const arrivalTarget = deadline === null ? null : Math.max(startMinutes, deadline - fixedArrivalBufferMinutes);
    while (freeStops.length && arrivalTarget !== null) {
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      freeStops.forEach((candidate, index) => {
        const projectedArrivalAtFixed =
          cursor +
          estimateTravelMinutes(current, candidate) +
          stopVisitMinutes(candidate) +
          estimateTravelMinutes(candidate, fixedStop);
        const latenessAgainstTarget = Math.max(0, projectedArrivalAtFixed - arrivalTarget);
        const score =
          latenessAgainstTarget * 1_000_000 +
          estimateTravelMinutes(current, candidate) * 100 +
          haversineMeters(current, candidate) / 100;
        if (projectedArrivalAtFixed <= deadline! && score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      if (bestIndex === -1) break;
      const [next] = freeStops.splice(bestIndex, 1);
      ordered.push(next);
      cursor += estimateTravelMinutes(current, next) + stopVisitMinutes(next);
      current = next;
    }

    ordered.push(fixedStop);
    const arrival = cursor + estimateTravelMinutes(current, fixedStop);
    const fixedStart = fixedWindowStartMinutes(fixedStop);
    cursor = Math.max(arrival, fixedStart ?? arrival) + stopVisitMinutes(fixedStop);
    current = fixedStop;
  }

  ordered.push(...nearestStopOrder(current, freeStops));
  if (endpoint) ordered.push(endpoint);
  return ordered;
}

function insertionStopOrder(
  origin: Stop,
  freeStopsInput: Stop[],
  fixedStopsInput: Stop[],
  endpoint: Stop | undefined,
  startMinutes: number
) {
  const fixedStops = [...fixedStopsInput].sort(
    (a, b) => (fixedArrivalDeadlineMinutes(a) ?? 1440) - (fixedArrivalDeadlineMinutes(b) ?? 1440)
  );
  const order = endpoint ? [origin, ...fixedStops, endpoint] : [origin, ...fixedStops];
  const remaining = [...freeStopsInput];

  while (remaining.length) {
    const currentScore = simulateStopOrder(order, startMinutes).score;
    const candidateEntries = remaining
      .map((stop, index) => ({ stop, index, distanceToOrder: minDistanceToOrder(stop, order) }))
      .sort((a, b) => a.distanceToOrder - b.distanceToOrder)
      .slice(0, Math.min(maxInsertionCandidatesPerRound, remaining.length));
    const lastInsertPosition = endpoint ? Math.max(1, order.length - 1) : order.length;
    let best: { remainingIndex: number; position: number; score: number; increase: number } | null = null;

    for (const candidate of candidateEntries) {
      for (let position = 1; position <= lastInsertPosition; position += 1) {
        const trial = [...order];
        trial.splice(position, 0, candidate.stop);
        const score = simulateStopOrder(trial, startMinutes).score;
        const increase = score - currentScore;
        if (!best || score < best.score || (score === best.score && increase < best.increase)) {
          best = {
            remainingIndex: candidate.index,
            position,
            score,
            increase
          };
        }
      }
    }

    if (!best) {
      const [fallback] = remaining.splice(0, 1);
      order.splice(lastInsertPosition, 0, fallback);
      continue;
    }

    const [next] = remaining.splice(best.remainingIndex, 1);
    order.splice(best.position, 0, next);
  }

  return order;
}

function improveStopOrderByRelocation(orderInput: Stop[], startMinutes: number) {
  if (orderInput.length > maxRelocationOptimizationStops) return orderInput;
  let order = [...orderInput];
  let bestScore = simulateStopOrder(order, startMinutes).score;
  const hasEndpoint = isEndpointStop(order[order.length - 1]);

  for (let pass = 0; pass < 2; pass += 1) {
    let improved = false;
    for (let fromIndex = 1; fromIndex < order.length; fromIndex += 1) {
      if (hasEndpoint && fromIndex === order.length - 1) continue;
      const movingStop = order[fromIndex];
      const without = order.filter((_, index) => index !== fromIndex);
      const lastInsertPosition = hasEndpoint ? Math.max(1, without.length - 1) : without.length;

      for (let toIndex = 1; toIndex <= lastInsertPosition; toIndex += 1) {
        if (toIndex === fromIndex || toIndex === fromIndex + 1) continue;
        const trial = [...without];
        trial.splice(toIndex, 0, movingStop);
        const score = simulateStopOrder(trial, startMinutes).score;
        if (score + 0.01 < bestScore) {
          order = trial;
          bestScore = score;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  return order;
}

function optimizeStopsForDay(stops: Stop[], startMinutes = parseClock("09:00")) {
  if (stops.length <= 2) return stops;
  const origin = stops[0];
  const endpoint = stops.slice(1).find(isEndpointStop);
  const middleStops = stops.slice(1).filter((stop) => stop.id !== endpoint?.id);
  const fixedStops = middleStops.filter(isFixedStop);
  const freeStops = middleStops.filter((stop) => !isFixedStop(stop));

  const nearestOrder = [origin, ...nearestStopOrder(origin, middleStops.filter((stop) => stop.id !== endpoint?.id))];
  if (endpoint) nearestOrder.push(endpoint);

  const candidates = dedupeStopOrders([
    stops,
    nearestOrder,
    deadlineGreedyStopOrder(origin, freeStops, fixedStops, endpoint, startMinutes),
    insertionStopOrder(origin, freeStops, fixedStops, endpoint, startMinutes)
  ]).map((order) => improveStopOrderByRelocation(order, startMinutes));

  return candidates.reduce((best, candidate) =>
    compareStopOrders(candidate, best, startMinutes) < 0 ? candidate : best
  );
}

function isSameStopOrder(a: Stop[], b: Stop[]) {
  return a.length === b.length && a.every((stop, index) => stop.id === b[index]?.id);
}

function buildRouteStopsForPlan(stops: Stop[]) {
  if (!stops.length) return [];
  const startStop = stops.find(isStartStop) || stops[0];
  const endStop = stops.find(isEndpointStop);
  const middleStops = stops.filter((stop) => stop.id !== startStop.id && stop.id !== endStop?.id);
  const routeStops = [startStop, ...middleStops];

  if (endStop) {
    if (endStop.id === startStop.id) {
      if (middleStops.length) routeStops.push(startStop);
    } else {
      routeStops.push(endStop);
    }
  }

  return routeStops;
}

function stopsFromRouteOrderForEditor(orderedStops: Stop[]) {
  if (orderedStops.length > 1 && orderedStops[0]?.id === orderedStops[orderedStops.length - 1]?.id) {
    return orderedStops.slice(0, -1);
  }
  return orderedStops;
}

function routeStartClock(stops: Stop[], fallback = "09:00") {
  const startStop = stops.find(isStartStop) || stops[0];
  return normalizeClockValue(startStop?.windowStart) || normalizeClockValue(fallback) || "09:00";
}

function routeDepartureClock(stops: Stop[], fallback = "09:00") {
  const startStop = stops.find(isStartStop) || stops[0];
  const startClock = routeStartClock(stops, fallback);
  if (!startStop) return startClock;
  return formatClock(parseClock(startClock) + stopVisitMinutes(startStop));
}

let mapsLoader: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string) {
  if (window.google?.maps) return Promise.resolve();
  if (mapsLoader) return mapsLoader;

  mapsLoader = new Promise((resolve, reject) => {
    let settled = false;
    const previousAuthFailure = window.gm_authFailure;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      mapsLoader = null;
      reject(new Error(message));
    };

    const timeout = window.setTimeout(() => {
      fail("Google Maps script loaded too slowly or did not call its ready callback.");
    }, 15000);

    window.__daytripGoogleMapsReady = finish;
    window.gm_authFailure = () => {
      previousAuthFailure?.();
      fail("Google Maps rejected this API key or its HTTP referrer.");
    };

    const existing = document.getElementById("google-maps-js");
    if (existing) {
      if (window.google?.maps) {
        finish();
      } else {
        existing.addEventListener("error", () => fail("Google Maps script failed to load."), { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.id = "google-maps-js";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&v=weekly&libraries=places,marker,geometry&loading=async&callback=__daytripGoogleMapsReady`;
    script.async = true;
    script.defer = true;
    script.addEventListener("error", () => fail("Google Maps script failed to load."), { once: true });
    document.head.appendChild(script);
  });

  return mapsLoader;
}

export default function App() {
  const [plans, setPlans] = useState<DayPlan[]>(loadLocalCachedPlans);
  const [newPlanDraft] = useState(loadNewPlanDraft);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [planName, setPlanName] = useState("");
  const [newPlanName, setNewPlanName] = useState(() => newPlanDraft.name);
  const [newPlanDate, setNewPlanDate] = useState(() => newPlanDraft.date);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [planSyncMode, setPlanSyncMode] = useState<"server" | "local">("local");
  const [stops, setStops] = useState<Stop[]>([]);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [tripDate, setTripDate] = useState(todayInputValue);
  const [startTime, setStartTime] = useState("09:00");
  const departureStop = null as Stop | null;
  const departureEndTime = startTime;
  const setDepartureStop = (_stop: Stop | null) => undefined;
  const setDepartureEndTime = (_value: string) => undefined;
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routePlanStale, setRoutePlanStale] = useState(false);
  const [markerRefreshKey, setMarkerRefreshKey] = useState(0);
  const [isRouting, setIsRouting] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchingAnitabi, setIsSearchingAnitabi] = useState(false);
  const [isImportingAnitabi, setIsImportingAnitabi] = useState(false);
  const [anitabiQuery, setAnitabiQuery] = useState("");
  const [anitabiResults, setAnitabiResults] = useState<AnitabiSearchResult[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapProvider, setMapProvider] = useState<MapProvider>(browserApiKey ? "google" : "osm");
  const [mapError, setMapError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [imageLightboxStop, setImageLightboxStop] = useState<Stop | null>(null);
  const [isBoxSelectMode, setIsBoxSelectMode] = useState(false);
  const [selectedStopIds, setSelectedStopIds] = useState<string[]>([]);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const googleMapRef = useRef<google.maps.Map | null>(null);
  const googleMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const googleInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const googleProjectionRef = useRef<google.maps.OverlayView | null>(null);
  const googlePolylineRef = useRef<google.maps.Polyline | null>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const leafletMarkersRef = useRef<L.Marker[]>([]);
  const leafletPolylineRef = useRef<L.Polyline | null>(null);
  const selectionStartRef = useRef<MapPoint | null>(null);
  const plansRef = useRef<DayPlan[]>(plans);
  const pendingActivePlanIdRef = useRef<string | null>(readStoredActivePlanId());
  const anitabiSearchRequestRef = useRef(0);
  const skipNextAnitabiAutoSearchRef = useRef(false);

  const persistPlanToServer = useCallback(
    async (plan: DayPlan) => {
      if (planSyncMode !== "server") return plan;
      return writePlanToServer(plan);
    },
    [planSyncMode]
  );

  const sortedPlans = useMemo(
    () =>
      [...plans].sort((a, b) => {
        const dateOrder = a.tripDate.localeCompare(b.tripDate);
        if (dateOrder !== 0) return dateOrder;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    [plans]
  );

  const loadPlanIntoEditor = useCallback((plan: DayPlan) => {
    pendingActivePlanIdRef.current = null;
    storeActivePlanId(plan.id);
    setActivePlanId(plan.id);
    setPlanName(plan.name);
    setTripDate(plan.tripDate);
    setStartTime(plan.startTime);
    setStops(clonePlain(plan.stops));
    setRoutePlan(clonePlain(plan.routePlan));
    setRoutePlanStale(false);
    setSelectedStopId(null);
    setSelectedStopIds([]);
    setSearchResults([]);
    setAnitabiQuery("");
    setAnitabiResults([]);
    setIsBoxSelectMode(false);
    setSelectionRect(null);
    setLastSavedAt(plan.updatedAt);
  }, []);

  const openPlan = useCallback(
    (id: string) => {
      const plan = plans.find((item) => item.id === id);
      if (!plan) {
        setToast("没有找到这个规划。");
        return;
      }
      loadPlanIntoEditor(plan);
    },
    [loadPlanIntoEditor, plans]
  );

  const createPlan = useCallback(async () => {
    const plan = createDayPlan({
      name: newPlanName,
      tripDate: newPlanDate,
      stops: []
    });
    setPlans((current) => [plan, ...current]);
    setNewPlanName("");
    loadPlanIntoEditor(plan);
    try {
      const savedPlan = planSyncMode === "server" ? await createPlanOnServer(plan) : plan;
      setPlans((current) => current.map((item) => (item.id === plan.id ? savedPlan : item)));
      loadPlanIntoEditor(savedPlan);
      setToast(planSyncMode === "server" ? "已创建并同步到服务端。" : "已创建新的一日规划。");
    } catch (error) {
      setToast(error instanceof Error ? `${error.message} 已先保存在本地缓存。` : "规划创建到服务端失败，已先保存在本地缓存。");
    }
  }, [loadPlanIntoEditor, newPlanDate, newPlanName, planSyncMode]);

  const deletePlan = useCallback(async (id: string) => {
    const previousPlans = plans;
    setPlans((current) => current.filter((plan) => plan.id !== id));
    try {
      if (planSyncMode === "server") {
        await deletePlanFromServer(id);
      }
      setToast("规划已删除。");
    } catch (error) {
      setPlans(previousPlans);
      setToast(error instanceof Error ? error.message : "服务端规划删除失败。");
    }
  }, [planSyncMode, plans]);

  const renamePlan = useCallback((id: string, name: string) => {
    setPlans((current) =>
      current.map((plan) =>
        plan.id === id
          ? {
              ...plan,
              name,
              updatedAt: new Date().toISOString()
            }
          : plan
      )
    );
  }, []);

  const persistListedPlan = useCallback(
    async (id: string) => {
      const plan = plans.find((item) => item.id === id);
      if (!plan) return;
      try {
        await persistPlanToServer(plan);
      } catch (error) {
        setToast(error instanceof Error ? error.message : "规划保存到服务端失败。");
      }
    },
    [persistPlanToServer, plans]
  );

  const saveActivePlan = useCallback(
    async (showToast = false) => {
      if (!activePlanId) return;
      const savedAt = new Date().toISOString();
      const nextPlan = {
        id: activePlanId,
        name: planName.trim() || defaultPlanName(tripDate),
        tripDate,
        startTime,
        departureEndTime: startTime,
        departureStop: null,
        transitTimePreference: "departure" as TransitTimePreference,
        stops: clonePlain(stops),
        routePlan: clonePlain(routePlan),
        createdAt: plansRef.current.find((plan) => plan.id === activePlanId)?.createdAt || savedAt,
        updatedAt: savedAt
      };
      setPlans((current) =>
        current.map((plan) =>
          plan.id === activePlanId
            ? nextPlan
            : plan
        )
      );
      setLastSavedAt(savedAt);
      try {
        const savedPlan = await persistPlanToServer(nextPlan);
        setPlans((current) => current.map((plan) => (plan.id === activePlanId ? savedPlan : plan)));
        setLastSavedAt(savedPlan.updatedAt);
        if (showToast) {
          setToast(planSyncMode === "server" ? "规划已保存到服务端。" : "规划已保存。");
        }
      } catch (error) {
        if (showToast) {
          setToast(error instanceof Error ? `${error.message} 已先保存在本地缓存。` : "服务端保存失败，已先保存在本地缓存。");
        }
      }
    },
    [activePlanId, persistPlanToServer, planName, planSyncMode, routePlan, startTime, stops, tripDate]
  );

  const backToPlanList = useCallback(() => {
    void saveActivePlan(false);
    pendingActivePlanIdRef.current = null;
    storeActivePlanId(null);
    setActivePlanId(null);
    setSelectedStopId(null);
    setSelectedStopIds([]);
    setSearchResults([]);
    setIsBoxSelectMode(false);
    setSelectionRect(null);
  }, [saveActivePlan]);

  const destroyMapInstances = useCallback(() => {
    googleInfoWindowRef.current?.close();
    googleInfoWindowRef.current = null;

    for (const marker of googleMarkersRef.current) {
      marker.map = null;
    }
    googleMarkersRef.current = [];

    if (googlePolylineRef.current) {
      googlePolylineRef.current.setMap(null);
      googlePolylineRef.current = null;
    }
    if (googleMapRef.current && window.google?.maps?.event) {
      google.maps.event.clearInstanceListeners(googleMapRef.current);
    }
    googleMapRef.current = null;
    googleProjectionRef.current = null;

    if (leafletPolylineRef.current) {
      leafletPolylineRef.current.remove();
      leafletPolylineRef.current = null;
    }
    for (const marker of leafletMarkersRef.current) {
      marker.remove();
    }
    leafletMarkersRef.current = [];
    if (leafletMapRef.current) {
      leafletMapRef.current.remove();
      leafletMapRef.current = null;
    }

    setMapReady(false);
    setMapError(null);
  }, []);

  const addStop = useCallback((stop: Stop, role: StopRole = "normal") => {
    const nextStop = normalizeStopRolePatch({ ...stop, role }, role);
    setStops((current) => {
      if (role === "end") {
        return [...current.filter((item) => !isEndpointStop(item)), nextStop];
      }
      const endpoint = current.find(isEndpointStop);
      const regularStops = current.filter((item) => !isEndpointStop(item));
      return endpoint ? [...regularStops, nextStop, endpoint] : [...current, nextStop];
    });
    setSelectedStopId(nextStop.id);
    setSelectedStopIds([]);
    setRoutePlanStale((current) => Boolean(routePlan) || current);
    setSearchResults([]);
  }, [routePlan]);

  const updateStop = useCallback((id: string, patch: Partial<Stop>, shouldInvalidateRoute = false) => {
    setStops((current) =>
      current.map((stop) => {
        if (stop.id !== id) return stop;
        const nextStop = { ...stop, ...patch };
        const stayMinutes = normalizeStayMinutes(nextStop.stayMinutes, isEndpointStop(nextStop) ? 0 : pilgrimageStayMinutes);
        if (isFixedStop(nextStop)) {
          const windowStart = normalizeClockValue(nextStop.windowStart) || "12:00";
          return {
            ...nextStop,
            windowStart,
            windowEnd: derivedFixedWindowEndClock(windowStart, stayMinutes),
            stayMinutes
          };
        }
        return {
          ...nextStop,
          stayMinutes
        };
      })
    );
    if (shouldInvalidateRoute) {
      setRoutePlanStale((current) => Boolean(routePlan) || current);
    }
  }, [routePlan]);

  const updateStopRole = useCallback((id: string, role: StopRole) => {
    setStops((current) => {
      const next = current
        .map((stop) => {
          if (stop.id === id) return normalizeStopRolePatch(stop, role);
          if (role === "end" && isEndpointStop(stop)) return normalizeStopRolePatch(stop, "normal");
          return stop;
        });
      if (role !== "end") return next;
      const endpoint = next.find((stop) => stop.id === id);
      return endpoint
        ? [...next.filter((stop) => stop.id !== id), endpoint]
        : next;
    });
    setSelectedStopId(id);
    setSelectedStopIds([]);
    setRoutePlanStale((current) => Boolean(routePlan) || current);
  }, [routePlan]);

  const updateStopKind = useCallback((id: string, selection: StopKindSelection) => {
    setStops((current) => {
      const next = current.map((stop) => {
        if (stop.id === id) return applyStopKindSelection(stop, selection);
        let nextStop = stop;
        if (selection === "departure" && isStartStop(nextStop)) {
          nextStop = { ...nextStop, isStart: false };
        }
        if (selection === "end" && isEndpointStop(nextStop)) {
          nextStop = {
            ...nextStop,
            role: nextStop.role === "end" ? "normal" : nextStop.role,
            isEnd: false,
            stayMinutes: pilgrimageStayMinutes
          };
        }
        return nextStop;
      });
      const selected = next.find((stop) => stop.id === id);
      if (!selected) return next;
      if (isStartStop(selected)) return [selected, ...next.filter((stop) => stop.id !== id)];
      if (isEndpointStop(selected)) return [...next.filter((stop) => stop.id !== id), selected];
      return next;
    });
    setSelectedStopId(id);
    setSelectedStopIds([]);
    setRoutePlanStale((current) => Boolean(routePlan) || current);
  }, [routePlan]);

  const moveStopToDeparture = useCallback(
    (id: string) => {
      const stop = stops.find((item) => item.id === id);
      if (!stop) return;
      void ({
        ...stop,
        id: `departure-${stop.id}`,
        stayMinutes: 0,
        role: undefined,
        windowStart: undefined,
        windowEnd: undefined,
        note: stop.note || "出发点"
      });
      setStops((current) => current.filter((item) => item.id !== id));
      setSelectedStopId(null);
      setSelectedStopIds([]);
      setRoutePlanStale((current) => Boolean(routePlan) || current);
    },
    [routePlan, stops]
  );

  const removeStop = useCallback((id: string) => {
    setStops((current) => current.filter((stop) => stop.id !== id));
    setSelectedStopId((current) => (current === id ? null : current));
    setSelectedStopIds((current) => current.filter((stopId) => stopId !== id));
    setRoutePlanStale((current) => Boolean(routePlan) || current);
  }, [routePlan]);

  const deleteSelectedStops = useCallback(() => {
    if (!selectedStopIds.length) {
      setToast("请先框选要删除的地点。");
      return;
    }

    const selected = new Set(selectedStopIds);
    setStops((current) => current.filter((stop) => !selected.has(stop.id)));
    setSelectedStopId(null);
    setSelectedStopIds([]);
    setRoutePlanStale((current) => Boolean(routePlan) || current);
    setToast(`已删除 ${selected.size} 个选中地点。`);
  }, [routePlan, selectedStopIds]);

  const reorderStops = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setStops((current) => {
      const fromIndex = current.findIndex((stop) => stop.id === fromId);
      const toIndex = current.findIndex((stop) => stop.id === toId);
      if (fromIndex === -1 || toIndex === -1) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setRoutePlanStale((current) => Boolean(routePlan) || current);
  }, [routePlan]);

  const routeStops = useMemo(
    () => buildRouteStopsForPlan(stops),
    [stops]
  );

  const activeScheduleStartTime = useMemo(() => routeStartClock(stops, startTime), [startTime, stops]);
  const activeRouteStartTime = useMemo(() => routeDepartureClock(stops, startTime), [startTime, stops]);

  const isRoutePlanStale = useMemo(() => {
    if (routePlanStale) return true;
    if (!routePlan?.routeStopIds?.length) return false;
    if (routePlan.routeStopIds.length !== routeStops.length) return true;
    return routePlan.routeStopIds.some((stopId, index) => stopId !== routeStops[index]?.id);
  }, [routePlan?.routeStopIds, routePlanStale, routeStops]);

  const routeLegForStops = useCallback(
    (fromStop: Stop, toStop: Stop, fallbackIndex: number) => {
      if (!routePlan) return undefined;
      if (routePlan.routeStopIds?.length) {
        const routeLegIndex = routePlan.routeStopIds.findIndex(
          (stopId, index) => stopId === fromStop.id && routePlan.routeStopIds?.[index + 1] === toStop.id
        );
        return routeLegIndex >= 0 ? routePlan.legs[routeLegIndex] : undefined;
      }
      return isRoutePlanStale ? undefined : routePlan.legs[fallbackIndex];
    },
    [isRoutePlanStale, routePlan]
  );

  const schedule = useMemo<ScheduleItem[]>(() => {
    return buildScheduleItems(stops, isRoutePlanStale ? undefined : routePlan?.legs, activeScheduleStartTime);
  }, [activeScheduleStartTime, isRoutePlanStale, routePlan?.legs, stops]);

  const routeMetrics = useMemo(() => {
    const totalStay = stops.reduce((sum, stop) => sum + stopVisitMinutes(stop), 0);
    const totalTravel = Math.round((routePlan?.durationSeconds || 0) / 60);
    const end = schedule.length
      ? schedule[schedule.length - 1].departure
      : parseClock(activeScheduleStartTime) + totalStay + totalTravel;
    return {
      totalStay,
      totalTravel,
      end,
      distance: routePlan?.distanceMeters || 0
    };
  }, [activeScheduleStartTime, routePlan, schedule, stops]);

  const routingStatusText = useMemo(() => {
    const legCount = Math.max(0, routeStops.length - 1);
    if (!legCount) return "";
    const transitLegCount = transitCandidateLegCount(routeStops);
    const estimateMinutes = Math.max(1, Math.ceil(transitLegCount / routeRequestQuotaPerMinute));
    if (transitLegCount > routeRequestQuotaPerMinute) {
      return `正在规划 ${legCount} 段路线，其中约 ${transitLegCount} 段需要公共交通查询。查询会按 ${routeRequestQuotaPerMinute} 次/分钟排队，预计至少 ${estimateMinutes} 分钟，请保持页面打开。`;
    }
    if (!transitLegCount) {
      return `正在规划 ${legCount} 段短距离路线。预计主要使用步行，完成前请保持页面打开。`;
    }
    return `正在规划 ${legCount} 段路线。会优先查询 ${transitLegCount} 段 1km 以上的公共交通，完成前请保持页面打开。`;
  }, [routeStops]);

  const selectedStopSet = useMemo(() => new Set(selectedStopIds), [selectedStopIds]);

  const stopBoundsKey = useMemo(
    () => stops.map((stop) => `${stop.location.lat.toFixed(6)},${stop.location.lng.toFixed(6)}`).join("|"),
    [stops]
  );

  const routeBoundsKey = useMemo(
    () => routeStops.map((stop) => `${stop.location.lat.toFixed(6)},${stop.location.lng.toFixed(6)}`).join("|"),
    [routeStops]
  );

  const projectStopToMapPoint = useCallback(
    (stop: Stop): MapPoint | null => {
      if (mapProvider === "google") {
        const projection = googleProjectionRef.current?.getProjection();
        if (!projection || !window.google?.maps) return null;
        const point =
          projection.fromLatLngToContainerPixel?.(new google.maps.LatLng(stop.location.lat, stop.location.lng)) ||
          projection.fromLatLngToDivPixel(new google.maps.LatLng(stop.location.lat, stop.location.lng));
        return point ? { x: point.x, y: point.y } : null;
      }

      if (!leafletMapRef.current) return null;
      const point = leafletMapRef.current.latLngToContainerPoint([stop.location.lat, stop.location.lng]);
      return { x: point.x, y: point.y };
    },
    [mapProvider]
  );

  const updateSelectionFromRect = useCallback(
    (rect: SelectionRect) => {
      const selectedIds = stops
        .filter((stop) => {
          const point = projectStopToMapPoint(stop);
          if (!point) return false;
          return (
            point.x >= rect.left &&
            point.x <= rect.left + rect.width &&
            point.y >= rect.top &&
            point.y <= rect.top + rect.height
          );
        })
        .map((stop) => stop.id);

      setSelectedStopIds(selectedIds);
      setSelectedStopId(selectedIds[0] || null);
      setToast(selectedIds.length ? `已选中 ${selectedIds.length} 个地点。` : "框选范围内没有地点。");
    },
    [projectStopToMapPoint, stops]
  );

  const pointFromPointerEvent = useCallback((event: PointerEvent<HTMLDivElement>): MapPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    };
  }, []);

  const rectFromPoints = useCallback((start: MapPoint, end: MapPoint): SelectionRect => {
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    return {
      left,
      top,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }, []);

  const handleSelectionPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isBoxSelectMode) return;
      const point = pointFromPointerEvent(event);
      selectionStartRef.current = point;
      setSelectionRect({ left: point.x, top: point.y, width: 0, height: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isBoxSelectMode, pointFromPointerEvent]
  );

  const handleSelectionPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = selectionStartRef.current;
      if (!start) return;
      setSelectionRect(rectFromPoints(start, pointFromPointerEvent(event)));
      event.preventDefault();
    },
    [pointFromPointerEvent, rectFromPoints]
  );

  const finishSelection = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = selectionStartRef.current;
      if (!start) return;
      const rect = rectFromPoints(start, pointFromPointerEvent(event));
      selectionStartRef.current = null;
      setSelectionRect(null);
      if (rect.width >= 8 && rect.height >= 8) {
        updateSelectionFromRect(rect);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [pointFromPointerEvent, rectFromPoints, updateSelectionFromRect]
  );

  const cancelSelection = useCallback((event: PointerEvent<HTMLDivElement>) => {
    selectionStartRef.current = null;
    setSelectionRect(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!imageLightboxStop) return undefined;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setImageLightboxStop(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [imageLightboxStop]);

  useEffect(() => {
    plansRef.current = plans;
  }, [plans]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        newPlanDraftStorageKey,
        JSON.stringify({
          date: isDateInputValue(newPlanDate) ? newPlanDate : todayInputValue(),
          name: newPlanName
        })
      );
    } catch (error) {
      console.error("Failed to persist new plan draft", error);
    }
  }, [newPlanDate, newPlanName]);

  useEffect(() => {
    let cancelled = false;

    async function loadServerPlans() {
      const localPlans = loadLocalCachedPlans();
      try {
        let serverPlans = await readPlansFromServer();
        const alreadyMigrated = window.localStorage.getItem(planServerMigrationKey) === "1";
        if (!serverPlans.length && localPlans.length && !alreadyMigrated) {
          const uploadedPlans: DayPlan[] = [];
          for (const localPlan of localPlans) {
            uploadedPlans.push(await createPlanOnServer(localPlan));
          }
          serverPlans = uploadedPlans;
          window.localStorage.setItem(planServerMigrationKey, "1");
          if (!cancelled) {
            setToast("已将本地规划同步到服务端。");
          }
        }

        if (cancelled) return;
        setPlans(serverPlans);
        setPlanSyncMode("server");
      } catch (error) {
        if (!cancelled) {
          setPlans(localPlans);
          setPlanSyncMode("local");
          setToast(error instanceof Error ? `${error.message} 暂时使用本地缓存。` : "服务端规划读取失败，暂时使用本地缓存。");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPlans(false);
        }
      }
    }

    void loadServerPlans();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(planCacheStorageKey, JSON.stringify(plans));
    } catch (error) {
      console.error("Failed to persist plans", error);
    }
  }, [plans]);

  useEffect(() => {
    if (activePlanId || isLoadingPlans) return;

    const pendingActivePlanId = pendingActivePlanIdRef.current;
    if (!pendingActivePlanId) return;

    const plan = plans.find((item) => item.id === pendingActivePlanId);
    if (plan) {
      loadPlanIntoEditor(plan);
      return;
    }

    pendingActivePlanIdRef.current = null;
    storeActivePlanId(null);
  }, [activePlanId, isLoadingPlans, loadPlanIntoEditor, plans]);

  useEffect(() => {
    if (!activePlanId) return undefined;
    const timer = window.setTimeout(() => {
      void saveActivePlan(false);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activePlanId, planName, routePlan, saveActivePlan, startTime, stops, tripDate]);

  useEffect(() => {
    if (activePlanId) return;
    destroyMapInstances();
  }, [activePlanId, destroyMapInstances]);

  const initializeLeafletMap = useCallback(() => {
    if (!mapNodeRef.current || leafletMapRef.current) return;
    googleProjectionRef.current = null;

    const map = L.map(mapNodeRef.current, {
      zoomControl: false
    }).setView([defaultCenter.lat, defaultCenter.lng], 12);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    map.on("click", (event: L.LeafletMouseEvent) => {
      addStop({
        id: makeId(),
        name: "自定义地点",
        address: `${event.latlng.lat.toFixed(6)}, ${event.latlng.lng.toFixed(6)}`,
        location: { lat: event.latlng.lat, lng: event.latlng.lng },
        stayMinutes: pilgrimageStayMinutes,
        source: "osm-click"
      });
    });

    leafletMapRef.current = map;
    setMapProvider("osm");
    setMapError(null);
    setMapReady(true);
  }, [addStop]);

  useEffect(() => {
    if (!activePlanId) return undefined;
    let cancelled = false;

    async function initializeMap() {
      if (!browserApiKey) {
        initializeLeafletMap();
        return;
      }

      try {
        await loadGoogleMaps(browserApiKey);
        if (cancelled || !mapNodeRef.current) return;

        const { Map } = (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary;
        await google.maps.importLibrary("marker");
        await google.maps.importLibrary("places");
        await google.maps.importLibrary("geometry");

        const map = new Map(mapNodeRef.current, {
          center: defaultCenter,
          zoom: 12,
          mapId: googleMapId,
          clickableIcons: true,
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false
        });

        map.addListener("click", (event: google.maps.MapMouseEvent) => {
          const latLng = event.latLng;
          if (!latLng) return;
          addStop({
            id: makeId(),
            name: "自定义地点",
            address: `${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}`,
            location: { lat: latLng.lat(), lng: latLng.lng() },
            stayMinutes: pilgrimageStayMinutes,
            source: "map-click"
          });
        });

        const projectionOverlay = new google.maps.OverlayView();
        projectionOverlay.onAdd = () => undefined;
        projectionOverlay.draw = () => undefined;
        projectionOverlay.onRemove = () => undefined;
        projectionOverlay.setMap(map);
        googleProjectionRef.current = projectionOverlay;

        if (searchInputRef.current) {
          const autocomplete = new google.maps.places.Autocomplete(searchInputRef.current, {
            fields: ["place_id", "name", "formatted_address", "geometry"]
          });
          autocomplete.bindTo("bounds", map);
          autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            const location = place.geometry?.location;
            if (!location) {
              setToast("请选择一个带坐标的地点。");
              return;
            }
            addStop({
              id: makeId(),
              name: place.name || "未命名地点",
              address: place.formatted_address,
              placeId: place.place_id,
              location: { lat: location.lat(), lng: location.lng() },
              stayMinutes: pilgrimageStayMinutes,
              source: "google-places"
            });
            if (searchInputRef.current) {
              searchInputRef.current.value = "";
            }
          });
        }

        googleMapRef.current = map;
        setMapProvider("google");
        setMapError(null);
        setMapReady(true);
      } catch (error) {
        console.error("Google Maps initialization failed", error);
        const message = error instanceof Error ? error.message : "未知错误";
        setToast(`Google 地图不可用：${message}，已切换到 OpenStreetMap。`);
        initializeLeafletMap();
      }
    }

    initializeMap();
    return () => {
      cancelled = true;
    };
  }, [activePlanId, addStop, initializeLeafletMap]);

  useEffect(() => {
    if (!activePlanId || !mapReady) return;

    if (mapProvider === "google") {
      if (!googleMapRef.current || !window.google?.maps?.marker) return;
      for (const marker of googleMarkersRef.current) {
        marker.map = null;
      }

      const markers: google.maps.marker.AdvancedMarkerElement[] = [];
      if (departureStop) {
        const markerContent = document.createElement("button");
        markerContent.className = "stop-marker is-departure";
        markerContent.textContent = "出";
        markerContent.title = departureStop.name;
        markers.push(
          new google.maps.marker.AdvancedMarkerElement({
            map: googleMapRef.current,
            position: departureStop.location,
            title: departureStop.name,
            content: markerContent,
            collisionBehavior: google.maps.CollisionBehavior.REQUIRED,
            zIndex: 2000
          })
        );
      }

      markers.push(...stops.map((stop, index) => {
        const selected = selectedStopId === stop.id || selectedStopSet.has(stop.id);
        const markerContent = document.createElement("button");
        markerContent.className = `stop-marker ${selected ? "is-selected" : ""} ${isStartStop(stop) ? "is-start" : ""} ${isPilgrimageStop(stop) ? "is-pilgrimage" : ""} ${isFixedStop(stop) ? "is-fixed" : ""} ${isEndpointStop(stop) ? "is-endpoint" : ""}`;
        markerContent.textContent = routeStopSequenceLabel(stop, index);
        markerContent.title = stop.name;
        markerContent.addEventListener("click", () => {
          setSelectedStopId(stop.id);
          if (stop.imageUrl || stop.thumbnailUrl) {
            setImageLightboxStop(stop);
          }
        });

        const marker = new google.maps.marker.AdvancedMarkerElement({
          map: googleMapRef.current,
          position: stop.location,
          title: stop.name,
          content: markerContent,
          collisionBehavior: google.maps.CollisionBehavior.REQUIRED,
          zIndex: selected ? 2000 : isStartStop(stop) || isEndpointStop(stop) ? 1500 : 1000 + index
        });

        if (stop.imageUrl || stop.thumbnailUrl) {
          markerContent.classList.add("has-preview");
          markerContent.addEventListener("mouseenter", () => {
            if (!googleInfoWindowRef.current) {
              googleInfoWindowRef.current = new google.maps.InfoWindow({
                disableAutoPan: true,
                pixelOffset: new google.maps.Size(0, -6)
              });
            }
            googleInfoWindowRef.current.setContent(createAnitabiPreviewElement(stop));
            googleInfoWindowRef.current.open({
              map: googleMapRef.current!,
              anchor: marker,
              shouldFocus: false
            });
          });
          markerContent.addEventListener("mouseleave", () => {
            googleInfoWindowRef.current?.close();
          });
        }

        return marker;
      }));
      googleMarkersRef.current = markers;
      return;
    }

    if (!leafletMapRef.current) return;
    for (const marker of leafletMarkersRef.current) {
      marker.remove();
    }

    const markers: L.Marker[] = [];
    if (departureStop) {
      const icon = L.divIcon({
        className: "leaflet-stop-marker",
        html: `<button class="stop-marker is-departure">出</button>`,
        iconSize: [31, 31],
        iconAnchor: [15.5, 15.5]
      });
      markers.push(
        L.marker([departureStop.location.lat, departureStop.location.lng], { icon })
          .addTo(leafletMapRef.current!)
      );
    }

    markers.push(...stops.map((stop, index) => {
      const selected = selectedStopId === stop.id || selectedStopSet.has(stop.id);
      const size = selected ? 37 : 31;
      const icon = L.divIcon({
        className: "leaflet-stop-marker",
        html: `<button class="stop-marker ${selected ? "is-selected" : ""} ${isStartStop(stop) ? "is-start" : ""} ${isPilgrimageStop(stop) ? "is-pilgrimage" : ""} ${isFixedStop(stop) ? "is-fixed" : ""} ${isEndpointStop(stop) ? "is-endpoint" : ""}">${routeStopSequenceLabel(stop, index)}</button>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      });
      const marker = L.marker([stop.location.lat, stop.location.lng], { icon })
        .addTo(leafletMapRef.current!)
        .on("click", () => {
          setSelectedStopId(stop.id);
          if (stop.imageUrl || stop.thumbnailUrl) {
            setImageLightboxStop(stop);
          }
        });

      if (stop.imageUrl || stop.thumbnailUrl) {
        marker
          .on("mouseover", () => {
            if (!marker.getTooltip()) {
              marker.bindTooltip(createAnitabiPreviewElement(stop), {
                className: "anitabi-map-tooltip",
                direction: "top",
                offset: [0, -18],
                opacity: 1
              });
            }
            marker.openTooltip();
          })
          .on("mouseout", () => marker.closeTooltip());
      }

      return marker;
    }));
    leafletMarkersRef.current = markers;
  }, [activePlanId, mapProvider, mapReady, markerRefreshKey, selectedStopId, selectedStopSet, stops]);

  useEffect(() => {
    if (!activePlanId || !mapReady || !routeStops.length) return;

    if (mapProvider === "google") {
      if (!googleMapRef.current || !window.google?.maps) return;
      const bounds = new google.maps.LatLngBounds();
      routeStops.forEach((stop) => bounds.extend(stop.location));
      googleMapRef.current.fitBounds(bounds, 80);
      return;
    }

    if (!leafletMapRef.current) return;
    const bounds = L.latLngBounds(routeStops.map((stop) => [stop.location.lat, stop.location.lng] as L.LatLngExpression));
    leafletMapRef.current.fitBounds(bounds, { padding: [70, 70], maxZoom: 15 });
  }, [activePlanId, mapProvider, mapReady, routeBoundsKey, routeStops]);

  useEffect(() => {
    if (!activePlanId || !mapReady) return;

    if (mapProvider === "google") {
      if (!googleMapRef.current || !window.google?.maps?.geometry) return;
      if (googlePolylineRef.current) {
        googlePolylineRef.current.setMap(null);
        googlePolylineRef.current = null;
      }
      if (!routePlan?.encodedPolyline && !routePlan?.coordinates?.length) return;

      const path = routePlan.coordinates?.length
        ? routePlan.coordinates.map(([lat, lng]) => ({ lat, lng }))
        : google.maps.geometry.encoding.decodePath(routePlan.encodedPolyline || "");
      const polyline = new google.maps.Polyline({
        path,
        map: googleMapRef.current,
        strokeColor: "#167c80",
        strokeOpacity: 0.94,
        strokeWeight: 5,
        zIndex: 50
      });
      const bounds = new google.maps.LatLngBounds();
      path.forEach((point) => bounds.extend(point));
      routeStops.forEach((stop) => bounds.extend(stop.location));
      const map = googleMapRef.current;
      map.fitBounds(bounds, 90);
      const refreshMarkers = () => {
        for (const marker of googleMarkersRef.current) {
          marker.map = null;
          marker.map = map;
        }
      };
      google.maps.event.addListenerOnce(map, "idle", refreshMarkers);
      window.setTimeout(() => {
        refreshMarkers();
        setMarkerRefreshKey((current) => current + 1);
      }, 350);
      googlePolylineRef.current = polyline;
      return;
    }

    if (!leafletMapRef.current) return;
    if (leafletPolylineRef.current) {
      leafletPolylineRef.current.remove();
      leafletPolylineRef.current = null;
    }
    if (!routePlan?.coordinates?.length) return;

    const polyline = L.polyline(routePlan.coordinates, {
      color: "#167c80",
      opacity: 0.94,
      weight: 5
    }).addTo(leafletMapRef.current);
    const bounds = polyline.getBounds();
    routeStops.forEach((stop) => bounds.extend([stop.location.lat, stop.location.lng]));
    leafletMapRef.current.fitBounds(bounds, { padding: [80, 80] });
    leafletPolylineRef.current = polyline;
  }, [activePlanId, mapProvider, mapReady, routeBoundsKey, routePlan, routeStops]);

  const runNominatimSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setToast("请输入至少两个字再搜索。");
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      const data = await readApiJson(response, "地点搜索失败。");
      setSearchResults(data);
      if (!data.length) {
        setToast("没有找到匹配地点。");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "地点搜索失败。");
    } finally {
      setIsSearching(false);
    }
  }, []);

  const addSearchResult = useCallback(
    (result: SearchResult, role: StopRole = "normal") => {
      addStop({
        id: makeId(),
        name: result.name,
        address: result.address,
        location: { lat: result.lat, lng: result.lng },
        stayMinutes: pilgrimageStayMinutes,
        source: result.source
      }, role);
      if (searchInputRef.current) {
        searchInputRef.current.value = "";
      }
    },
    [addStop]
  );

  const calculateRoute = useCallback(
    async () => {
      if (routeStops.length < 2) {
        setToast("请先设置出发点并添加至少一个地点。");
        return;
      }

      if (parseClock(departureEndTime) < parseClock(startTime)) {
        setToast("起点结束时间不能早于开始时间。");
        return;
      }

      const routeDepartureTime = activeRouteStartTime;
      const transitDateTime = buildLocalDateTimeIso(tripDate, routeDepartureTime);
      if (!transitDateTime) {
        setToast("请选择有效的路线日期和时间。");
        return;
      }
      const transitLocalDateTime = `${tripDate}T${routeDepartureTime}:00`;
      const orderedStops = optimizeStopsForDay(routeStops, parseClock(routeDepartureTime));
      const stopsForRouting = orderedStops.map((stop) => ({
        ...stop,
        stayMinutes: stopVisitMinutes(stop)
      }));
      const nextPlanStops = stopsFromRouteOrderForEditor(orderedStops);
      const orderChanged = !isSameStopOrder(stops, nextPlanStops);
      const beforeDistance = routeDistanceMeters(routeStops);
      const afterDistance = routeDistanceMeters(orderedStops);

      setIsRouting(true);
      const transitLegCount = transitCandidateLegCount(orderedStops);
      if (transitLegCount > routeRequestQuotaPerMinute) {
        setToast(`当前预计有 ${transitLegCount} 段公共交通查询，会按 ${routeRequestQuotaPerMinute} 次/分钟排队，请稍等。`);
      }
      try {
        const response = await fetch("/api/auto-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stops: stopsForRouting,
            transitDateTime,
            transitLocalDateTime,
            transitTimePreference: "departure"
          })
        });
        const data = await readApiJson(response, "路线计算失败。");

        const route = data.routes?.[0];
        if (!route) {
          throw new Error("没有返回可用路线。");
        }

        if (orderChanged) {
          setStops(nextPlanStops);
          setSelectedStopId(nextPlanStops[0]?.id || null);
          setSelectedStopIds([]);
        }
        const nextRoutePlan: RoutePlan = {
          distanceMeters: route.distanceMeters || 0,
          durationSeconds: route.durationSeconds || parseDurationSeconds(route.duration),
          encodedPolyline: route.polyline?.encodedPolyline,
          coordinates: route.coordinates,
          legs: (route.legs || []).map((leg: any) => ({
            distanceMeters: leg.distanceMeters || 0,
            durationSeconds: leg.durationSeconds || parseDurationSeconds(leg.duration),
            encodedPolyline: leg.polyline?.encodedPolyline,
            summary: leg.summary,
            steps: Array.isArray(leg.steps)
              ? leg.steps.map((step: any) => ({
                  mode: step.mode,
                  line: step.line,
                  headsign: step.headsign,
                  from: step.from,
                  to: step.to,
                  startTime: step.startTime,
                  endTime: step.endTime,
                  durationSeconds: step.durationSeconds || parseDurationSeconds(step.duration),
                  distanceMeters: step.distanceMeters || 0,
                  instructions: step.instructions
                }))
              : [],
            mode: leg.mode,
            preferredMode: leg.preferredMode,
            fallbackReason: leg.fallbackReason,
            startTime: leg.startTime,
            endTime: leg.endTime,
            transfers: leg.transfers,
            fare: leg.fare
          })),
          routeStopIds: orderedStops.map((stop) => stop.id),
          provider: route.provider
        };
        setRoutePlan(nextRoutePlan);
        setRoutePlanStale(false);
        const fallbackCount = route.strategy?.fallbackWalkingLegs || 0;
        const lateFixedStops = buildScheduleItems(nextPlanStops, nextRoutePlan.legs, routeDepartureTime)
          .filter((item) => item.isLate)
          .map((item) => item.stop.name);
        const sortMessage = orderChanged
          ? `已按定点时间窗优化访问顺序，直线串联约减少 ${formatDistance(Math.max(0, beforeDistance - afterDistance))}。`
          : "当前顺序已经比较紧凑。";
        setToast(
          lateFixedStops.length
            ? `${sortMessage}${lateFixedStops.slice(0, 3).join("、")} 可能赶不上定点时间，请调整时间窗或删减前序地点。`
            : fallbackCount
            ? `${sortMessage}${fallbackCount} 段公共交通无结果，已改步行。`
            : `${sortMessage}路线已更新。`
        );
      } catch (error) {
        setToast(error instanceof Error ? error.message : "路线计算失败。");
      } finally {
        setIsRouting(false);
      }
    },
    [activeRouteStartTime, routeStops, stops, tripDate]
  );

  const handleSearchEnter = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = event.currentTarget.value;
      const coordinates = tryParseCoordinates(value);
      if (coordinates) {
        addStop({
          id: makeId(),
          name: "坐标地点",
          address: `${coordinates.lat.toFixed(6)}, ${coordinates.lng.toFixed(6)}`,
          location: coordinates,
          stayMinutes: pilgrimageStayMinutes,
          source: "coordinate"
        });
        event.currentTarget.value = "";
        return;
      }

      void runNominatimSearch(value);
    },
    [addStop, runNominatimSearch]
  );

  const addFromSearchText = useCallback(() => {
    const value = searchInputRef.current?.value || "";
    const coordinates = tryParseCoordinates(value);
    if (coordinates) {
      addStop({
        id: makeId(),
        name: "坐标地点",
        address: `${coordinates.lat.toFixed(6)}, ${coordinates.lng.toFixed(6)}`,
        location: coordinates,
        stayMinutes: pilgrimageStayMinutes,
        source: "coordinate"
      });
      if (searchInputRef.current) {
        searchInputRef.current.value = "";
      }
      return;
    }

    void runNominatimSearch(value);
  }, [addStop, runNominatimSearch]);

  const handleKmlFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const importedStops = parseKmlStops(text);
      if (!importedStops.length) {
        setToast("没有在 KML 里找到点位。");
        return;
      }
      setStops((current) => appendBeforeEndpoint(current, importedStops));
      setRoutePlanStale((current) => Boolean(routePlan) || current);
      setToast(`已导入 ${importedStops.length} 个地点。`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "KML 导入失败。");
    }
  }, [routePlan]);

  const runAnitabiSearch = useCallback(async (queryInput: string, options: { showToast?: boolean } = {}) => {
    const query = queryInput.trim();
    const requestId = ++anitabiSearchRequestRef.current;
    if (!/^\d+$/.test(query) && query.length < 2) {
      setAnitabiResults([]);
      setIsSearchingAnitabi(false);
      if (options.showToast) setToast("请输入至少两个字的作品名。");
      return;
    }

    setIsSearchingAnitabi(true);
    if (options.showToast) setAnitabiResults([]);
    try {
      const response = await fetch(`/api/anitabi/search?q=${encodeURIComponent(query)}`);
      const data = await readApiJson(response, "Anitabi 作品查找失败。");
      const results = Array.isArray(data?.results) ? data.results : [];
      if (requestId !== anitabiSearchRequestRef.current) return;
      setAnitabiResults(results);
      if (options.showToast) {
        setToast(results.length ? `找到 ${results.length} 个可导入作品。` : "没有找到含截图点位的 Anitabi 作品。");
      }
    } catch (error) {
      if (requestId !== anitabiSearchRequestRef.current) return;
      setAnitabiResults([]);
      if (options.showToast) {
        setToast(error instanceof Error ? error.message : "Anitabi 作品查找失败。");
      }
    } finally {
      if (requestId === anitabiSearchRequestRef.current) {
        setIsSearchingAnitabi(false);
      }
    }
  }, []);

  const searchAnitabiWorks = useCallback(() => {
    void runAnitabiSearch(anitabiQuery, { showToast: true });
  }, [anitabiQuery, runAnitabiSearch]);

  useEffect(() => {
    if (skipNextAnitabiAutoSearchRef.current) {
      skipNextAnitabiAutoSearchRef.current = false;
      anitabiSearchRequestRef.current += 1;
      setIsSearchingAnitabi(false);
      setAnitabiResults([]);
      return;
    }

    const query = anitabiQuery.trim();
    if (!query || (!/^\d+$/.test(query) && query.length < 2)) {
      anitabiSearchRequestRef.current += 1;
      setIsSearchingAnitabi(false);
      setAnitabiResults([]);
      return;
    }

    const timer = window.setTimeout(() => {
      void runAnitabiSearch(query);
    }, 450);

    return () => window.clearTimeout(timer);
  }, [anitabiQuery, runAnitabiSearch]);

  const importAnitabiSubjectPoints = useCallback(async (subjectIdInput: number | string) => {
    const subjectId = String(subjectIdInput).trim();
    if (!/^\d+$/.test(subjectId)) {
      setToast("请选择有效的 Bangumi subject。");
      return;
    }

    setIsImportingAnitabi(true);
    try {
      const response = await fetch(`/api/anitabi/detail?subjectId=${encodeURIComponent(subjectId)}`);
      const data = await readApiJson(response, "Anitabi 导入失败。");

      const subject = data.subject || {};
      const workTitle = subject.cn || subject.title || `Bangumi ${subjectId}`;
      const points = Array.isArray(data.points)
        ? data.points
        : Array.isArray(data.litePoints)
          ? data.litePoints
          : [];
      const importedStops = points
        .filter((point: any) => Array.isArray(point.geo) && point.geo.length >= 2)
        .map((point: any) => ({
          id: makeId(),
          name: point.cn || point.name || "Anitabi 地点",
          address: [workTitle, point.ep ? `EP ${point.ep}` : null, formatAnitabiSceneTime(point.s)]
            .filter(Boolean)
            .join(" / "),
          location: { lat: Number(point.geo[0]), lng: Number(point.geo[1]) },
          stayMinutes: pilgrimageStayMinutes,
          note: "巡礼",
          role: "pilgrimage",
          source: `Anitabi ${subjectId}`,
          imageUrl: anitabiImageVariant(point.image),
          thumbnailUrl: point.image,
          episode: Number(point.ep) || undefined,
          sceneTimeSeconds: Number.isFinite(Number(point.s)) ? Number(point.s) : undefined,
          origin: point.origin,
          originUrl: point.originURL,
          anitabiPointId: point.id,
          workTitle
        })) satisfies Stop[];

      if (!importedStops.length) {
        setToast("这个作品暂时没有可导入的截图点位。");
        return;
      }

      setStops((current) => appendBeforeEndpoint(current, importedStops));
      setRoutePlanStale((current) => Boolean(routePlan) || current);
      skipNextAnitabiAutoSearchRef.current = true;
      setAnitabiQuery(workTitle);
      setAnitabiResults([]);
      setToast(`已导入 ${importedStops.length} 个 Anitabi 截图点位。鼠标悬浮地点或地图标记可看图。`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Anitabi 导入失败。");
    } finally {
      setIsImportingAnitabi(false);
    }
  }, [routePlan]);

  const clearTrip = useCallback(() => {
    setStops([]);
    setSelectedStopId(null);
    setSelectedStopIds([]);
    setRoutePlan(null);
    setRoutePlanStale(false);
  }, []);

  const exportJson = useCallback(() => {
    downloadText(
      `${(planName.trim() || "daytrip-plan").replace(/[\\/:*?"<>|]+/g, "-")}.json`,
      JSON.stringify(
        {
          title: planName.trim() || "一日行程",
          exportedAt: new Date().toISOString(),
          mapProvider,
          tripDate,
          startTime,
          departureEndTime: startTime,
          departureStop: null,
          transitTimePreference: "departure",
          routeStrategy: "time-window-aware-nearest-neighbor-transit-first",
          stops,
          routePlan
        },
        null,
        2
      ),
      "application/json"
    );
    setToast("JSON 已导出。");
  }, [mapProvider, planName, routePlan, startTime, stops, tripDate]);

  const copyGoogleMapsLink = useCallback(async () => {
    if (routeStops.length < 2) {
      setToast("请先设置出发点并添加至少一个地点。");
      return;
    }
    const url = buildGoogleMapsUrl(routeStops);
    try {
      await navigator.clipboard.writeText(url);
      setToast("路线链接已复制。");
    } catch {
      downloadText("route-link.txt", url, "text/plain");
      setToast("浏览器无法复制，已导出链接文件。");
    }
  }, [routeStops]);

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id);
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, targetId: string) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain") || draggingId;
      if (sourceId) {
        reorderStops(sourceId, targetId);
      }
      setDraggingId(null);
    },
    [draggingId, reorderStops]
  );

  const renderRouteLegCard = (
    routeLeg: RouteLeg,
    fromStop: Stop,
    toStop: Stop,
    fromLabel: string,
    toLabel: string
  ) => {
    const fareText = formatFare(routeLeg.fare);
    const legSteps: RouteStep[] = routeLeg.steps?.length
      ? routeLeg.steps
      : [
          {
            mode: routeLeg.mode,
            line: routeLeg.summary,
            durationSeconds: routeLeg.durationSeconds,
            distanceMeters: routeLeg.distanceMeters,
            from: fromStop.name,
            to: toStop.name
          }
        ];
    const RouteSummaryIcon = routeLeg.mode === "WALK" ? Footprints : TrainFront;

    return (
      <div className={`route-leg-card ${routeLeg.mode === "WALK" ? "is-walk" : "is-transit"}`}>
        <div className="route-leg-spine" aria-hidden="true">
          <span>{fromLabel}</span>
          <i />
          <span>{toLabel}</span>
        </div>
        <div className="route-leg-content">
          <div className="route-leg-header">
            <div>
              <p>{fromLabel} → {toLabel}</p>
              <strong>{fromStop.name} → {toStop.name}</strong>
            </div>
            <div className="route-leg-stats">
              <span>{formatDuration(routeLeg.durationSeconds)}</span>
              <span>{formatDistance(routeLeg.distanceMeters)}</span>
              {routeLeg.mode === "TRANSIT" && typeof routeLeg.transfers === "number" && <span>换乘 {routeLeg.transfers} 次</span>}
              {fareText && <span>{fareText}</span>}
            </div>
          </div>
          <ol className="route-step-list" aria-label={`${fromStop.name} 到 ${toStop.name} 的路线步骤`}>
            {legSteps.map((step, stepIndex) => {
              const walking = isWalkingStep(step);
              const stationText = routeStepStations(step);
              const instruction = cleanInstruction(step.instructions);
              const meta = routeStepMeta(step);
              return (
                <li className={`route-step ${walking ? "is-walk" : "is-transit"}`} key={`${fromStop.id}-${toStop.id}-${stepIndex}`}>
                  <div className="route-step-icon">
                    {walking ? <Footprints size={15} /> : <RouteSummaryIcon size={15} />}
                  </div>
                  <div className="route-step-copy">
                    <div className="route-step-main">
                      <strong>{routeStepTitle(step)}</strong>
                      {meta && <span>{meta}</span>}
                    </div>
                    {stationText && <p>{stationText}</p>}
                    {instruction && instruction !== stationText && <p className="route-step-note">{instruction}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    );
  };

  if (!activePlanId) {
    return (
      <main className="plans-shell">
        <section className="plans-workspace" aria-label="一日规划列表">
          <header className="plans-header">
            <div>
              <p className="eyebrow">Daytrip Planner</p>
              <h1>一日规划</h1>
            </div>
            <span>
              {isLoadingPlans
                ? "同步中"
                : `${plans.length} 个规划 · ${planSyncMode === "server" ? "服务端同步" : "本地缓存"}`}
            </span>
          </header>

          <div className="new-plan-panel">
            <label className="field">
              <span>日期</span>
              <input
                type="date"
                value={newPlanDate}
                onInput={(event) => setNewPlanDate(event.currentTarget.value)}
                onChange={(event) => setNewPlanDate(event.currentTarget.value)}
              />
            </label>
            <label className="field new-plan-name">
              <span>规划名称</span>
              <input
                value={newPlanName}
                placeholder={`${formatPlanDate(newPlanDate || todayInputValue())} 一日规划`}
                onChange={(event) => setNewPlanName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void createPlan();
                  }
                }}
              />
            </label>
            <button className="primary-button" type="button" onClick={() => void createPlan()}>
              <Plus size={18} />
              新建规划
            </button>
          </div>

          {sortedPlans.length > 0 ? (
            <section className="plan-card-grid" aria-label="已保存的一日规划">
              {sortedPlans.map((plan) => {
                const totalTravel = Math.round((plan.routePlan?.durationSeconds || 0) / 60);
                return (
                  <article className="plan-card" key={plan.id}>
                    <div className="plan-card-topline">
                      <span>
                        <CalendarDays size={16} />
                        {formatPlanDate(plan.tripDate)}
                      </span>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="删除规划"
                        aria-label="删除规划"
                        onClick={() => void deletePlan(plan.id)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                    <input
                      className="plan-card-name"
                      value={plan.name}
                      aria-label="规划名称"
                      onChange={(event) => renamePlan(plan.id, event.target.value)}
                      onBlur={() => void persistListedPlan(plan.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                    <div className="plan-card-stats">
                      <span>{plan.stops.length} 个地点</span>
                      <span>{plan.routePlan ? `${formatDistance(plan.routePlan.distanceMeters)} · ${totalTravel} 分钟` : "未规划路线"}</span>
                      <span>{formatSavedAt(plan.updatedAt) ? `已保存 ${formatSavedAt(plan.updatedAt)}` : "未保存"}</span>
                    </div>
                    <button className="secondary-button" type="button" onClick={() => openPlan(plan.id)}>
                      <Route size={17} />
                      进入规划
                    </button>
                  </article>
                );
              })}
            </section>
          ) : (
            <div className="empty-plan-state">
              <CalendarDays size={34} />
              <h2>还没有一日规划</h2>
              <p>选择日期、填写名称，然后创建一个新的规划。</p>
            </div>
          )}
        </section>

        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="planner-panel" aria-label="行程规划">
        <header className="panel-header">
          <div>
            <p className="eyebrow">{formatPlanDate(tripDate)} · {mapProvider === "google" ? "Google Maps Daytrip" : "OpenStreetMap Free Mode"}</p>
            <input
              className="plan-title-input"
              value={planName}
              aria-label="规划名称"
              placeholder={defaultPlanName(tripDate)}
              onChange={(event) => setPlanName(event.target.value)}
            />
            <p className="save-status">{lastSavedAt ? `已保存 ${formatSavedAt(lastSavedAt)}` : "尚未保存"}</p>
          </div>
          <div className="header-actions">
            <button className="icon-button subtle" type="button" title="返回规划列表" aria-label="返回规划列表" onClick={backToPlanList}>
              <ArrowLeft size={18} />
            </button>
            <button className="icon-button subtle" type="button" title="保存规划" aria-label="保存规划" onClick={() => void saveActivePlan(true)}>
              <Save size={18} />
            </button>
            <button className="icon-button subtle" type="button" title="清空地点" aria-label="清空地点" onClick={clearTrip}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="date-time-grid">
          <label className="field">
            <span>日期</span>
            <input
              type="date"
              value={tripDate}
              onInput={(event) => {
                setTripDate(event.currentTarget.value);
                setRoutePlanStale((current) => Boolean(routePlan) || current);
              }}
              onChange={(event) => {
                setTripDate(event.currentTarget.value);
                setRoutePlanStale((current) => Boolean(routePlan) || current);
              }}
            />
          </label>
          <label className="field">
            <span>起点开始</span>
            <input
              type="time"
              value={startTime}
              onChange={(event) => {
                setStartTime(event.target.value);
                setRoutePlanStale((current) => Boolean(routePlan) || current);
              }}
            />
          </label>
          <label className="field">
            <span>起点结束</span>
            <input
              type="time"
              value={departureEndTime}
              onChange={(event) => {
                setDepartureEndTime(event.target.value);
                setRoutePlanStale((current) => Boolean(routePlan) || current);
              }}
            />
          </label>
        </div>

        {departureStop && (
          <div className="departure-current">
            <MapPin size={16} />
            <div>
              <strong>{departureStop.name}</strong>
              <span className="type-pill is-departure">起点</span>
              <span>{departureStop.address || `${departureStop.location.lat.toFixed(5)}, ${departureStop.location.lng.toFixed(5)}`}</span>
            </div>
            <button
              className="icon-button danger"
              type="button"
              title="清除出发点"
              aria-label="清除出发点"
              onClick={() => {
                setDepartureStop(null);
                setRoutePlanStale((current) => Boolean(routePlan) || current);
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="search-wrap">
          <div className="search-row">
            <MapPin size={18} />
            <input
              ref={searchInputRef}
              className="place-search"
              placeholder={mapProvider === "google" ? "添加要去的地点，或粘贴地图链接/坐标" : "添加 OSM 地点，或粘贴坐标/地图链接"}
              onKeyDown={handleSearchEnter}
            />
            <button
              className="icon-button"
              type="button"
              title={isSearching ? "搜索中" : "添加或搜索"}
              aria-label={isSearching ? "搜索中" : "添加或搜索"}
              onClick={addFromSearchText}
            >
              <Plus size={18} />
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((result) => (
                <div className="search-result-card" key={result.id}>
                  <button className="search-result-main" type="button" onClick={() => addSearchResult(result)}>
                    <strong>{result.name}</strong>
                    <span>{result.address}</span>
                  </button>
                  <button className="search-result-end" type="button" onClick={() => addSearchResult(result, "end")}>
                    设终点
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="anitabi-search-box">
          <div className="anitabi-row">
            <input
              value={anitabiQuery}
              placeholder="输入作品名，如 吹响吧 / CLANNAD"
              onChange={(event) => {
                setAnitabiQuery(event.target.value);
                setAnitabiResults([]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void searchAnitabiWorks();
                }
              }}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={isSearchingAnitabi || isImportingAnitabi}
              onClick={searchAnitabiWorks}
            >
              <MapPin size={18} />
              {isSearchingAnitabi ? "查找中" : "查找 Anitabi"}
            </button>
          </div>
          {(isSearchingAnitabi || anitabiResults.length > 0) && (
            <div className="anitabi-results" aria-label="Anitabi 作品候选">
              {isSearchingAnitabi && !anitabiResults.length ? (
                <div className="anitabi-result-empty">正在查找 Anitabi 作品...</div>
              ) : (
                anitabiResults.map((result) => {
                  const displayTitle = result.cn || result.title || `Bangumi ${result.id}`;
                  const originalTitle = result.title && result.title !== displayTitle ? result.title : "";
                  const meta = [
                    result.city,
                    result.date,
                    `${result.pointsLength || 0} 点位`,
                    `${result.imagesLength || 0} 截图`
                  ].filter(Boolean);
                  return (
                    <article className="anitabi-result-card" key={result.id}>
                      {result.cover ? (
                        <img className="anitabi-result-cover" src={result.cover} alt="" loading="lazy" />
                      ) : (
                        <div className="anitabi-result-cover" aria-hidden="true" />
                      )}
                      <div className="anitabi-result-copy">
                        <strong>{displayTitle}</strong>
                        {originalTitle && <span>{originalTitle}</span>}
                        <small>{meta.join(" / ")}</small>
                        {Array.isArray(result.samplePoints) && result.samplePoints.length > 0 && (
                          <small>{result.samplePoints.join("、")}</small>
                        )}
                      </div>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={isImportingAnitabi}
                        onClick={() => void importAnitabiSubjectPoints(result.id)}
                      >
                        <Upload size={16} />
                        {isImportingAnitabi ? "导入中" : "导入"}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div className="route-actions">
          <button className="primary-button" type="button" disabled={isRouting} onClick={() => calculateRoute()}>
            {isRouting ? <span className="button-spinner" aria-hidden="true" /> : <Route size={18} />}
            {isRouting ? "正在规划" : "自动规划路线"}
          </button>
          {isRouting && (
            <div className="routing-status" role="status" aria-live="polite">
              <span className="inline-spinner" aria-hidden="true" />
              <span>{routingStatusText}</span>
            </div>
          )}
          {routePlan && isRoutePlanStale && !isRouting && (
            <div className="route-stale-note" role="status">
              已保留上一次路线；新增、删除或时间调整尚未纳入，点击自动规划路线后更新。
            </div>
          )}
          <div className="selection-actions">
            <button
              className={`secondary-button ${isBoxSelectMode ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                setIsBoxSelectMode((current) => !current);
                setSelectionRect(null);
              }}
            >
              <LocateFixed size={17} />
              {isBoxSelectMode ? "退出框选" : "框选地点"}
            </button>
            <button className="secondary-button danger" type="button" disabled={!selectedStopIds.length} onClick={deleteSelectedStops}>
              <Trash2 size={17} />
              删除选中
            </button>
          </div>
          <div className="selection-status">
            <span>{selectedStopIds.length ? `已选中 ${selectedStopIds.length} 个地点` : "开启框选后，在地图上拖拽选择地点"}</span>
            {selectedStopIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedStopIds([]);
                  setSelectedStopId(null);
                }}
              >
                清除选择
              </button>
            )}
          </div>
        </div>

        <div className="stats-strip" aria-label="路线统计">
          <div>
            <span>距离</span>
            <strong>{formatDistance(routeMetrics.distance)}</strong>
          </div>
          <div>
            <span>路上</span>
            <strong>{routeMetrics.totalTravel} 分钟</strong>
          </div>
          <div>
            <span>结束</span>
            <strong>{formatClock(routeMetrics.end)}</strong>
          </div>
        </div>

        <section className="stop-list" aria-label="地点列表">
          {departureStop && stops[0] && routeLegForStops(departureStop, stops[0], 0) && (
            <Fragment key="departure-leg">
              {renderRouteLegCard(routeLegForStops(departureStop, stops[0], 0)!, departureStop, stops[0], "出", stopSequenceLabel(stops[0], 0))}
            </Fragment>
          )}
          {stops.map((stop, index) => {
            const item = schedule[index];
            const selected = selectedStopId === stop.id || selectedStopSet.has(stop.id);
            const routeReturnStop = index === stops.length - 1 && routeStops.length > stops.length ? routeStops[routeStops.length - 1] : undefined;
            const nextStop = stops[index + 1] || routeReturnStop;
            const routeLeg = nextStop ? routeLegForStops(stop, nextStop, index) : undefined;
            const RouteSummaryIcon = routeLeg?.mode === "WALK" ? Footprints : TrainFront;
            const role = getStopRole(stop);
            const kind = stopKindSelection(stop);
            const stopIndexLabel = routeStopSequenceLabel(stop, index);
            return (
              <Fragment key={stop.id}>
                <div
                  className={`stop-card ${selected ? "is-selected" : ""} ${isStartStop(stop) ? "is-start" : ""} ${isPilgrimageStop(stop) ? "is-pilgrimage" : ""} ${isFixedStop(stop) ? "is-fixed" : ""} ${isEndpointStop(stop) ? "is-endpoint" : ""} ${item.isLate ? "is-late" : ""}`}
                  draggable
                  onDragStart={(event) => handleDragStart(event, stop.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(event, stop.id)}
                  onClick={() => setSelectedStopId(stop.id)}
                >
                  <div className="drag-handle" title="拖动排序" aria-label="拖动排序">
                    <GripVertical size={16} />
                  </div>
                  <div className="stop-index">{stopIndexLabel}</div>
                  <div className="stop-body">
                    <input
                      className="stop-title"
                      value={stop.name}
                      onChange={(event) => updateStop(stop.id, { name: event.target.value })}
                    />
                    <p>{stop.address || `${stop.location.lat.toFixed(5)}, ${stop.location.lng.toFixed(5)}`}</p>
                    <textarea
                      className="stop-note"
                      value={stop.note || ""}
                      placeholder="在这里要做什么"
                      rows={2}
                      onChange={(event) => updateStop(stop.id, { note: event.target.value })}
                    />
                    <div className="stop-controls">
                      <label className={`compact-field role-field is-${kind}`}>
                        <span>类型</span>
                        <select
                          value={kind}
                          onChange={(event) => updateStopKind(stop.id, event.target.value as StopKindSelection)}
                        >
                          <option value="departure">起点</option>
                          <option value="normal">普通点</option>
                          <option value="pilgrimage">巡礼点</option>
                          <option value="fixed">定点</option>
                          <option value="end">终点</option>
                        </select>
                      </label>
                      <label className="compact-field stay-minutes-field">
                        <span>停留</span>
                        <input
                          type="number"
                          min={0}
                          max={720}
                          step={1}
                          value={stopVisitMinutes(stop)}
                          onChange={(event) => updateStop(stop.id, { stayMinutes: normalizeStayMinutes(event.target.value, 0) }, true)}
                        />
                      </label>
                      {isStartStop(stop) && (
                        <div className="time-window-fields time-window-fields-start">
                          <label className="compact-field">
                            <span>开始</span>
                            <input
                              type="time"
                              value={stop.windowStart || ""}
                              onChange={(event) => updateStop(stop.id, { windowStart: event.target.value, windowEnd: undefined }, true)}
                            />
                          </label>
                        </div>
                      )}
                      {role === "fixed" && (
                        <div className="time-window-fields">
                          <label className="compact-field">
                            <span>开始</span>
                            <input
                              type="time"
                              value={stop.windowStart || ""}
                              onChange={(event) => updateStop(stop.id, { windowStart: event.target.value }, true)}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                    <div className="stop-meta">
                      <span>
                        <Clock3 size={14} />
                        {isEndpointStop(stop) ? `到达 ${formatClock(item.arrival)}` : `${formatClock(item.visitStart)} - ${formatClock(item.departure)}`}
                      </span>
                      <span className={`type-pill is-${kind === "end" ? "endpoint" : kind}`}>{stopKindLabel(stop)}</span>
                      <span className="visit-duration">停留 {stopVisitMinutes(stop)} 分钟</span>
                      {item.waitMinutes > 0 && <span>等待 {item.waitMinutes} 分钟</span>}
                      {item.isLate && <span className="is-late-badge">定点可能迟到</span>}
                      {nextStop && (
                        <span>
                          <Navigation size={14} />
                          {item.travelToNextMinutes} 分钟
                        </span>
                      )}
                      {nextStop && routeLeg?.summary && (
                        <span className="route-summary" title={routeLeg.summary}>
                          <RouteSummaryIcon size={14} />
                          {routeLeg.summary}
                        </span>
                      )}
                      {stop.source?.startsWith("Anitabi") && <span>{stop.source}</span>}
                      {(stop.imageUrl || stop.thumbnailUrl) && (
                        <button
                          className="meta-image-button"
                          type="button"
                          title="查看大图"
                          aria-label={`查看 ${stop.name} 的大图`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setImageLightboxStop(stop);
                          }}
                        >
                          <ImageIcon size={14} />
                          查看图片
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="stop-actions">
                    <button
                      className="icon-button danger"
                      type="button"
                      title="删除地点"
                      aria-label="删除地点"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeStop(stop.id);
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>
                {nextStop && routeLeg && renderRouteLegCard(routeLeg, stop, nextStop, routeStopSequenceLabel(stop, index), routeStopSequenceLabel(nextStop, index + 1))}
              </Fragment>
            );
          })}
        </section>

        <footer className="panel-footer">
          <input ref={fileInputRef} type="file" accept=".kml,application/vnd.google-earth.kml+xml" hidden onChange={handleKmlFile} />
          <button className="utility-button" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={17} />
            导入 KML
          </button>
          <button className="utility-button" type="button" onClick={copyGoogleMapsLink}>
            <Copy size={17} />
            复制路线
          </button>
          <button className="utility-button" type="button" onClick={exportJson}>
            <Download size={17} />
            导出 JSON
          </button>
        </footer>
      </section>

      <section className="map-panel" aria-label="地图">
        <div ref={mapNodeRef} className="map-canvas" />
        {isBoxSelectMode && (
          <div
            className="map-selection-layer"
            onPointerDown={handleSelectionPointerDown}
            onPointerMove={handleSelectionPointerMove}
            onPointerUp={finishSelection}
            onPointerCancel={cancelSelection}
            aria-label="框选地图地点"
          >
            {selectionRect && (
              <div
                className="map-selection-rect"
                style={{
                  left: selectionRect.left,
                  top: selectionRect.top,
                  width: selectionRect.width,
                  height: selectionRect.height
                }}
              />
            )}
          </div>
        )}
        {mapError && (
          <div className="map-placeholder">
            <div>
              <LocateFixed size={32} />
              <h2>地图暂不可用</h2>
              <p>{mapError}</p>
            </div>
          </div>
        )}
        <div className="map-overlay">
          <RefreshCw size={15} />
          <span>
            {routePlan
              ? `${isRoutePlanStale ? "上次路线 · " : ""}${formatDuration(routePlan.durationSeconds)} · ${routeProviderLabel(routePlan.provider, mapProvider)}`
              : `${mapProvider === "google" ? "Google" : "免费"}模式`}
          </span>
        </div>
      </section>

      {imageLightboxStop && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`${imageLightboxStop.name} 大图`} onClick={() => setImageLightboxStop(null)}>
          <div className="image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>{imageLightboxStop.name}</strong>
                {formatAnitabiMeta(imageLightboxStop) && <span>{formatAnitabiMeta(imageLightboxStop)}</span>}
              </div>
              <button className="icon-button subtle" type="button" title="关闭大图" aria-label="关闭大图" onClick={() => setImageLightboxStop(null)}>
                <X size={18} />
              </button>
            </header>
            <img
              src={anitabiOriginalImageUrl(imageLightboxStop.thumbnailUrl || imageLightboxStop.imageUrl)}
              alt={imageLightboxStop.name}
              onError={(event) => {
                const fallbackUrl = anitabiImageVariant(imageLightboxStop.imageUrl || imageLightboxStop.thumbnailUrl);
                if (fallbackUrl && event.currentTarget.src !== fallbackUrl) {
                  event.currentTarget.src = fallbackUrl;
                }
              }}
            />
            {(imageLightboxStop.origin || imageLightboxStop.originUrl) && (
              <footer>
                {imageLightboxStop.origin && <span>来源：{imageLightboxStop.origin}</span>}
                {imageLightboxStop.originUrl && (
                  <a href={imageLightboxStop.originUrl} target="_blank" rel="noreferrer">
                    查看来源
                  </a>
                )}
              </footer>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

