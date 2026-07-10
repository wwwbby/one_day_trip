import dotenv from "dotenv";
import express from "express";
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const isVercel = process.env.VERCEL === "1";
const port = Number(process.env.PORT || 5173);
const app = express();

app.use(express.json({ limit: "5mb" }));

const travelModeAllowlist = new Set([
  "DRIVE",
  "WALK",
  "BICYCLE",
  "TRANSIT",
  "TWO_WHEELER"
]);

const osrmProfiles = {
  DRIVE: "driving",
  TWO_WHEELER: "driving",
  WALK: "foot",
  BICYCLE: "bike"
};

const transitousUserAgent =
  process.env.TRANSITOUS_USER_AGENT || "DaytripPlanner/0.1 local prototype contact=local";
const bangumiUserAgent =
  process.env.BANGUMI_USER_AGENT || "DaytripPlanner/0.1 local prototype contact=local";
const autoTransitThresholdMeters = 1000;
const navitimeRequestsPerMinute = 50;
const navitimeMinRequestIntervalMs = Math.ceil(60000 / navitimeRequestsPerMinute);
const navitimeRapidApiKey = process.env.NAVITIME_RAPIDAPI_KEY || "";
const navitimeRapidApiHost =
  process.env.NAVITIME_RAPIDAPI_HOST || "navitime-route-totalnavi.p.rapidapi.com";
const plansFilePath = path.join(__dirname, ".data", "daytrip-plans.json");
let nextNavitimeRequestAt = 0;
let sqlClient = null;
let plansTableReadyPromise = null;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForNavitimeRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, nextNavitimeRequestAt - now);
  nextNavitimeRequestAt = Math.max(now, nextNavitimeRequestAt) + navitimeMinRequestIntervalMs;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function getSqlClient() {
  if (!process.env.DATABASE_URL) return null;
  if (!sqlClient) {
    sqlClient = neon(process.env.DATABASE_URL);
  }
  return sqlClient;
}

async function ensurePlansTable() {
  const sql = getSqlClient();
  if (!sql) return null;
  if (!plansTableReadyPromise) {
    plansTableReadyPromise = sql`
      create table if not exists daytrip_plans (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `;
  }
  await plansTableReadyPromise;
  return sql;
}

function validIsoDate(value, fallback = new Date().toISOString()) {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : value;
}

function validTripDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}

function cleanText(value, fallback, maxLength = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function cleanClock(value) {
  if (typeof value !== "string") return undefined;
  return /^\d{2}:\d{2}$/.test(value) ? value : undefined;
}

function cleanStayMinutes(value, fallback = 5) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return fallback;
  return Math.max(0, Math.min(720, minutes));
}

