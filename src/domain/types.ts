export type LatLng = {
  lat: number;
  lng: number;
};

export type TransitTimePreference = "departure" | "arrival";

export type StopRole = "normal" | "pilgrimage" | "fixed" | "end";

export type StopSource =
  | "manual"
  | "search"
  | "coordinate"
  | "kml"
  | "anitabi"
  | "sample";

export type Stop = {
  id: string;
  name: string;
  address?: string;
  placeId?: string;
  location: LatLng;
  stayMinutes: number;
  role?: StopRole;
  isStart?: boolean;
  isEnd?: boolean;
  windowStart?: string;
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

export type RouteStep = {
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

export type RouteLeg = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline?: string;
  coordinates?: Array<[number, number]>;
  summary?: string;
  steps?: RouteStep[];
  mode?: "WALK" | "TRANSIT";
  preferredMode?: "WALK" | "TRANSIT";
  fallbackReason?: string;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  fare?: number | string;
  directDistanceMeters?: number;
  provider?: string;
  alternativeIndex?: number;
  selectedAlternativeIndex?: number;
  alternatives?: RouteLeg[];
};

export type RoutePlan = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline?: string;
  coordinates?: Array<[number, number]>;
  legs: RouteLeg[];
  routeStopIds?: string[];
  provider?: string;
  strategy?: Record<string, unknown>;
  warnings?: string[];
};

export type DayPlan = {
  id: string;
  name: string;
  tripDate: string;
  startTime: string;
  transitTimePreference: TransitTimePreference;
  stops: Stop[];
  routePlan: RoutePlan | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResult = {
  id: number | string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  source: string;
  placeId?: string;
};

export type AnitabiSearchResult = {
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

export type ScheduleItem = {
  stop: Stop;
  index: number;
  arrivalMinutes: number;
  visitStartMinutes: number;
  departureMinutes: number;
  waitMinutes: number;
  isLate: boolean;
  lateByMinutes: number;
  travelToNextMinutes: number;
  leg?: RouteLeg;
};

export type PlannerWarning = {
  code:
    | "missing-start"
    | "missing-end"
    | "fixed-impossible"
    | "fixed-repaired"
    | "route-stale"
    | "route-fallback";
  message: string;
  stopId?: string;
};

export type PlannerResult = {
  orderedStops: Stop[];
  schedule: ScheduleItem[];
  movedAfterFixedStopIds: string[];
  impossibleFixedStopIds: string[];
  warnings: PlannerWarning[];
};
