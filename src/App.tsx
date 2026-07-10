import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Footprints,
  GripVertical,
  Image as ImageIcon,
  Layers3,
  LocateFixed,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  TrainFront,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, Fragment, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  deletePlan as deletePlanFromServer,
  fetchPlans,
  importAnitabiSubject,
  requestAutoRoute,
  savePlan as savePlanToServer,
  searchAnitabiWorks,
  searchPlaces
} from "./api/client";
import { parseCoordinateInput, stopFromSearchResult, stopsFromKml } from "./domain/importers";
import {
  buildAutoRouteRequest,
  buildSchedule,
  normalizeRoutePlan,
  optimizeDayOrder,
  repairOrderWithActualLegs,
  activeRouteAlternativeIndex,
  routeAlternativeOptions,
  selectRouteAlternative as selectRouteAlternativeInPlan,
  scheduleWarnings
} from "./domain/planner";
import {
  createDayPlan,
  createStop,
  defaultDayPlans,
  formatPlanDate,
  isEndStop,
  isFixedStop,
  isPilgrimageStop,
  isStartStop,
  normalizeDayPlan,
  patchStopKind,
  stopKind,
  stopKindLabel,
  stopVisitMinutes
} from "./domain/stops";
import {
  formatClock,
  formatDistance,
  formatDuration,
  formatMoney,
  formatRouteClock,
  isDateInputValue,
  normalizeClockValue,
  normalizeStayMinutes,
  todayInputValue
} from "./domain/time";
import type { AnitabiSearchResult, DayPlan, RouteLeg, RouteStep, SearchResult, Stop } from "./domain/types";
import { createMapController, type MapController, type MapProvider } from "./map/mapController";

const planCacheStorageKey = "daytrip-planner.plans.v2";
const activePlanStorageKey = "daytrip-planner.active-plan-id.v2";
const maxRouteRepairAttempts = 10;

type SaveState = "loading" | "idle" | "saving" | "saved" | "local" | "error";
type StopKind = "start" | "normal" | "pilgrimage" | "fixed" | "end";
type SelectionRect = { left: number; top: number; width: number; height: number };
type DragRect = { startX: number; startY: number; endX: number; endY: number };

function loadLocalPlans() {
  if (typeof window === "undefined") return defaultDayPlans();
  try {
    const stored = window.localStorage.getItem(planCacheStorageKey);
    if (!stored) return defaultDayPlans();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return defaultDayPlans();
    const normalized = parsed.map(normalizeDayPlan).filter(Boolean) as DayPlan[];
    return normalized.length ? normalized : defaultDayPlans();
  } catch {
    return defaultDayPlans();
  }
}

function readActivePlanId() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(activePlanStorageKey);
  } catch {
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
  } catch {
    // Session storage is only a convenience.
  }
}

function persistLocalPlans(plans: DayPlan[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(planCacheStorageKey, JSON.stringify(plans));
  } catch {
    // Local cache failure should not block the planner.
  }
}

function makeStopFromCoordinate(value: string) {
  const location = parseCoordinateInput(value);
  if (!location) return null;
  return createStop({
    name: "自定义地点",
    address: `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`,
    location,
    source: "coordinate",
    stayMinutes: 5
  });
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "daytrip-plan";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const textarea = document.createElement("textarea");
  textarea.innerHTML = normalized;
  return textarea.value;
}

function isWalkingStep(step: RouteStep) {
  const mode = String(step.mode || "").toUpperCase();
  return mode.includes("WALK") || step.line === "徒歩";
}

function routeStepTitle(step: RouteStep) {
  if (isWalkingStep(step)) return `步行 ${formatDuration(step.durationSeconds)}`;
  const line = step.line || "公共交通";
  return step.headsign ? `乘坐 ${line}，往 ${step.headsign}` : `乘坐 ${line}`;
}

function routeStepMeta(step: RouteStep) {
  const time = [formatRouteClock(step.startTime), formatRouteClock(step.endTime)].filter(Boolean).join(" - ");
  const distance = step.distanceMeters ? formatDistance(step.distanceMeters) : "";
  return [time, distance].filter(Boolean).join(" / ");
}

function routeStepStations(step: RouteStep) {
  if (step.from && step.to) return `${step.from} → ${step.to}`;
  return step.from || step.to || "";
}

function routeProviderLabel(provider?: string) {
  if (!provider) return "估算路线";
  if (provider.includes("navitime")) return "NAVITIME 公共交通";
  if (provider.includes("google")) return "Google 路线";
  if (provider.includes("transitous")) return "Transitous";
  if (provider.includes("free")) return "免费兜底";
  if (provider.includes("estimated")) return "估算路线";
  return provider;
}

function mapProviderLabel(provider: MapProvider | "loading") {
  if (provider === "google") return "Google Maps";
  if (provider === "osm") return "OpenStreetMap 兜底";
  return "地图加载中";
}

function stopMarkerClass(stop: Stop, selected: boolean) {
  const classes = ["stop-marker", `is-${stopKind(stop)}`];
  if (selected) classes.push("is-selected");
  if (stop.imageUrl || stop.thumbnailUrl) classes.push("has-preview");
  return classes.join(" ");
}

function markerHtml(stop: Stop, index: number, selected: boolean) {
  const label = isStartStop(stop) ? "起" : isEndStop(stop) ? "终" : String(index + 1);
  return `<div class="${stopMarkerClass(stop, selected)}">${escapeHtml(label)}</div>`;
}