function parseClockMinutes(value) {
  const clock = cleanClock(value) || "09:00";
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function formatClockMinutes(totalMinutes) {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function derivedFixedWindowEndClock(windowStart, stayMinutes) {
  const start = cleanClock(windowStart);
  return start ? formatClockMinutes(parseClockMinutes(start) + stayMinutes) : undefined;
}

function isAnitabiStopLike(value) {
  return Boolean(
    value?.anitabiPointId ||
    value?.workTitle ||
    (typeof value?.source === "string" && value.source.startsWith("Anitabi"))
  );
}

function normalizeStoredStop(value) {
  const lat = Number(value?.location?.lat);
  const lng = Number(value?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const legacyEnd = value?.role === "end";
  const isStart = Boolean(value?.isStart);
  const rawRole = value?.role;
  const role =
    rawRole === "fixed" || rawRole === "pilgrimage"
      ? rawRole
      : rawRole === "special"
        ? "pilgrimage"
        : isAnitabiStopLike(value)
          ? "pilgrimage"
          : "normal";
  const isEnd = (Boolean(value?.isEnd) || legacyEnd) && !isStart;
  const stayMinutes = cleanStayMinutes(value?.stayMinutes, isEnd ? 0 : 5);
  const windowStart = role === "fixed"
    ? cleanClock(value?.windowStart) || "12:00"
    : isStart
      ? cleanClock(value?.windowStart)
      : undefined;
  const windowEnd = role === "fixed" ? derivedFixedWindowEndClock(windowStart, stayMinutes) : undefined;
  return {
    ...value,
    id: cleanText(value?.id, randomUUID(), 120),
    name: cleanText(value?.name, "未命名地点", 180),
    location: { lat, lng },
    role,
    isStart,
    isEnd,
    windowStart,
    windowEnd,
    stayMinutes
  };
}

function normalizeStoredPlan(value, idOverride) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const now = new Date().toISOString();
  const tripDate = validTripDate(value?.tripDate);
  const stops = Array.isArray(value?.stops)
    ? value.stops.map(normalizeStoredStop).filter(Boolean)
    : [];
  const routePlan =
    value?.routePlan && typeof value.routePlan === "object" && Array.isArray(value.routePlan.legs)
      ? value.routePlan
      : null;

  return {
    id: cleanText(idOverride || value?.id, randomUUID(), 120),
    name: cleanText(value?.name, `${tripDate} 一日规划`, 180),
    tripDate,
    startTime: typeof value?.startTime === "string" && /^\d{2}:\d{2}$/.test(value.startTime) ? value.startTime : "09:00",
    departureEndTime: cleanClock(value?.departureEndTime) || cleanClock(value?.startTime) || "09:00",
    departureStop: normalizeStoredStop(value?.departureStop),
    transitTimePreference: value?.transitTimePreference === "arrival" ? "arrival" : "departure",
    stops,
    routePlan,
    createdAt: validIsoDate(value?.createdAt, now),
    updatedAt: validIsoDate(value?.updatedAt, now)
  };
}

async function readPlansFromFile() {
  try {
    const content = await fs.promises.readFile(plansFilePath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.map((plan) => normalizeStoredPlan(plan)).filter(Boolean) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writePlansToFile(plans) {
  await fs.promises.mkdir(path.dirname(plansFilePath), { recursive: true });
  await fs.promises.writeFile(plansFilePath, JSON.stringify(plans, null, 2), "utf8");
}

async function listStoredPlans() {
  const sql = await ensurePlansTable();
  if (sql) {
    const rows = await sql`
      select data
      from daytrip_plans
      order by data->>'tripDate' asc, updated_at desc
    `;
    return rows.map((row) => normalizeStoredPlan(row.data)).filter(Boolean);
  }
  if (isVercel) {
    const error = new Error("DATABASE_URL is required for server-side plan persistence on Vercel.");
    error.status = 500;
    throw error;
  }
  return readPlansFromFile();
}

async function upsertStoredPlan(input, idOverride) {
  const plan = normalizeStoredPlan(input, idOverride);
  const sql = await ensurePlansTable();
  if (sql) {
    await sql`
      insert into daytrip_plans (id, data, created_at, updated_at)
      values (${plan.id}, ${JSON.stringify(plan)}::jsonb, ${plan.createdAt}::timestamptz, ${plan.updatedAt}::timestamptz)
      on conflict (id) do update
      set data = excluded.data,
          updated_at = excluded.updated_at
    `;
    return plan;
  }
  if (isVercel) {
    const error = new Error("DATABASE_URL is required for server-side plan persistence on Vercel.");
    error.status = 500;
    throw error;
  }
  const plans = await readPlansFromFile();
  const next = [plan, ...plans.filter((item) => item.id !== plan.id)];
  await writePlansToFile(next);
  return plan;
}

async function deleteStoredPlan(id) {
  const cleanId = cleanText(id, "", 120);
  if (!cleanId) return;
  const sql = await ensurePlansTable();
  if (sql) {
    await sql`delete from daytrip_plans where id = ${cleanId}`;
    return;
  }
  if (isVercel) {
    const error = new Error("DATABASE_URL is required for server-side plan persistence on Vercel.");
    error.status = 500;
    throw error;
  }
  const plans = await readPlansFromFile();
  await writePlansToFile(plans.filter((plan) => plan.id !== cleanId));
}

function asWaypoint(stop) {
  if (stop.placeId) {
    return { placeId: stop.placeId };
  }

  return {
    location: {
      latLng: {
        latitude: Number(stop.location.lat),
        longitude: Number(stop.location.lng)
      }
    }
  };
}

function asTransitousPlace(stop) {
  const lat = Number(stop?.location?.lat);
  const lng = Number(stop?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function asLatLngText(stop) {
  return `${Number(stop.location.lat).toFixed(6)},${Number(stop.location.lng).toFixed(6)}`;
}

function asNavitimeLatLng(stop) {
  return `${Number(stop.location.lat).toFixed(6)},${Number(stop.location.lng).toFixed(6)}`;
}

function toNavitimeDateTime(timeIso, localDateTime) {
  if (localDateTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(localDateTime)) {
    return localDateTime.length === 16 ? `${localDateTime}:00` : localDateTime.slice(0, 19);
  }

  const date = new Date(timeIso);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}`;
}

function parseLocalDateTimeParts(localDateTime) {
  if (typeof localDateTime !== "string") return null;
  const match = localDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second)
  };
  return Object.values(parts).every(Number.isFinite) ? parts : null;
}

function formatUtcPartsAsLocalDateTime(date) {
  return [
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
    `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`
  ].join("T");
}

function addMillisecondsToLocalDateTime(localDateTime, milliseconds) {
  if (!localDateTime || !Number.isFinite(milliseconds)) return "";
  const parts = parseLocalDateTimeParts(localDateTime);
  if (!parts) return "";
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + milliseconds
  );
  return formatUtcPartsAsLocalDateTime(shifted);
}

function dateFromTokyoLocalDateTime(localDateTime) {
  const parts = parseLocalDateTimeParts(localDateTime);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour - 9, parts.minute, parts.second));
}

function routeLocalDateFromAnchor(transitLocalDateTime, anchorTime) {
  const parts = parseLocalDateTimeParts(transitLocalDateTime);
  if (parts) {
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  const localDateTime = toNavitimeDateTime(anchorTime.toISOString());
  return localDateTime ? localDateTime.slice(0, 10) : "";
}

function fixedWindowStartDate(stop, routeLocalDate) {
  if (stop?.role !== "fixed" || !routeLocalDate) return null;
  const windowStart = cleanClock(stop?.windowStart);
  if (!windowStart) return null;
  return dateFromTokyoLocalDateTime(`${routeLocalDate}T${windowStart}:00`);
}

function departureDateAfterStopVisit(stop, arrivalDate, routeLocalDate) {
  const fixedStart = fixedWindowStartDate(stop, routeLocalDate);
  const visitStart =
    fixedStart && fixedStart.getTime() > arrivalDate.getTime()
      ? fixedStart
      : arrivalDate;
  const stayMinutes = Math.max(0, Number(stop?.stayMinutes) || 0);
  return new Date(visitStart.getTime() + stayMinutes * 60 * 1000);
}

function routeDateFromTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const date = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    ? new Date(trimmed)
    : dateFromTokyoLocalDateTime(trimmed);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function withDepartureTiming(leg, requestedStart) {
  const providerEnd = routeDateFromTime(leg?.endTime);
  const fallbackEnd = new Date(requestedStart.getTime() + Math.max(0, Number(leg?.durationSeconds) || 0) * 1000);
  const effectiveEnd = providerEnd && providerEnd.getTime() >= requestedStart.getTime() ? providerEnd : fallbackEnd;
  const durationSeconds = Math.max(0, Math.round((effectiveEnd.getTime() - requestedStart.getTime()) / 1000));
  return {
    ...leg,
    durationSeconds,
    startTime: requestedStart.toISOString(),
    endTime: effectiveEnd.toISOString()
  };
}

function withArrivalTiming(leg, requestedEnd) {
  const providerStart = routeDateFromTime(leg?.startTime);
  const fallbackStart = new Date(requestedEnd.getTime() - Math.max(0, Number(leg?.durationSeconds) || 0) * 1000);
  const effectiveStart = providerStart && providerStart.getTime() <= requestedEnd.getTime() ? providerStart : fallbackStart;
  const durationSeconds = Math.max(0, Math.round((requestedEnd.getTime() - effectiveStart.getTime()) / 1000));
  return {
    ...leg,
    durationSeconds,
    startTime: effectiveStart.toISOString(),
    endTime: requestedEnd.toISOString()
  };
}

function haversineMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRad(Number(b.location.lat) - Number(a.location.lat));
  const dLng = toRad(Number(b.location.lng) - Number(a.location.lng));
  const lat1 = toRad(Number(a.location.lat));
  const lat2 = toRad(Number(b.location.lat));
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function decodePolyline(points, precision = 5) {
  if (!points) return [];

  const coordinates = [];
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < points.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;

    do {
      byte = points.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < points.length);

    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;

    do {
      byte = points.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < points.length);

    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coordinates.push([lat / factor, lng / factor]);
  }

  return coordinates;
}

function appendCoordinates(target, coordinates) {
  if (!Array.isArray(coordinates) || !coordinates.length) return;
  const last = target[target.length - 1];
  const first = coordinates[0];
  if (last && first && Math.abs(last[0] - first[0]) < 0.000001 && Math.abs(last[1] - first[1]) < 0.000001) {
    target.push(...coordinates.slice(1));
    return;
  }
  target.push(...coordinates);
}

function isCoordinatePair(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function appendGeoJsonCoordinates(target, geometry) {
  if (!geometry) return;

  if (geometry.type === "FeatureCollection" && Array.isArray(geometry.features)) {
    for (const feature of geometry.features) appendGeoJsonCoordinates(target, feature);
    return;
  }

  if (geometry.type === "Feature") {
    appendGeoJsonCoordinates(target, geometry.geometry);
    return;
  }

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const item of geometry.geometries) appendGeoJsonCoordinates(target, item);
    return;
  }

  const collect = (coordinates) => {
    if (isCoordinatePair(coordinates)) {
      target.push([Number(coordinates[1]), Number(coordinates[0])]);
      return;
    }

    if (Array.isArray(coordinates)) {
      for (const item of coordinates) collect(item);
    }
  };

  collect(geometry.coordinates);
}

function summarizeTransitousLegs(legs) {
  const rideSummaries = legs
    .filter((leg) => leg.mode && leg.mode !== "WALK")
    .map((leg) => {
      const line = leg.routeShortName || leg.displayName || leg.routeLongName || leg.mode;
      return leg.headsign ? `${line} -> ${leg.headsign}` : line;
    })
    .filter(Boolean);

  if (rideSummaries.length) {
    return rideSummaries.join(" / ");
  }

  const walkSeconds = legs.reduce((sum, leg) => sum + (leg.mode === "WALK" ? Number(leg.duration) || 0 : 0), 0);
  return walkSeconds ? `步行 ${Math.round(walkSeconds / 60)} 分钟` : "公共交通";
}

function summarizeGoogleDirectionsSteps(steps, durationSeconds, fallbackReason) {
  const transitSummaries = steps
    .filter((step) => step.travel_mode === "TRANSIT")
    .map((step) => {
      const details = step.transit_details;
      const line = details?.line?.short_name || details?.line?.name || "公共交通";
      return details?.headsign ? `${line} -> ${details.headsign}` : line;
    })
    .filter(Boolean);

  if (transitSummaries.length) {
    return transitSummaries.join(" / ");
  }

  const walking = `步行 ${Math.max(1, Math.round(durationSeconds / 60))} 分钟`;
  return fallbackReason ? `${walking}（${fallbackReason}）` : walking;
}

function normalizeGoogleDirectionsRoute(route, fallbackReason = "") {
  const leg = route?.legs?.[0];
  const steps = Array.isArray(leg?.steps) ? leg.steps : [];
  const coordinates = decodePolyline(route?.overview_polyline?.points, 5);
  const durationSeconds = Number(leg?.duration?.value) || 0;
  const hasTransit = steps.some((step) => step.travel_mode === "TRANSIT");

  return {
    distanceMeters: Number(leg?.distance?.value) || 0,
    durationSeconds,
    coordinates,
    summary: summarizeGoogleDirectionsSteps(steps, durationSeconds, fallbackReason),
    mode: hasTransit ? "TRANSIT" : "WALK",
    fallbackReason,
    steps: steps.map((step) => ({
      mode: step.travel_mode,
      line: step.transit_details?.line?.short_name || step.transit_details?.line?.name || "",
      headsign: step.transit_details?.headsign || "",
      from: step.transit_details?.departure_stop?.name || "",
      to: step.transit_details?.arrival_stop?.name || "",
      durationSeconds: Number(step.duration?.value) || 0,
      distanceMeters: Number(step.distance?.value) || 0,
      instructions: step.html_instructions || ""
    }))
  };
}

function directWalkingEstimate(fromStop, toStop, fallbackReason = "步行服务无结果") {
  const distanceMeters = haversineMeters(fromStop, toStop);
  return {
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(distanceMeters / 1.25),
    coordinates: [
      [Number(fromStop.location.lat), Number(fromStop.location.lng)],
      [Number(toStop.location.lat), Number(toStop.location.lng)]
    ],
    summary: `步行 ${Math.max(1, Math.round(distanceMeters / 1.25 / 60))} 分钟（${fallbackReason}）`,
    mode: "WALK",
    fallbackReason,
    steps: []
  };
}

function withLegMetadata(leg, metadata) {
  const alternatives = Array.isArray(leg.alternatives)
    ? leg.alternatives.map((alternative) => ({
        ...alternative,
        ...metadata
      }))
    : undefined;
  return {
    ...leg,
    ...metadata,
    ...(alternatives ? { alternatives } : {})
  };
}

function compactRouteLeg(leg, includeAlternatives = false) {
  const output = {
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    coordinates: leg.coordinates,
    summary: leg.summary,
    mode: leg.mode,
    preferredMode: leg.preferredMode,
    fallbackReason: leg.fallbackReason,
    directDistanceMeters: leg.directDistanceMeters,
    transfers: leg.transfers,
    fare: leg.fare,
    steps: leg.steps,
    startTime: leg.startTime,
    endTime: leg.endTime,
    provider: leg.provider,
    alternativeIndex: leg.alternativeIndex,
    selectedAlternativeIndex: leg.selectedAlternativeIndex
  };
  if (includeAlternatives && Array.isArray(leg.alternatives) && leg.alternatives.length > 1) {
    output.alternatives = leg.alternatives.map((alternative) => compactRouteLeg(alternative, false));
  }
  return output;
}

async function requestGoogleDirectionsPair({
  apiKey,
  fromStop,
  toStop,
  mode,
  timeIso,
  transitTimePreference
}) {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", asLatLngText(fromStop));
  url.searchParams.set("destination", asLatLngText(toStop));
  url.searchParams.set("mode", mode === "TRANSIT" ? "transit" : "walking");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", apiKey);

  if (mode === "TRANSIT" && timeIso) {
    const timestampSeconds = Math.floor(new Date(timeIso).getTime() / 1000);
    if (Number.isFinite(timestampSeconds)) {
      url.searchParams.set(transitTimePreference === "arrival" ? "arrival_time" : "departure_time", String(timestampSeconds));
    }
  }

  const upstream = await fetch(url);
  const payload = await upstream.json();

  if (!upstream.ok || payload.status !== "OK") {
    const error = new Error(payload.error_message || payload.status || "Google Directions request failed.");
    error.status = upstream.ok ? 404 : upstream.status;
    error.googleStatus = payload.status;
    error.details = payload;
    throw error;
  }

  const route = payload.routes?.[0];
  if (!route) {
    const error = new Error("Google Directions did not return a route.");
    error.status = 404;
    error.details = payload;
    throw error;
  }

  return normalizeGoogleDirectionsRoute(route);
}

function normalizeTransitousItinerary(itinerary, fromStop, toStop) {
  const legs = Array.isArray(itinerary?.legs) ? itinerary.legs : [];
  const coordinates = [];
  let distanceMeters = 0;
  let durationSeconds = Number(itinerary?.duration) || 0;

  for (const leg of legs) {
    distanceMeters += Number(leg.distance) || 0;
    const geometry = leg.legGeometry || leg.polyline;
    const decoded = decodePolyline(geometry?.points, Number(geometry?.precision) || 5);
    if (decoded.length) {
      appendCoordinates(coordinates, decoded);
    } else if (leg.from?.lat && leg.from?.lon && leg.to?.lat && leg.to?.lon) {
      appendCoordinates(coordinates, [
        [Number(leg.from.lat), Number(leg.from.lon)],
        [Number(leg.to.lat), Number(leg.to.lon)]
      ]);
    }
  }

  if (!durationSeconds && legs.length) {
    durationSeconds = legs.reduce((sum, leg) => sum + (Number(leg.duration) || 0), 0);
  }

  if (!coordinates.length) {
    appendCoordinates(coordinates, [
      [Number(fromStop.location.lat), Number(fromStop.location.lng)],
      [Number(toStop.location.lat), Number(toStop.location.lng)]
    ]);
  }

  return {
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(durationSeconds),
    coordinates,
    summary: summarizeTransitousLegs(legs),
    startTime: itinerary?.startTime,
    endTime: itinerary?.endTime,
    transfers: Number(itinerary?.transfers) || 0,
    steps: legs.map((leg) => ({
      mode: leg.mode,
      line: leg.routeShortName || leg.displayName || leg.routeLongName || "",
      headsign: leg.headsign || "",
      from: leg.from?.name || "",
      to: leg.to?.name || "",
      startTime: leg.startTime,
      endTime: leg.endTime,
      durationSeconds: Math.round(Number(leg.duration) || 0)
    }))
  };
}

function isNavitimeWalkMove(section) {
  const move = String(section?.move || "").toLowerCase();
  const lineName = String(section?.line_name || "").toLowerCase();
  return move === "walk" || lineName === "徒歩" || lineName === "walk";
}

function summarizeNavitimeSections(sections, durationSeconds) {
  const lines = sections
    .filter((section) => !isNavitimeWalkMove(section))
    .map((section) => section.line_name || section.transport?.name || section.move)
    .filter(Boolean);

  const uniqueLines = [...new Set(lines)];
  if (uniqueLines.length) return uniqueLines.join(" / ");

  return `步行 ${Math.max(1, Math.round(durationSeconds / 60))} 分钟`;
}

function navitimePointName(point, fallback) {
  if (!point?.name || point.name === "start" || point.name === "goal") return fallback;
  return point.name;
}

function normalizeNavitimeRoute(route, fromStop, toStop) {
  const sections = Array.isArray(route?.sections) ? route.sections : [];
  const moveSegments = sections
    .map((section, index) => ({
      section,
      fromPoint: sections[index - 1],
      toPoint: sections[index + 1]
    }))
    .filter(({ section }) => section?.type === "move");
  const moveSections = moveSegments.map(({ section }) => section);
  const points = sections.filter((section) => section?.type === "point");
  const summaryMove = route?.summary?.move || {};
  const coordinates = [];

  appendGeoJsonCoordinates(coordinates, route?.shapes);
  if (!coordinates.length) {
    const pointCoordinates = points
      .map((point) => {
        const lat = Number(point?.coord?.lat);
        const lng = Number(point?.coord?.lon ?? point?.coord?.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
      })
      .filter(Boolean);
    appendCoordinates(coordinates, pointCoordinates);
  }
  if (!coordinates.length) {
    appendCoordinates(coordinates, [
      [Number(fromStop.location.lat), Number(fromStop.location.lng)],
      [Number(toStop.location.lat), Number(toStop.location.lng)]
    ]);
  }

  const sectionDistance = moveSections.reduce((sum, section) => sum + (Number(section.distance) || 0), 0);
  const sectionMinutes = moveSections.reduce((sum, section) => sum + (Number(section.time) || 0), 0);
  const durationSeconds = Math.round((Number(summaryMove.time) || sectionMinutes) * 60);
  const distanceMeters = Math.round(Number(summaryMove.distance) || sectionDistance);
  const hasTransit = moveSections.some((section) => !isNavitimeWalkMove(section));

  return {
    distanceMeters,
    durationSeconds,
    coordinates,
    summary: summarizeNavitimeSections(moveSections, durationSeconds),
    mode: hasTransit ? "TRANSIT" : "WALK",
    fallbackReason: "",
    startTime: summaryMove.from_time,
    endTime: summaryMove.to_time,
    transfers: Number(summaryMove.transit_count) || 0,
    fare: summaryMove.reference_fare?.lowest_total_ic || summaryMove.fare?.unit_48 || summaryMove.fare?.unit_0,
    provider: "navitime",
    steps: moveSegments.map(({ section, fromPoint, toPoint }) => {
      const link = section.transport?.links?.[0];
      return {
        mode: isNavitimeWalkMove(section) ? "WALK" : "TRANSIT",
        line: section.line_name || section.transport?.name || "",
        headsign: link?.destination?.name || "",
        from: link?.from?.name || navitimePointName(fromPoint, fromStop.name || "起点"),
        to: link?.to?.name || navitimePointName(toPoint, toStop.name || "终点"),
        startTime: section.from_time,
        endTime: section.to_time,
        durationSeconds: Math.round((Number(section.time) || 0) * 60),
        distanceMeters: Math.round(Number(section.distance) || 0)
      };
    })
  };
}

async function requestAnitabiLite(subjectId) {
  const upstream = await fetch(`https://api.anitabi.cn/bangumi/${subjectId}/lite`, {
    headers: {
      Accept: "application/json"
    }
  });
  const payload = await upstream.json().catch(() => ({}));

  if (upstream.status === 404) {
    return null;
  }

  if (!upstream.ok) {
    const error = new Error(payload?.message || "Anitabi API request failed.");
    error.status = upstream.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

function normalizeAnitabiSearchResult(subject, lite) {
  const id = Number(lite?.id || subject?.id);
  if (!Number.isFinite(id)) return null;

  const litePoints = Array.isArray(lite?.litePoints) ? lite.litePoints : [];
  const pointsLength = Number(lite?.pointsLength) || litePoints.length || 0;
  const imagesLength = Number(lite?.imagesLength) || litePoints.filter((point) => point?.image).length || 0;

  if (!pointsLength && !imagesLength) return null;

  return {
    id,
    cn: cleanText(lite?.cn || subject?.name_cn, "", 180),
    title: cleanText(lite?.title || subject?.name, `Bangumi ${id}`, 180),
    date: cleanText(subject?.date || subject?.air_date, "", 40),
    city: cleanText(lite?.city, "", 80),
    cover: cleanText(lite?.cover || subject?.images?.medium || subject?.image, "", 500),
    pointsLength,
    imagesLength,
    modified: Number(lite?.modified) || null,
    samplePoints: litePoints
      .slice(0, 3)
      .map((point) => cleanText(point?.cn || point?.name, "", 80))
      .filter(Boolean)
  };
}

async function requestNavitimePair({
  fromStop,
  toStop,
  timeIso,
  localDateTime,
  arriveBy
}) {
  if (!navitimeRapidApiKey) {
    const error = new Error("Missing NAVITIME_RAPIDAPI_KEY in .env");
    error.status = 500;
    throw error;
  }

  const navitimeTime = toNavitimeDateTime(timeIso, localDateTime);
  if (!navitimeTime) {
    const error = new Error("Invalid NAVITIME route date/time.");
    error.status = 400;
    throw error;
  }

  const url = new URL(`https://${navitimeRapidApiHost}/route_transit`);
  url.searchParams.set("start", asNavitimeLatLng(fromStop));
  url.searchParams.set("goal", asNavitimeLatLng(toStop));
  url.searchParams.set(arriveBy ? "goal_time" : "start_time", navitimeTime);
  url.searchParams.set("shape", "true");
  url.searchParams.set("datum", "wgs84");
  url.searchParams.set("coord_unit", "degree");
  url.searchParams.set("limit", "5");
  url.searchParams.set("term", "1440");
  url.searchParams.set("order", "time_optimized");

  await waitForNavitimeRateLimit();

  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-RapidAPI-Key": navitimeRapidApiKey,
      "X-RapidAPI-Host": navitimeRapidApiHost
    }
  });
  const payload = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      payload?.detail ||
      `NAVITIME route request failed with HTTP ${upstream.status}.`;
    const error = new Error(message);
    error.status = upstream.status;
    error.details = payload;
    throw error;
  }

  const routes = Array.isArray(payload?.items)
    ? payload.items.map((route, index) => ({
        ...normalizeNavitimeRoute(route, fromStop, toStop),
        alternativeIndex: index,
        selectedAlternativeIndex: index
      }))
    : [];
  if (!routes.length) {
    const error = new Error("NAVITIME did not return a public transport route.");
    error.status = 404;
    error.details = payload;
    throw error;
  }

  return {
    ...routes[0],
    selectedAlternativeIndex: 0,
    alternatives: routes
  };
}

async function requestTransitousPair(fromStop, toStop, timeIso, arriveBy) {
  const fromPlace = asTransitousPlace(fromStop);
  const toPlace = asTransitousPlace(toStop);
  if (!fromPlace || !toPlace) {
    const error = new Error("Invalid stop coordinates.");
    error.status = 400;
    throw error;
  }

  const url = new URL("https://api.transitous.org/api/v6/plan");
  url.searchParams.set("fromPlace", fromPlace);
  url.searchParams.set("toPlace", toPlace);
  url.searchParams.set("time", timeIso);
  url.searchParams.set("arriveBy", String(Boolean(arriveBy)));
  url.searchParams.set("searchWindow", "7200");
  url.searchParams.set("numItineraries", "3");
  url.searchParams.set("maxPreTransitTime", "1800");
  url.searchParams.set("maxPostTransitTime", "1800");
  url.searchParams.set("language", "zh");

  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": transitousUserAgent
    }
  });
  const payload = await upstream.json();

  if (!upstream.ok) {
    const error = new Error(payload?.error || payload?.message || "Transitous route request failed.");
    error.status = upstream.status;
    error.details = payload;
    throw error;
  }

  const itinerary = payload?.itineraries?.[0] || payload?.direct?.[0];
  if (!itinerary) {
    const error = new Error(
      `Transitous 没有找到「${fromStop.name || "起点"}」到「${toStop.name || "终点"}」的公共交通路线；这个地区可能没有开放时刻表覆盖。`
    );
    error.status = 404;
    error.details = payload;
    throw error;
  }

  return normalizeTransitousItinerary(itinerary, fromStop, toStop);
}

app.post("/api/routes", async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing GOOGLE_MAPS_SERVER_KEY in .env"
    });
  }

  const {
    stops,
    travelMode = "DRIVE",
    optimize = false,
    transitDateTime,
    transitTimePreference = "departure"
  } = req.body || {};
  if (!Array.isArray(stops) || stops.length < 2) {
    return res.status(400).json({ error: "At least two stops are required." });
  }

  if (stops.length > 27) {
    return res.status(400).json({
      error: "Routes API supports up to 25 intermediate waypoints, so a route can contain at most 27 stops."
    });
  }

  if (!travelModeAllowlist.has(travelMode)) {
    return res.status(400).json({ error: "Unsupported travel mode." });
  }

  const origin = asWaypoint(stops[0]);
  const destination = asWaypoint(stops[stops.length - 1]);
  const intermediates = stops.slice(1, -1).map(asWaypoint);
  const body = {
    origin,
    destination,
    intermediates,
    travelMode,
    languageCode: "zh-CN",
    units: "METRIC",
    optimizeWaypointOrder: Boolean(optimize && travelMode !== "TRANSIT"),
    polylineEncoding: "ENCODED_POLYLINE",
    polylineQuality: "HIGH_QUALITY"
  };

  if (travelMode === "DRIVE" || travelMode === "TWO_WHEELER") {
    body.routingPreference = "TRAFFIC_AWARE";
  }

  if (travelMode === "TRANSIT" && transitDateTime) {
    const transitTimestamp = new Date(transitDateTime);
    if (Number.isNaN(transitTimestamp.getTime())) {
      return res.status(400).json({ error: "Invalid transit date/time." });
    }

    if (transitTimePreference === "arrival") {
      body.arrivalTime = transitTimestamp.toISOString();
    } else {
      body.departureTime = transitTimestamp.toISOString();
    }
  }

  try {
    const upstream = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "routes.duration",
          "routes.distanceMeters",
          "routes.polyline.encodedPolyline",
          "routes.legs.duration",
          "routes.legs.distanceMeters",
          "routes.legs.polyline.encodedPolyline",
          "routes.optimizedIntermediateWaypointIndex"
        ].join(",")
      },
      body: JSON.stringify(body)
    });

    const payload = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: payload?.error?.message || "Google Routes API request failed.",
        details: payload
      });
    }

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown routing error."
    });
  }
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) {
    return res.status(400).json({ error: "Search query is too short." });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "6");
  url.searchParams.set("q", query);

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DaytripPlanner/0.1 local prototype"
      }
    });
    const payload = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: payload?.error || "Nominatim search failed.",
        details: payload
      });
    }

    return res.json(
      payload.map((item) => ({
        id: item.place_id,
        name: item.name || item.display_name?.split(",")[0] || "OpenStreetMap place",
        address: item.display_name,
        lat: Number(item.lat),
        lng: Number(item.lon),
        source: "nominatim"
      }))
    );
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown search error."
    });
  }
});