function anitabiPreviewHtml(stop: Stop) {
  const image = stop.thumbnailUrl || stop.imageUrl;
  if (!image) return "";
  const meta = [stop.workTitle, stop.episode ? `第 ${stop.episode} 话` : ""].filter(Boolean).join(" / ");
  return `
    <div class="anitabi-preview-card">
      <img src="${escapeHtml(image)}" alt="" />
      <div class="anitabi-preview-copy">
        <strong>${escapeHtml(stop.name)}</strong>
        ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
        <small>点击左侧“查看图片”可打开大图</small>
      </div>
    </div>
  `;
}

function planStats(plan: DayPlan) {
  const route = plan.routePlan;
  const stops = plan.stops.length;
  return {
    stops,
    distance: route?.distanceMeters || 0,
    duration: route?.durationSeconds || 0
  };
}

function firstRouteCoordinate(plan: DayPlan) {
  const routeCoordinate = plan.routePlan?.coordinates?.[0];
  if (routeCoordinate) return routeCoordinate;
  const stop = plan.stops[0];
  return stop ? [stop.location.lat, stop.location.lng] : null;
}

function mapFitPointsForPlan(plan: DayPlan) {
  const coordinates = plan.routePlan?.coordinates;
  if (coordinates && coordinates.length > 1) {
    return coordinates.map(([lat, lng]) => ({ lat, lng }));
  }
  return plan.stops.map((stop) => stop.location);
}

function mapFitKeyForPlan(plan: DayPlan) {
  const points = mapFitPointsForPlan(plan);
  const first = points[0];
  const last = points[points.length - 1];
  return [
    plan.id,
    plan.routePlan?.coordinates?.length || 0,
    plan.stops.length,
    first ? `${first.lat.toFixed(5)},${first.lng.toFixed(5)}` : "empty",
    last ? `${last.lat.toFixed(5)},${last.lng.toFixed(5)}` : "empty"
  ].join(":");
}