app.get("/api/plans", async (_req, res) => {
  try {
    const plans = await listStoredPlans();
    return res.json({ plans });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Failed to load plans."
    });
  }
});

app.post("/api/plans", async (req, res) => {
  try {
    const plan = await upsertStoredPlan(req.body?.plan || req.body || {});
    return res.status(201).json({ plan });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Failed to save plan."
    });
  }
});

app.put("/api/plans/:id", async (req, res) => {
  try {
    const plan = await upsertStoredPlan(req.body?.plan || req.body || {}, req.params.id);
    return res.json({ plan });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Failed to save plan."
    });
  }
});

app.delete("/api/plans", async (req, res) => {
  try {
    const id = String(req.query.id || req.body?.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Plan id is required." });
    }
    await deleteStoredPlan(id);
    return res.json({ ok: true });
  } catch (error) {
    console.error("[plans] delete failed", error);
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Failed to delete plan."
    });
  }
});

app.delete("/api/plans/:id", async (req, res) => {
  try {
    await deleteStoredPlan(req.params.id);
    return res.json({ ok: true });
  } catch (error) {
    console.error("[plans] delete failed", error);
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Failed to delete plan."
    });
  }
});

app.post("/api/auto-route", async (req, res) => {
  const {
    stops,
    transitDateTime,
    transitLocalDateTime,
    transitTimePreference = "departure"
  } = req.body || {};

  if (!Array.isArray(stops) || stops.length < 2) {
    return res.status(400).json({ error: "At least two stops are required." });
  }

  const anchorTime = dateFromTokyoLocalDateTime(transitLocalDateTime) || new Date(transitDateTime);
  if (Number.isNaN(anchorTime.getTime())) {
    return res.status(400).json({ error: "Invalid route date/time." });
  }

  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY;
  const useGoogle = Boolean(apiKey);
  const useNavitime = Boolean(navitimeRapidApiKey);
  let usedNavitime = false;

  async function requestAutoPair(fromStop, toStop, cursor, arriveBy) {
    const directDistanceMeters = haversineMeters(fromStop, toStop);
    const preferTransit = directDistanceMeters > autoTransitThresholdMeters;

    if (useNavitime && preferTransit) {
      try {
        const localDateTime =
          transitLocalDateTime &&
          addMillisecondsToLocalDateTime(
            transitLocalDateTime,
            cursor.getTime() - anchorTime.getTime()
          );
        const transitLeg = await requestNavitimePair({
          fromStop,
          toStop,
          timeIso: cursor.toISOString(),
          localDateTime,
          arriveBy
        });

        if (transitLeg.mode === "TRANSIT") {
          usedNavitime = true;
          return withLegMetadata(transitLeg, {
            preferredMode: "TRANSIT",
            directDistanceMeters: Math.round(directDistanceMeters)
          });
        }
      } catch (error) {
        // NAVITIME may still fail for missing coverage, quota, or an unconfigured RapidAPI key.
        // In that case the prototype keeps the trip usable through the existing fallbacks.
      }
    }

    if (useGoogle && preferTransit) {
      try {
        const transitLeg = await requestGoogleDirectionsPair({
          apiKey,
          fromStop,
          toStop,
          mode: "TRANSIT",
          timeIso: cursor.toISOString(),
          transitTimePreference: arriveBy ? "arrival" : "departure"
        });

        if (transitLeg.mode === "TRANSIT") {
          return withLegMetadata(transitLeg, {
            preferredMode: "TRANSIT",
            directDistanceMeters: Math.round(directDistanceMeters)
          });
        }
      } catch (error) {
        const fallbackReason =
          error.googleStatus === "ZERO_RESULTS" ? "公共交通无结果" : "公共交通暂不可用";
        try {
          const walkingLeg = await requestGoogleDirectionsPair({
            apiKey,
            fromStop,
            toStop,
            mode: "WALK"
          });
          return {
            ...walkingLeg,
            summary: `${walkingLeg.summary}（${fallbackReason}）`,
            preferredMode: "TRANSIT",
            fallbackReason,
            directDistanceMeters: Math.round(directDistanceMeters)
          };
        } catch {
          return {
            ...directWalkingEstimate(fromStop, toStop, fallbackReason),
            preferredMode: "TRANSIT",
            directDistanceMeters: Math.round(directDistanceMeters)
          };
          }
        }
      }

    if (useGoogle) {
      try {
        const walkingLeg = await requestGoogleDirectionsPair({
          apiKey,
          fromStop,
          toStop,
          mode: "WALK"
        });
        return {
          ...walkingLeg,
          preferredMode: preferTransit ? "TRANSIT" : "WALK",
          directDistanceMeters: Math.round(directDistanceMeters)
        };
      } catch {
        return {
          ...directWalkingEstimate(fromStop, toStop),
          preferredMode: preferTransit ? "TRANSIT" : "WALK",
          directDistanceMeters: Math.round(directDistanceMeters)
        };
      }
    }

    if (preferTransit) {
      try {
        const transitLeg = await requestTransitousPair(fromStop, toStop, cursor.toISOString(), arriveBy);
        return {
          ...transitLeg,
          mode: "TRANSIT",
          preferredMode: "TRANSIT",
          directDistanceMeters: Math.round(directDistanceMeters)
        };
      } catch {
        return {
          ...directWalkingEstimate(fromStop, toStop, "公共交通无结果"),
          preferredMode: "TRANSIT",
          directDistanceMeters: Math.round(directDistanceMeters)
        };
      }
    }

    return {
      ...directWalkingEstimate(fromStop, toStop),
      preferredMode: "WALK",
      directDistanceMeters: Math.round(directDistanceMeters)
    };
  }

  try {
    const arriveBy = transitTimePreference === "arrival";
    const routeLegs = new Array(stops.length - 1);
    const routeLocalDate = routeLocalDateFromAnchor(transitLocalDateTime, anchorTime);

    if (arriveBy) {
      let cursor = anchorTime;
      for (let index = stops.length - 2; index >= 0; index -= 1) {
        const leg = withArrivalTiming(await requestAutoPair(stops[index], stops[index + 1], cursor, true), cursor);
        const startTime = new Date(leg.startTime);
        routeLegs[index] = leg;
        const stayMinutes = Number(stops[index]?.stayMinutes) || 0;
        cursor = new Date(startTime.getTime() - stayMinutes * 60 * 1000);
      }
    } else {
      let cursor = anchorTime;
      for (let index = 0; index < stops.length - 1; index += 1) {
        const leg = withDepartureTiming(await requestAutoPair(stops[index], stops[index + 1], cursor, false), cursor);
        const endTime = new Date(leg.endTime);
        routeLegs[index] = leg;
        cursor = departureDateAfterStopVisit(stops[index + 1], endTime, routeLocalDate);
      }
    }

    const coordinates = [];
    for (const leg of routeLegs) {
      appendCoordinates(coordinates, leg.coordinates);
    }

    const distanceMeters = routeLegs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0);
    const durationSeconds = routeLegs.reduce((sum, leg) => sum + (leg.durationSeconds || 0), 0);
    const transitLegs = routeLegs.filter((leg) => leg.mode === "TRANSIT").length;
    const fallbackWalkingLegs = routeLegs.filter((leg) => leg.preferredMode === "TRANSIT" && leg.mode === "WALK").length;

    return res.json({
      routes: [
        {
          distanceMeters,
          durationSeconds,
          coordinates,
          legs: routeLegs.map((leg) => compactRouteLeg(leg, true)),
          provider: usedNavitime ? "navitime-auto" : useGoogle ? "google-auto" : "free-auto",
          strategy: {
            transitThresholdMeters: autoTransitThresholdMeters,
            transitLegs,
            fallbackWalkingLegs
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Unknown auto routing error.",
      details: error.details
    });
  }
});

app.post("/api/transitous-route", async (req, res) => {
  const {
    stops,
    travelMode = "TRANSIT",
    transitDateTime,
    transitTimePreference = "departure"
  } = req.body || {};

  if (travelMode !== "TRANSIT") {
    return res.status(400).json({ error: "Transitous is only used for transit routing." });
  }

  if (!Array.isArray(stops) || stops.length < 2) {
    return res.status(400).json({ error: "At least two stops are required." });
  }

  if (stops.length > 12) {
    return res.status(400).json({ error: "Transitous routing is limited to 12 stops in this prototype." });
  }

  const anchorTime = new Date(transitDateTime);
  if (Number.isNaN(anchorTime.getTime())) {
    return res.status(400).json({ error: "Invalid transit date/time." });
  }

  try {
    const arriveBy = transitTimePreference === "arrival";
    const routeLegs = new Array(stops.length - 1);

    if (arriveBy) {
      let cursor = anchorTime;
      for (let index = stops.length - 2; index >= 0; index -= 1) {
        const leg = await requestTransitousPair(stops[index], stops[index + 1], cursor.toISOString(), true);
        routeLegs[index] = leg;
        const startTime = leg.startTime ? new Date(leg.startTime) : new Date(cursor.getTime() - leg.durationSeconds * 1000);
        const stayMinutes = Number(stops[index]?.stayMinutes) || 0;
        cursor = new Date(startTime.getTime() - stayMinutes * 60 * 1000);
      }
    } else {
      const firstStayMinutes = Number(stops[0]?.stayMinutes) || 0;
      let cursor = new Date(anchorTime.getTime() + firstStayMinutes * 60 * 1000);
      for (let index = 0; index < stops.length - 1; index += 1) {
        const leg = await requestTransitousPair(stops[index], stops[index + 1], cursor.toISOString(), false);
        routeLegs[index] = leg;
        const endTime = leg.endTime ? new Date(leg.endTime) : new Date(cursor.getTime() + leg.durationSeconds * 1000);
        const nextStayMinutes = Number(stops[index + 1]?.stayMinutes) || 0;
        cursor = new Date(endTime.getTime() + nextStayMinutes * 60 * 1000);
      }
    }

    const coordinates = [];
    for (const leg of routeLegs) {
      appendCoordinates(coordinates, leg.coordinates);
    }

    const distanceMeters = routeLegs.reduce((sum, leg) => sum + (leg.distanceMeters || 0), 0);
    const durationSeconds = routeLegs.reduce((sum, leg) => sum + (leg.durationSeconds || 0), 0);

    return res.json({
      routes: [
        {
          distanceMeters,
          durationSeconds,
          coordinates,
          legs: routeLegs.map((leg) => ({
            distanceMeters: leg.distanceMeters,
            durationSeconds: leg.durationSeconds,
            coordinates: leg.coordinates,
            summary: leg.summary,
            steps: leg.steps,
            startTime: leg.startTime,
            endTime: leg.endTime,
            transfers: leg.transfers
          })),
          provider: "transitous-motis",
          attribution: "Transitous / MOTIS, OpenStreetMap contributors and public GTFS feeds"
        }
      ]
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Unknown Transitous routing error.",
      details: error.details
    });
  }
});

app.post("/api/free-route", async (req, res) => {
  const { stops, travelMode = "DRIVE" } = req.body || {};
  if (!Array.isArray(stops) || stops.length < 2) {
    return res.status(400).json({ error: "At least two stops are required." });
  }

  if (stops.length > 25) {
    return res.status(400).json({ error: "The free OSRM demo route is limited to 25 stops in this prototype." });
  }

  if (travelMode === "TRANSIT") {
    return res.status(400).json({ error: "Transit routing is not available in free mode." });
  }

  const profile = osrmProfiles[travelMode] || "driving";
  const coordinates = stops
    .map((stop) => `${Number(stop.location.lng).toFixed(6)},${Number(stop.location.lat).toFixed(6)}`)
    .join(";");

  async function requestOsrm(activeProfile) {
    const url = new URL(`https://router.project-osrm.org/route/v1/${activeProfile}/${coordinates}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    url.searchParams.set("annotations", "false");
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DaytripPlanner/0.1 local prototype"
      }
    });
    return {
      ok: upstream.ok,
      status: upstream.status,
      payload: await upstream.json()
    };
  }

  try {
    let result = await requestOsrm(profile);
    if (!result.ok && profile !== "driving") {
      result = await requestOsrm("driving");
    }

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.payload?.message || "OSRM route request failed.",
        details: result.payload
      });
    }

    const route = result.payload?.routes?.[0];
    if (!route) {
      return res.status(404).json({ error: "OSRM did not return a route." });
    }

    return res.json({
      routes: [
        {
          distanceMeters: route.distance || 0,
          durationSeconds: Math.round(route.duration || 0),
          coordinates: route.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || [],
          legs: (route.legs || []).map((leg) => ({
            distanceMeters: leg.distance || 0,
            durationSeconds: Math.round(leg.duration || 0)
          })),
          provider: "osrm-demo"
        }
      ]
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown free routing error."
    });
  }
});

app.get("/api/anitabi/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!/^\d+$/.test(query) && query.length < 2) {
    return res.status(400).json({ error: "Search query is too short." });
  }

  try {
    if (/^\d+$/.test(query)) {
      const lite = await requestAnitabiLite(query);
      const result = lite
        ? normalizeAnitabiSearchResult(
            { id: Number(query), name: lite.title, name_cn: lite.cn },
            lite
          )
        : null;
      return res.json({ results: result ? [result] : [] });
    }

    const upstream = await fetch("https://api.bgm.tv/v0/search/subjects?limit=12&offset=0", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": bangumiUserAgent
      },
      body: JSON.stringify({
        keyword: query,
        filter: {
          type: [2]
        }
      })
    });
    const payload = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: payload?.description || payload?.message || "Bangumi search request failed.",
        details: payload
      });
    }

    const subjects = Array.isArray(payload?.data) ? payload.data : [];
    const checked = await Promise.allSettled(
      subjects.map(async (subject) => {
        const lite = await requestAnitabiLite(subject.id);
        return lite ? normalizeAnitabiSearchResult(subject, lite) : null;
      })
    );

    const results = checked
      .filter((item) => item.status === "fulfilled" && item.value)
      .map((item) => item.value)
      .slice(0, 8);

    return res.json({ results });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error instanceof Error ? error.message : "Unknown Anitabi search error.",
      details: error.details
    });
  }
});

app.get("/api/anitabi/bangumi/:subjectId/lite", async (req, res) => {
  const subjectId = String(req.params.subjectId || "").trim();
  if (!/^\d+$/.test(subjectId)) {
    return res.status(400).json({ error: "Bangumi subject ID must be numeric." });
  }

  try {
    const upstream = await fetch(`https://api.anitabi.cn/bangumi/${subjectId}/lite`, {
      headers: {
        Accept: "application/json"
      }
    });
    const payload = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: payload?.message || "Anitabi API request failed.",
        details: payload
      });
    }

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown Anitabi import error."
    });
  }
});