export default function App() {
  const [plans, setPlans] = useState<DayPlan[]>(loadLocalPlans);
  const [activePlanId, setActivePlanId] = useState<string | null>(readActivePlanId);
  const [newPlanDate, setNewPlanDate] = useState(todayInputValue());
  const [newPlanName, setNewPlanName] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [toast, setToast] = useState("");
  const [routeStalePlanIds, setRouteStalePlanIds] = useState<Set<string>>(() => new Set());
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedStopIds, setSelectedStopIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [newStopKind, setNewStopKind] = useState<StopKind>("normal");
  const [anitabiQuery, setAnitabiQuery] = useState("");
  const [anitabiResults, setAnitabiResults] = useState<AnitabiSearchResult[]>([]);
  const [searchingAnitabi, setSearchingAnitabi] = useState(false);
  const [importingAnitabi, setImportingAnitabi] = useState(false);
  const [routing, setRouting] = useState(false);
  const [routingStatus, setRoutingStatus] = useState("");
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [imageStop, setImageStop] = useState<Stop | null>(null);
  const [dragStopId, setDragStopId] = useState<string | null>(null);
  const [fitRouteToken, setFitRouteToken] = useState(0);
  const [mapProvider, setMapProvider] = useState<MapProvider | "loading">("loading");

  const loadedFromServer = useRef(false);
  const dirtyPlanIds = useRef(new Set<string>());
  const saveTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapController | null>(null);
  const lastAutoFitKey = useRef<string | null>(null);

  const activePlan = useMemo(
    () => plans.find((plan) => plan.id === activePlanId) || null,
    [activePlanId, plans]
  );

  const plannerOptions = useMemo(
    () => ({
      tripDate: activePlan?.tripDate || todayInputValue(),
      startTime: activePlan?.startTime || "09:00"
    }),
    [activePlan?.startTime, activePlan?.tripDate]
  );

  const routeLegsForSchedule = useMemo(() => {
    if (!activePlan?.routePlan) return [];
    return activePlan.routePlan.legs.length === Math.max(0, activePlan.stops.length - 1)
      ? activePlan.routePlan.legs
      : [];
  }, [activePlan?.routePlan, activePlan?.stops.length]);

  const schedule = useMemo(
    () => (activePlan ? buildSchedule(activePlan.stops, plannerOptions, routeLegsForSchedule) : []),
    [activePlan, plannerOptions, routeLegsForSchedule]
  );

  const routeStale = activePlan ? routeStalePlanIds.has(activePlan.id) : false;
  const selectedStopSet = useMemo(() => new Set(selectedStopIds), [selectedStopIds]);
  const activePlanMapFitKey = useMemo(() => (activePlan ? mapFitKeyForPlan(activePlan) : ""), [activePlan]);

  useEffect(() => {
    let cancelled = false;
    setSaveState("loading");
    fetchPlans()
      .then((serverPlans) => {
        if (cancelled) return;
        if (serverPlans.length > 0) {
          setPlans(serverPlans);
          setActivePlanId((current) => current && serverPlans.some((plan) => plan.id === current) ? current : serverPlans[0].id);
        }
        setSaveState("saved");
        loadedFromServer.current = true;
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(error);
        setSaveState("local");
        loadedFromServer.current = true;
        showToast("服务端暂时不可用，当前使用本地缓存。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    persistLocalPlans(plans);
  }, [plans]);

  useEffect(() => {
    storeActivePlanId(activePlanId);
  }, [activePlanId]);

  useEffect(() => {
    if (!loadedFromServer.current || !activePlanId) return;
    if (!dirtyPlanIds.current.has(activePlanId)) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const plan = plans.find((item) => item.id === activePlanId);
      if (!plan) return;
      setSaveState("saving");
      savePlanToServer(plan)
        .then((savedPlan) => {
          dirtyPlanIds.current.delete(plan.id);
          setPlans((current) => current.map((item) => (item.id === savedPlan.id ? savedPlan : item)));
          setSaveState("saved");
        })
        .catch((error) => {
          console.warn(error);
          setSaveState("local");
          showToast(error instanceof Error ? error.message : "保存失败，已保留在本地缓存。");
        });
    }, 650);
  }, [activePlanId, plans]);

  useEffect(() => {
    const node = mapNodeRef.current;
    if (!node || mapRef.current) return;
    let cancelled = false;
    setMapProvider("loading");
    void createMapController(node).then((controller) => {
      if (cancelled) {
        controller.dispose();
        return;
      }
      mapRef.current = controller;
      setMapProvider(controller.provider);
    });
    return () => {
      cancelled = true;
      mapRef.current?.dispose();
      mapRef.current = null;
      setMapProvider("loading");
    };
  }, [activePlanId]);

  useEffect(() => {
    const controller = mapRef.current;
    if (!controller || !activePlan) return;
    controller.setMarkers(activePlan.stops, selectedStopId, selectedStopSet, selectStop);
  }, [activePlan, selectedStopId, selectedStopSet, mapProvider]);

  useEffect(() => {
    const controller = mapRef.current;
    if (!controller || !activePlan) return;
    controller.setRoute(activePlan.routePlan?.coordinates, routeStale);
  }, [activePlan, routeStale, mapProvider]);

  useEffect(() => {
    const controller = mapRef.current;
    if (!controller || !activePlan || mapProvider === "loading" || !activePlanMapFitKey) return;
    if (lastAutoFitKey.current === activePlanMapFitKey) return;

    const points = mapFitPointsForPlan(activePlan);
    if (!points.length) return;
    lastAutoFitKey.current = activePlanMapFitKey;
    window.requestAnimationFrame(() => {
      if (mapRef.current === controller) {
        controller.fitTo(points);
      }
    });
  }, [activePlan, activePlanMapFitKey, mapProvider]);

  useEffect(() => {
    const controller = mapRef.current;
    if (!controller || !activePlan || fitRouteToken === 0) return;
    const coordinates = activePlan.routePlan?.coordinates;
    if (coordinates && coordinates.length > 1) {
      controller.fitTo(coordinates.map(([lat, lng]) => ({ lat, lng })));
      return;
    }
    controller.fitTo(activePlan.stops.map((stop) => stop.location));
  }, [activePlan, fitRouteToken, mapProvider]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3600);
  }

  function commitPlan(id: string, producer: (plan: DayPlan) => DayPlan, options: { staleRoute?: boolean } = {}) {
    setPlans((current) =>
      current.map((plan) => {
        if (plan.id !== id) return plan;
        const next = producer(plan);
        return { ...next, updatedAt: new Date().toISOString() };
      })
    );
    dirtyPlanIds.current.add(id);
    if (options.staleRoute !== false) {
      setRouteStalePlanIds((current) => new Set(current).add(id));
    }
  }

  function commitActivePlan(producer: (plan: DayPlan) => DayPlan, options?: { staleRoute?: boolean }) {
    if (!activePlanId) return;
    commitPlan(activePlanId, producer, options);
  }

  function createPlan() {
    const tripDate = isDateInputValue(newPlanDate) ? newPlanDate : todayInputValue();
    const plan = createDayPlan({
      tripDate,
      name: newPlanName.trim() || undefined
    });
    setPlans((current) => [plan, ...current]);
    dirtyPlanIds.current.add(plan.id);
    setActivePlanId(plan.id);
    setNewPlanName("");
    showToast("已创建一日规划。");
  }

  async function removePlan(id: string) {
    const previous = plans;
    setPlans((current) => current.filter((plan) => plan.id !== id));
    setActivePlanId((current) => (current === id ? null : current));
    try {
      await deletePlanFromServer(id);
      showToast("规划已删除。");
    } catch (error) {
      setPlans(previous);
      showToast(error instanceof Error ? error.message : "删除失败。");
    }
  }

  function addStops(newStops: Stop[]) {
    if (!activePlan || newStops.length === 0) return;
    commitActivePlan((plan) => ({
      ...plan,
      stops: [...plan.stops, ...newStops]
    }));
    showToast(newStops.length === 1 ? "地点已添加。" : `已添加 ${newStops.length} 个地点。`);
  }

  function addStopFromMapClick() {
    const map = mapRef.current;
    if (!map) return;
    const center = map.getCenter();
    addStops([
      createStop({
        name: "地图中心地点",
        address: `${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}`,
        location: { lat: center.lat, lng: center.lng },
        role: newStopKind === "start" ? "normal" : newStopKind,
        isStart: newStopKind === "start",
        isEnd: newStopKind === "end",
        windowStart: newStopKind === "start" ? "09:00" : newStopKind === "fixed" ? "12:00" : undefined,
        stayMinutes: newStopKind === "end" ? 0 : 5,
        source: "manual"
      })
    ]);
  }

  async function handleSearch() {
    const coordinateStop = makeStopFromCoordinate(searchText);
    if (coordinateStop) {
      addStops([coordinateStop]);
      setSearchText("");
      setSearchResults([]);
      return;
    }

    if (searchText.trim().length < 2) {
      showToast("请输入地点名、坐标或 Google Maps 链接。");
      return;
    }

    setSearching(true);
    try {
      const results = await searchPlaces(searchText.trim());
      setSearchResults(results);
      if (!results.length) showToast("没有找到候选地点。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "地点搜索失败。");
    } finally {
      setSearching(false);
    }
  }

  function addSearchResult(result: SearchResult, kind: StopKind = newStopKind) {
    const role = kind === "end" ? "end" : "normal";
    const stop = stopFromSearchResult(result, role);
    addStops([
      patchStopKind(
        {
          ...stop,
          stayMinutes: kind === "end" ? 0 : 5
        },
        kind
      )
    ]);
    setSearchText("");
    setSearchResults([]);
  }

  async function handleAnitabiSearch() {
    if (!anitabiQuery.trim()) {
      showToast("请输入作品名或 Bangumi subjectId。");
      return;
    }
    setSearchingAnitabi(true);
    try {
      const results = await searchAnitabiWorks(anitabiQuery.trim());
      setAnitabiResults(results);
      if (!results.length) showToast("没有找到带 Anitabi 点位的作品。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Anitabi 搜索失败。");
    } finally {
      setSearchingAnitabi(false);
    }
  }

  async function importAnitabi(result: AnitabiSearchResult) {
    setImportingAnitabi(true);
    try {
      const importedStops = await importAnitabiSubject(result.id);
      addStops(importedStops);
      setAnitabiResults([]);
      showToast(`已从 Anitabi 导入 ${importedStops.length} 个巡礼点。`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Anitabi 导入失败。");
    } finally {
      setImportingAnitabi(false);
    }
  }

  function updateStop(stopId: string, patch: Partial<Stop>) {
    commitActivePlan((plan) => {
      const stops = plan.stops.map((stop) => (stop.id === stopId ? { ...stop, ...patch } : stop));
      const changed = stops.find((stop) => stop.id === stopId);
      return {
        ...plan,
        startTime: changed?.isStart && changed.windowStart ? changed.windowStart : plan.startTime,
        stops
      };
    });
  }

  function updateStopKind(stopId: string, kind: StopKind) {
    commitActivePlan((plan) => {
      let nextStartTime = plan.startTime;
      const stops = plan.stops.map((stop) => {
        let next = stop;
        if (kind === "start" && stop.id !== stopId && stop.isStart) {
          next = { ...next, isStart: false };
        }
        if (kind === "end" && stop.id !== stopId && isEndStop(stop)) {
          next = { ...next, isEnd: false, role: isPilgrimageStop(stop) ? "pilgrimage" : "normal" };
        }
        if (stop.id === stopId) {
          next = patchStopKind(next, kind);
          if (kind === "start") nextStartTime = next.windowStart || plan.startTime;
        }
        return next;
      });
      return { ...plan, startTime: nextStartTime, stops };
    });
  }

  function removeStop(stopId: string) {
    commitActivePlan((plan) => ({
      ...plan,
      stops: plan.stops.filter((stop) => stop.id !== stopId)
    }));
    setSelectedStopIds((current) => current.filter((id) => id !== stopId));
    setSelectedStopId((current) => (current === stopId ? null : current));
  }

  function deleteSelectedStops() {
    if (!selectedStopIds.length) return;
    const selected = new Set(selectedStopIds);
    commitActivePlan((plan) => ({
      ...plan,
      stops: plan.stops.filter((stop) => !selected.has(stop.id))
    }));
    setSelectedStopIds([]);
    setSelectedStopId(null);
    showToast("已删除选中地点。");
  }

  function moveStop(fromId: string, toId: string) {
    if (fromId === toId) return;
    commitActivePlan((plan) => {
      const fromIndex = plan.stops.findIndex((stop) => stop.id === fromId);
      const toIndex = plan.stops.findIndex((stop) => stop.id === toId);
      if (fromIndex < 0 || toIndex < 0) return plan;
      const stops = [...plan.stops];
      const [moved] = stops.splice(fromIndex, 1);
      stops.splice(toIndex, 0, moved);
      return { ...plan, stops };
    });
  }

  async function calculateRoute() {
    if (!activePlan || activePlan.stops.length < 2) {
      showToast("至少需要两个地点才能规划路线。");
      return;
    }

    setRouting(true);
    setRoutingStatus("正在优化访问顺序，优先保证定点准时到达。");

    try {
      const base = optimizeDayOrder(activePlan.stops, plannerOptions);
      let orderedStops = base.orderedStops;
      let routePlan = normalizeRoutePlan(null, orderedStops);
      const movedStopIds = new Set(base.movedAfterFixedStopIds);
      const impossibleFixedIds = new Set(base.impossibleFixedStopIds);
      const warnings = [...base.warnings.map((warning) => warning.message)];

      for (let attempt = 0; attempt <= maxRouteRepairAttempts; attempt += 1) {
        const request = buildAutoRouteRequest(orderedStops, plannerOptions);
        setRoutingStatus(
          `正在查询 ${request.expectedLegs} 段路线。超过 1km 优先公共交通，服务端会按 NAVITIME 限流排队。`
        );

        try {
          const serverRoute = await requestAutoRoute(request);
          routePlan = normalizeRoutePlan(serverRoute, orderedStops);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : "路线 API 失败，已使用估算兜底。");
          routePlan = normalizeRoutePlan(null, orderedStops);
          break;
        }

        const repair = repairOrderWithActualLegs(orderedStops, routePlan.legs, plannerOptions);
        if (repair.movedStopId) {
          movedStopIds.add(repair.movedStopId);
          orderedStops = repair.order;
          setRoutingStatus("真实路线显示定点可能迟到，正在把可移动地点挪到定点之后并重新查询。");
          continue;
        }

        repair.impossibleFixedStopIds.forEach((id) => impossibleFixedIds.add(id));
        break;
      }

      const finalSchedule = buildSchedule(orderedStops, plannerOptions, routePlan.legs);
      warnings.push(...scheduleWarnings(finalSchedule));
      if (movedStopIds.size > 0) {
        warnings.push(`已将 ${movedStopIds.size} 个普通点/巡礼点挪到定点之后。`);
      }
      if (impossibleFixedIds.size > 0) {
        const names = orderedStops.filter((stop) => impossibleFixedIds.has(stop.id)).map((stop) => stop.name);
        warnings.push(`无法合理安排的定点：${names.join("、")}`);
      }

      const finalRoutePlan = {
        ...normalizeRoutePlan(routePlan, orderedStops),
        warnings
      };
      commitActivePlan(
        (plan) => ({
          ...plan,
          stops: orderedStops,
          routePlan: finalRoutePlan
        }),
        { staleRoute: false }
      );
      setRouteStalePlanIds((current) => {
        const next = new Set(current);
        next.delete(activePlan.id);
        return next;
      });
      setFitRouteToken((value) => value + 1);
      showToast(warnings.length ? "路线已更新，并附带需要注意的提示。" : "路线规划完成。");
    } finally {
      setRouting(false);
      setRoutingStatus("");
    }
  }

  function handleSelectionPointerDown(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setDragRect({ startX: x, startY: y, endX: x, endY: y });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSelectionPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragRect) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setDragRect({
      ...dragRect,
      endX: event.clientX - rect.left,
      endY: event.clientY - rect.top
    });
  }

  function finishSelection() {
    if (!activePlan || !dragRect || !mapRef.current) {
      setDragRect(null);
      return;
    }

    const left = Math.min(dragRect.startX, dragRect.endX);
    const top = Math.min(dragRect.startY, dragRect.endY);
    const width = Math.abs(dragRect.startX - dragRect.endX);
    const height = Math.abs(dragRect.startY - dragRect.endY);
    if (width < 8 || height < 8) {
      setDragRect(null);
      return;
    }

    const controller = mapRef.current;
    const selected = activePlan.stops
      .filter((stop) => {
        const point = controller.latLngToContainerPoint(stop.location);
        if (!point) return false;
        return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
      })
      .map((stop) => stop.id);
    setSelectedStopIds(selected);
    setSelectedStopId(selected[0] || null);
    setDragRect(null);
    showToast(selected.length ? `已选中 ${selected.length} 个地点。` : "框选区域内没有地点。");
  }

  function selectionRectStyle(): SelectionRect | null {
    if (!dragRect) return null;
    return {
      left: Math.min(dragRect.startX, dragRect.endX),
      top: Math.min(dragRect.startY, dragRect.endY),
      width: Math.abs(dragRect.startX - dragRect.endX),
      height: Math.abs(dragRect.startY - dragRect.endY)
    };
  }

  function selectStop(stop: Stop) {
    setSelectedStopId(stop.id);
    setSelectedStopIds([stop.id]);
    mapRef.current?.setView(stop.location, 15);
  }

  function handleKmlFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = stopsFromKml(String(reader.result || ""));
        addStops(imported);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "KML 导入失败。");
      }
    };
    reader.readAsText(file);
  }

  function copyGoogleMapsLink() {
    if (!activePlan || activePlan.stops.length < 2) return;
    const [origin, ...rest] = activePlan.stops;
    const destination = rest[rest.length - 1];
    const waypoints = rest.slice(0, -1);
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", `${origin.location.lat},${origin.location.lng}`);
    url.searchParams.set("destination", `${destination.location.lat},${destination.location.lng}`);
    if (waypoints.length) {
      url.searchParams.set("waypoints", waypoints.map((stop) => `${stop.location.lat},${stop.location.lng}`).join("|"));
    }
    void navigator.clipboard.writeText(url.toString());
    showToast("已复制 Google Maps 路线链接。");
  }

  function exportJson() {
    if (!activePlan) return;
    const blob = new Blob([JSON.stringify(activePlan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(activePlan.name)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function selectRouteAlternative(legIndex: number, alternativeIndex: number) {
    commitActivePlan(
      (plan) => {
        if (!plan.routePlan) return plan;
        return {
          ...plan,
          routePlan: selectRouteAlternativeInPlan(plan.routePlan, plan.stops, legIndex, alternativeIndex)
        };
      },
      { staleRoute: false }
    );
    showToast(`已切换到路线方案 ${alternativeIndex + 1}。`);
  }

  function renderRouteLeg(leg: RouteLeg, from: Stop, to: Stop, fromLabel: string, toLabel: string, legIndex: number) {
    const mode = leg.mode === "WALK" ? "walk" : "transit";
    const Icon = mode === "walk" ? Footprints : TrainFront;
    const steps = leg.steps || [];
    const alternatives = routeAlternativeOptions(leg);
    const activeAlternativeIndex = activeRouteAlternativeIndex(leg, alternatives);
    const stats = [
      formatDuration(leg.durationSeconds),
      formatDistance(leg.distanceMeters),
      leg.transfers ? `换乘 ${leg.transfers} 次` : "",
      formatMoney(leg.fare)
    ].filter(Boolean);

    return (
      <article className={`route-leg-card is-${mode}`} key={`${from.id}-${to.id}`}>
        <div className="route-leg-spine">
          <span>{fromLabel}</span>
          <i />
          <span>{toLabel}</span>
        </div>
        <div className="route-leg-content">
          <header className="route-leg-header">
            <div>
              <p>
                {from.name} → {to.name}
              </p>
              <strong>
                <Icon size={15} />
                {leg.summary || (mode === "walk" ? "步行" : "公共交通")}
              </strong>
            </div>
            <div className="route-leg-stats">
              {stats.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </header>
          {leg.fallbackReason && <p className="route-fallback-note">{leg.fallbackReason}</p>}
          {alternatives.length > 1 && (
            <div className="route-alternative-list" aria-label="备选路线">
              {alternatives.map((option, index) => (
                <button
                  className={`route-alternative-button ${index === activeAlternativeIndex ? "is-selected" : ""}`}
                  type="button"
                  key={`${option.summary}-${option.startTime}-${option.endTime}-${index}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectRouteAlternative(legIndex, index);
                  }}
                >
                  <strong>方案 {index + 1}</strong>
                  <span>{formatDuration(option.durationSeconds)}</span>
                  {option.transfers ? <span>换乘 {option.transfers} 次</span> : null}
                  {formatMoney(option.fare) ? <span>{formatMoney(option.fare)}</span> : null}
                  <small>{option.summary || "公共交通"}</small>
                </button>
              ))}
            </div>
          )}
          {steps.length > 0 && (
            <details className="route-step-details">
              <summary>查看换乘步骤（{steps.length}）</summary>
              <ol className="route-step-list">
              {steps.map((step, index) => {
                const StepIcon = isWalkingStep(step) ? Footprints : TrainFront;
                return (
                  <li className={`route-step ${isWalkingStep(step) ? "is-walk" : "is-transit"}`} key={index}>
                    <span className="route-step-icon">
                      <StepIcon size={14} />
                    </span>
                    <div className="route-step-copy">
                      <div className="route-step-main">
                        <strong>{routeStepTitle(step)}</strong>
                        <span>{routeStepMeta(step)}</span>
                      </div>
                      {routeStepStations(step) && <p>{routeStepStations(step)}</p>}
                      {cleanInstruction(step.instructions) && <p className="route-step-note">{cleanInstruction(step.instructions)}</p>}
                    </div>
                  </li>
                );
              })}
              </ol>
            </details>
          )}
        </div>
      </article>
    );
  }

  function renderStopCard(stop: Stop, index: number) {
    const item = schedule[index];
    const selected = selectedStopId === stop.id || selectedStopSet.has(stop.id);
    const kind = stopKind(stop);
    const label = isStartStop(stop) ? "起" : isEndStop(stop) ? "终" : String(index + 1);

    return (
      <article
        className={`stop-card is-${kind} ${selected ? "is-selected" : ""} ${item?.isLate ? "is-late" : ""}`}
        draggable
        onClick={() => selectStop(stop)}
        onDragStart={(event: DragEvent) => {
          setDragStopId(stop.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => {
          if (dragStopId) moveStop(dragStopId, stop.id);
          setDragStopId(null);
        }}
      >
        <div className="drag-handle" title="拖动排序" aria-label="拖动排序">
          <GripVertical size={16} />
        </div>
        <div className="stop-index">{label}</div>
        <div className="stop-body">
          <input
            className="stop-title"
            value={stop.name}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => updateStop(stop.id, { name: event.target.value })}
          />
          <p>{stop.address || `${stop.location.lat.toFixed(5)}, ${stop.location.lng.toFixed(5)}`}</p>
          <textarea
            className="stop-note"
            rows={2}
            placeholder="在这里记录要做什么"
            value={stop.note || ""}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => updateStop(stop.id, { note: event.target.value })}
          />
          <div className="stop-controls" onClick={(event) => event.stopPropagation()}>
            <label className={`compact-field role-field is-${kind}`}>
              <span>类型</span>
              <select value={kind} onChange={(event) => updateStopKind(stop.id, event.target.value as StopKind)}>
                <option value="start">起点</option>
                <option value="normal">普通点</option>
                <option value="pilgrimage">巡礼点</option>
                <option value="fixed">定点</option>
                <option value="end">终点</option>
              </select>
            </label>
            <label className="compact-field stay-field">
              <span>停留</span>
              <input
                type="number"
                min={0}
                max={720}
                step={1}
                value={stopVisitMinutes(stop)}
                onChange={(event) => updateStop(stop.id, { stayMinutes: normalizeStayMinutes(event.target.value, 0) })}
              />
            </label>
            {(isStartStop(stop) || isFixedStop(stop)) && (
              <label className="compact-field time-field">
                <span>开始</span>
                <input
                  type="time"
                  value={normalizeClockValue(stop.windowStart) || ""}
                  onChange={(event) => updateStop(stop.id, { windowStart: event.target.value })}
                />
              </label>
            )}
          </div>
          <div className="stop-meta">
            {item && (
              <span>
                <Clock3 size={14} />
                {formatClock(item.visitStartMinutes)} - {formatClock(item.departureMinutes)}
              </span>
            )}
            {item?.waitMinutes ? <span>等待 {item.waitMinutes} 分钟</span> : null}
            {item?.isLate && <span className="late-pill">迟到 {item.lateByMinutes} 分钟</span>}
            {stop.source?.includes("Anitabi") && <span>Anitabi</span>}
            {(stop.imageUrl || stop.thumbnailUrl) && (
              <button
                className="meta-image-button"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setImageStop(stop);
                }}
              >
                <ImageIcon size={14} />
                查看图片
              </button>
            )}
          </div>
        </div>
        <div className="stop-actions" onClick={(event) => event.stopPropagation()}>
          <button className="icon-button danger" type="button" title="删除地点" aria-label="删除地点" onClick={() => removeStop(stop.id)}>
            <Trash2 size={17} />
          </button>
        </div>
      </article>
    );
  }

  if (!activePlan) {
    return (
      <main className="plans-shell">
        <section className="plans-workspace">
          <header className="plans-header">
            <div>
              <p className="eyebrow">Daytrip Planner</p>
              <h1>一日规划</h1>
            </div>
            <span className={`sync-pill is-${saveState}`}>
              {saveState === "loading" ? "正在读取服务端" : saveState === "local" ? "本地缓存模式" : "服务端同步"}
            </span>
          </header>

          <div className="new-plan-panel">
            <label className="field">
              <span>日期</span>
              <input type="date" value={newPlanDate} onChange={(event) => setNewPlanDate(event.target.value)} />
            </label>
            <label className="field new-plan-name">
              <span>名称</span>
              <input value={newPlanName} placeholder="例如 7/19 京都巡礼" onChange={(event) => setNewPlanName(event.target.value)} />
            </label>
            <button className="primary-button" type="button" onClick={createPlan}>
              <Plus size={18} />
              新建规划
            </button>
          </div>

          {plans.length === 0 ? (
            <div className="empty-plan-state">
              <CalendarDays size={36} />
              <h2>还没有规划</h2>
              <p>选择日期并创建一个一日规划。</p>
            </div>
          ) : (
            <div className="plan-card-grid">
              {plans.map((plan) => {
                const stats = planStats(plan);
                return (
                  <article className="plan-card" key={plan.id}>
                    <div className="plan-card-topline">
                      <span>
                        <CalendarDays size={14} />
                        {formatPlanDate(plan.tripDate)}
                      </span>
                      <button className="icon-button danger" type="button" title="删除规划" onClick={() => void removePlan(plan.id)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <button className="plan-card-main" type="button" onClick={() => setActivePlanId(plan.id)}>
                      <strong>{plan.name}</strong>
                      <span>{stats.stops} 个地点</span>
                    </button>
                    <div className="plan-card-stats">
                      <span>{formatDistance(stats.distance)}</span>
                      <span>{formatDuration(stats.duration)}</span>
                      <span>{firstRouteCoordinate(plan) ? "已有地图点位" : "待添加地点"}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  }

  const routeMetrics = {
    distance: activePlan.routePlan?.distanceMeters || 0,
    duration: activePlan.routePlan?.durationSeconds || 0,
    end: schedule[schedule.length - 1]?.departureMinutes || 0
  };
  const rect = selectionRectStyle();

  return (
    <main className="app-shell">
      <section className="planner-panel">
        <header className="panel-header">
          <button className="icon-button" type="button" title="返回规划列表" onClick={() => setActivePlanId(null)}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <input
              className="plan-title-input"
              value={activePlan.name}
              onChange={(event) => commitActivePlan((plan) => ({ ...plan, name: event.target.value }), { staleRoute: false })}
            />
            <p className="save-status">
              {saveState === "saving" ? "保存中" : saveState === "local" ? "本地缓存" : "已同步"} / {formatPlanDate(activePlan.tripDate)}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            title="立即保存"
            onClick={() => {
              dirtyPlanIds.current.add(activePlan.id);
              commitActivePlan((plan) => plan, { staleRoute: false });
            }}
          >
            <Save size={18} />
          </button>
        </header>

        <div className="date-row">
          <label className="field">
            <span>日期</span>
            <input
              type="date"
              value={activePlan.tripDate}
              onChange={(event) => commitActivePlan((plan) => ({ ...plan, tripDate: event.target.value }))}
            />
          </label>
          <div className="status-card">
            <CheckCircle2 size={16} />
            <span>{routeStale ? "路线已过期，点击自动规划刷新" : activePlan.routePlan ? "路线已规划" : "待规划路线"}</span>
          </div>
        </div>

        <div className="stats-strip">
          <div>
            <span>距离</span>
            <strong>{formatDistance(routeMetrics.distance)}</strong>
          </div>
          <div>
            <span>路上</span>
            <strong>{formatDuration(routeMetrics.duration)}</strong>
          </div>
          <div>
            <span>结束</span>
            <strong>{routeMetrics.end ? formatClock(routeMetrics.end) : "--:--"}</strong>
          </div>
        </div>

        <div className="add-place-panel">
          <div className="search-row">
            <Search size={18} />
            <input
              className="place-search"
              value={searchText}
              placeholder="搜索地点，或粘贴坐标 / Google Maps 链接"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSearch();
              }}
            />
            <select value={newStopKind} onChange={(event) => setNewStopKind(event.target.value as StopKind)} aria-label="新增地点类型">
              <option value="normal">普通点</option>
              <option value="pilgrimage">巡礼点</option>
              <option value="fixed">定点</option>
              <option value="start">起点</option>
              <option value="end">终点</option>
            </select>
            <button className="icon-button" type="button" title={searching ? "搜索中" : "搜索或添加"} onClick={() => void handleSearch()}>
              {searching ? <span className="button-spinner dark" /> : <Plus size={18} />}
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((result) => (
                <button className="search-result-card" key={result.id} type="button" onClick={() => addSearchResult(result)}>
                  <strong>{result.name}</strong>
                  <span>{result.address || result.source}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <details className="anitabi-search-box">
          <summary className="section-disclosure">
            <span>
              <MapPin size={16} />
              导入 Anitabi
            </span>
            <small>按作品名查找巡礼点</small>
          </summary>
          <div className="anitabi-row">
            <input
              value={anitabiQuery}
              placeholder="按作品名模糊查找 Anitabi"
              onChange={(event) => {
                setAnitabiQuery(event.target.value);
                setAnitabiResults([]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAnitabiSearch();
              }}
            />
            <button className="secondary-button" type="button" disabled={searchingAnitabi || importingAnitabi} onClick={() => void handleAnitabiSearch()}>
              <MapPin size={17} />
              {searchingAnitabi ? "查找中" : "查找作品"}
            </button>
          </div>
          {(searchingAnitabi || anitabiResults.length > 0) && (
            <div className="anitabi-results">
              {searchingAnitabi && !anitabiResults.length ? (
                <div className="anitabi-result-empty">正在查找作品...</div>
              ) : (
                anitabiResults.map((result) => {
                  const title = result.cn || result.title || `Bangumi ${result.id}`;
                  const meta = [
                    result.city,
                    result.date,
                    `${result.pointsLength || 0} 点位`,
                    `${result.imagesLength || 0} 截图`
                  ].filter(Boolean);
                  return (
                    <article className="anitabi-result-card" key={result.id}>
                      {result.cover ? <img className="anitabi-result-cover" src={result.cover} alt="" /> : <div className="anitabi-result-cover" />}
                      <div className="anitabi-result-copy">
                        <strong>{title}</strong>
                        {result.title && result.title !== title && <span>{result.title}</span>}
                        <small>{meta.join(" / ")}</small>
                      </div>
                      <button className="secondary-button" type="button" disabled={importingAnitabi} onClick={() => void importAnitabi(result)}>
                        <Upload size={15} />
                        导入
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          )}
        </details>

        <div className="route-actions">
          <button className="primary-button" type="button" disabled={routing} onClick={() => void calculateRoute()}>
            {routing ? <span className="button-spinner" /> : <Route size={18} />}
            {routing ? "正在规划" : "自动规划路线"}
          </button>
          {routing && (
            <div className="routing-status" role="status">
              <span className="inline-spinner" />
              <span>{routingStatus}</span>
            </div>
          )}
          {routeStale && !routing && <div className="route-stale-note">地点、时间或顺序已变更。旧路线会继续显示作为参考，点击自动规划后刷新。</div>}
          {activePlan.routePlan?.warnings?.length ? (
            <div className="route-warning-list">
              {activePlan.routePlan.warnings.slice(0, 4).map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          ) : null}
          <div className="selection-actions">
            <button
              className={`secondary-button ${boxSelectMode ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                setBoxSelectMode((current) => !current);
                setDragRect(null);
              }}
            >
              <LocateFixed size={17} />
              {boxSelectMode ? "退出框选" : "框选地点"}
            </button>
            <button className="secondary-button danger" type="button" disabled={!selectedStopIds.length} onClick={deleteSelectedStops}>
              <Trash2 size={17} />
              删除选中
            </button>
          </div>
        </div>

        <section className="stop-list" aria-label="地点列表">
          {activePlan.stops.length === 0 ? (
            <div className="empty-stop-state">
              <MapPin size={28} />
              <strong>先添加一个起点</strong>
              <span>搜索地点、导入 Anitabi，或把地图移动到目标位置后添加地图中心点。</span>
              <button className="secondary-button" type="button" onClick={addStopFromMapClick}>
                <Plus size={17} />
                添加地图中心点
              </button>
            </div>
          ) : (
            activePlan.stops.map((stop, index) => {
              const leg = routeLegsForSchedule[index];
              const nextStop = activePlan.stops[index + 1];
              const fromLabel = isStartStop(stop) ? "起" : isEndStop(stop) ? "终" : String(index + 1);
              const toLabel = nextStop ? (isEndStop(nextStop) ? "终" : String(index + 2)) : "";
              return (
                <Fragment key={stop.id}>
                  {renderStopCard(stop, index)}
                  {leg && nextStop && renderRouteLeg(leg, stop, nextStop, fromLabel, toLabel, index)}
                </Fragment>
              );
            })
          )}
        </section>

        <footer className="panel-footer">
          <input ref={fileInputRef} hidden type="file" accept=".kml,application/vnd.google-earth.kml+xml" onChange={handleKmlFile} />
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
        {boxSelectMode && (
          <div
            className="map-selection-layer"
            onPointerDown={handleSelectionPointerDown}
            onPointerMove={handleSelectionPointerMove}
            onPointerUp={finishSelection}
            onPointerCancel={() => setDragRect(null)}
          >
            {rect && <div className="map-selection-rect" style={rect} />}
          </div>
        )}
        <div className="map-overlay">
          <Layers3 size={15} />
          <span>
            {activePlan.routePlan
              ? `${routeStale ? "旧路线 / " : ""}${routeProviderLabel(activePlan.routePlan.provider)} / ${mapProviderLabel(mapProvider)}`
              : mapProviderLabel(mapProvider)}
          </span>
        </div>
        <button className="map-add-button" type="button" onClick={addStopFromMapClick}>
          <Plus size={17} />
          添加中心点
        </button>
      </section>

      {imageStop && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setImageStop(null)}>
          <div className="image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>{imageStop.name}</strong>
                <span>{[imageStop.workTitle, imageStop.episode ? `第 ${imageStop.episode} 话` : ""].filter(Boolean).join(" / ")}</span>
              </div>
              <button className="icon-button subtle" type="button" title="关闭" onClick={() => setImageStop(null)}>
                <X size={18} />
              </button>
            </header>
            <img src={imageStop.imageUrl || imageStop.thumbnailUrl} alt={imageStop.name} />
            {(imageStop.origin || imageStop.originUrl) && (
              <footer>
                {imageStop.origin && <span>来源：{imageStop.origin}</span>}
                {imageStop.originUrl && (
                  <a href={imageStop.originUrl} target="_blank" rel="noreferrer">
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