async function sendAnitabiDetailResponse(subjectIdInput, res) {
  const subjectId = String(subjectIdInput || "").trim();
  if (!/^\d+$/.test(subjectId)) {
    return res.status(400).json({ error: "Bangumi subject ID must be numeric." });
  }

  try {
    const detailUrl = new URL(`https://api.anitabi.cn/bangumi/${subjectId}/points/detail`);
    detailUrl.searchParams.set("haveImage", "true");

    const [liteResponse, detailResponse] = await Promise.all([
      fetch(`https://api.anitabi.cn/bangumi/${subjectId}/lite`, {
        headers: { Accept: "application/json" }
      }),
      fetch(detailUrl, {
        headers: { Accept: "application/json" }
      })
    ]);

    const litePayload = await liteResponse.json().catch(() => ({}));
    const detailPayload = await detailResponse.json().catch(() => []);

    if (!detailResponse.ok) {
      return res.status(detailResponse.status).json({
        error: detailPayload?.message || "Anitabi detail API request failed.",
        details: detailPayload
      });
    }

    const points = Array.isArray(detailPayload) ? detailPayload : [];
    return res.json({
      subject: liteResponse.ok ? litePayload : { id: Number(subjectId) },
      points,
      count: points.length
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown Anitabi detail import error."
    });
  }
}

app.get("/api/anitabi/detail", async (req, res) => {
  return sendAnitabiDetailResponse(req.query.subjectId || req.query.id, res);
});

app.get("/api/anitabi/bangumi/:subjectId/detail", async (req, res) => {
  return sendAnitabiDetailResponse(req.params.subjectId, res);
});

if (!isVercel) {
  const server = createHttpServer(app);

  if (isProduction) {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.use("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }

  server.listen(port, () => {
    const mode = isProduction ? "production" : "development";
    const envPath = path.join(__dirname, ".env");
    const envHint = fs.existsSync(envPath) ? "" : " - copy .env.example to .env to enable Google services";
    console.log(`Daytrip Planner ${mode} server running at http://localhost:${port}${envHint}`);
  });

  // Long day plans can wait on NAVITIME throttling for several minutes.
  server.setTimeout(0);
  server.requestTimeout = 0;
}

export default app;
