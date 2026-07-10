import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng, Stop } from "../domain/types";

export type MapProvider = "google" | "osm";

type MarkerSelectHandler = (stop: Stop) => void;

export type MapController = {
  provider: MapProvider;
  dispose(): void;
  getCenter(): LatLng;
  setView(location: LatLng, zoom?: number): void;
  setMarkers(
    stops: Stop[],
    selectedStopId: string | null,
    selectedStopIds: Set<string>,
    onSelect: MarkerSelectHandler
  ): void;
  setRoute(coordinates: Array<[number, number]> | undefined, stale: boolean): void;
  fitTo(points: LatLng[]): void;
  latLngToContainerPoint(location: LatLng): { x: number; y: number } | null;
};

const browserApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const googleMapId = import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined;
const googleMapsScriptId = "daytrip-google-maps-script";
const defaultCenter = { lat: 34.985849, lng: 135.758766 };

declare global {
  interface Window {
    __daytripGoogleMapsPromise?: Promise<typeof google>;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stopKind(stop: Stop) {
  if (stop.isStart) return "start";
  if (stop.isEnd || stop.role === "end") return "end";
  if (stop.role === "fixed") return "fixed";
  if (stop.role === "pilgrimage" || stop.anitabiPointId || stop.workTitle) return "pilgrimage";
  return "normal";
}

function markerClass(stop: Stop, selected: boolean) {
  const classes = ["stop-marker", `is-${stopKind(stop)}`];
  if (selected) classes.push("is-selected");
  if (stop.imageUrl || stop.thumbnailUrl) classes.push("has-preview");
  return classes.join(" ");
}

function markerLabel(stop: Stop, index: number) {
  if (stop.isStart) return "起";
  if (stop.isEnd || stop.role === "end") return "终";
  return String(index + 1);
}

function markerHtml(stop: Stop, index: number, selected: boolean) {
  return `<div class="${markerClass(stop, selected)}">${escapeHtml(markerLabel(stop, index))}</div>`;
}

function anitabiPreviewHtml(stop: Stop) {
  const image = stop.thumbnailUrl || stop.imageUrl;
  if (!image) return "";
  const meta = [stop.workTitle, stop.episode ? `第 ${stop.episode} 话` : ""]
    .filter(Boolean)
    .join(" / ");
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

async function loadGoogleMaps() {
  if (!browserApiKey) {
    throw new Error("VITE_GOOGLE_MAPS_API_KEY is not configured.");
  }
  if (window.google?.maps) {
    return window.google;
  }
  if (window.__daytripGoogleMapsPromise) {
    return window.__daytripGoogleMapsPromise;
  }

  window.__daytripGoogleMapsPromise = new Promise<typeof google>((resolve, reject) => {
    const existing = document.getElementById(googleMapsScriptId) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google));
      existing.addEventListener("error", () => reject(new Error("Google Maps script failed to load.")));
      return;
    }

    const script = document.createElement("script");
    const url = new URL("https://maps.googleapis.com/maps/api/js");
    url.searchParams.set("key", browserApiKey);
    url.searchParams.set("v", "weekly");
    if (googleMapId) {
      url.searchParams.set("map_ids", googleMapId);
    }
    script.id = googleMapsScriptId;
    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("Google Maps script failed to load."));
    document.head.appendChild(script);
  });

  return window.__daytripGoogleMapsPromise;
}

function createGoogleHtmlMarkerClass(googleApi: typeof google) {
  return class GoogleHtmlMarker extends googleApi.maps.OverlayView {
    private div: HTMLDivElement | null = null;

    constructor(
      private position: google.maps.LatLngLiteral,
      private html: string,
      private onClick: () => void
    ) {
      super();
    }

    onAdd() {
      this.div = document.createElement("div");
      this.div.className = "google-html-marker";
      this.div.innerHTML = this.html;
      this.div.addEventListener("click", this.onClick);
      const panes = this.getPanes();
      panes?.overlayMouseTarget.appendChild(this.div);
    }

    draw() {
      if (!this.div) return;
      const projection = this.getProjection();
      if (!projection) return;
      const point = projection.fromLatLngToDivPixel(this.position);
      if (!point) return;
      this.div.style.left = `${point.x}px`;
      this.div.style.top = `${point.y}px`;
    }

    onRemove() {
      if (!this.div) return;
      this.div.removeEventListener("click", this.onClick);
      this.div.remove();
      this.div = null;
    }
  };
}

function createGoogleProjectionOverlayClass(googleApi: typeof google) {
  return class GoogleProjectionOverlay extends googleApi.maps.OverlayView {
    onAdd() {}
    draw() {}
    onRemove() {}
  };
}

class GoogleMapController implements MapController {
  provider: MapProvider = "google";
  private markers: google.maps.OverlayView[] = [];
  private routeLine: google.maps.Polyline | null = null;
  private projectionOverlay: google.maps.OverlayView;
  private HtmlMarker: ReturnType<typeof createGoogleHtmlMarkerClass>;

  constructor(private map: google.maps.Map, private container: HTMLElement, googleApi: typeof google) {
    this.HtmlMarker = createGoogleHtmlMarkerClass(googleApi);
    const ProjectionOverlay = createGoogleProjectionOverlayClass(googleApi);
    this.projectionOverlay = new ProjectionOverlay();
    this.projectionOverlay.setMap(map);
  }

  dispose() {
    this.setMarkers([], null, new Set(), () => {});
    this.setRoute(undefined, false);
    this.projectionOverlay.setMap(null);
  }

  getCenter() {
    const center = this.map.getCenter();
    return center ? { lat: center.lat(), lng: center.lng() } : defaultCenter;
  }

  setView(location: LatLng, zoom = 15) {
    this.map.panTo(location);
    this.map.setZoom(Math.max(this.map.getZoom() || zoom, zoom));
  }

  setMarkers(
    stops: Stop[],
    selectedStopId: string | null,
    selectedStopIds: Set<string>,
    onSelect: MarkerSelectHandler
  ) {
    this.markers.forEach((marker) => marker.setMap(null));
    this.markers = stops.map((stop, index) => {
      const selected = selectedStopId === stop.id || selectedStopIds.has(stop.id);
      const marker = new this.HtmlMarker(
        stop.location,
        `${markerHtml(stop, index, selected)}${anitabiPreviewHtml(stop)}`,
        () => onSelect(stop)
      );
      marker.setMap(this.map);
      return marker;
    });
  }

  setRoute(coordinates: Array<[number, number]> | undefined, stale: boolean) {
    this.routeLine?.setMap(null);
    this.routeLine = null;
    if (!coordinates || coordinates.length < 2) return;
    this.routeLine = new google.maps.Polyline({
      path: coordinates.map(([lat, lng]) => ({ lat, lng })),
      strokeColor: stale ? "#9c7a22" : "#167c80",
      strokeOpacity: stale ? 0.58 : 0.82,
      strokeWeight: 5,
      map: this.map
    });
  }

  fitTo(points: LatLng[]) {
    if (!points.length) return;
    if (points.length === 1) {
      this.setView(points[0], 15);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point));
    this.map.fitBounds(bounds, {
      top: 48,
      right: 48,
      bottom: 48,
      left: 48
    });
  }

  latLngToContainerPoint(location: LatLng) {
    const projection = this.projectionOverlay.getProjection();
    if (!projection) return null;
    const divPixel = projection.fromLatLngToDivPixel(location);
    if (!divPixel) return null;
    const pane = this.container.querySelector(".gm-style > div:first-child") as HTMLElement | null;
    const transform = pane?.style.transform || "";
    const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    const offsetX = match ? Number(match[1]) : 0;
    const offsetY = match ? Number(match[2]) : 0;
    return { x: divPixel.x + offsetX, y: divPixel.y + offsetY };
  }
}

class LeafletMapController implements MapController {
  provider: MapProvider = "osm";
  private markerLayer: L.LayerGroup;
  private routeLayer: L.LayerGroup;

  constructor(private map: L.Map) {
    this.markerLayer = L.layerGroup().addTo(map);
    this.routeLayer = L.layerGroup().addTo(map);
  }

  dispose() {
    this.map.remove();
  }

  getCenter() {
    const center = this.map.getCenter();
    return { lat: center.lat, lng: center.lng };
  }

  setView(location: LatLng, zoom = 15) {
    this.map.setView([location.lat, location.lng], Math.max(this.map.getZoom(), zoom), { animate: true });
  }

  setMarkers(
    stops: Stop[],
    selectedStopId: string | null,
    selectedStopIds: Set<string>,
    onSelect: MarkerSelectHandler
  ) {
    this.markerLayer.clearLayers();
    stops.forEach((stop, index) => {
      const selected = selectedStopId === stop.id || selectedStopIds.has(stop.id);
      const marker = L.marker([stop.location.lat, stop.location.lng], {
        icon: L.divIcon({
          className: "leaflet-stop-marker",
          html: markerHtml(stop, index, selected),
          iconSize: [38, 38],
          iconAnchor: [19, 19]
        })
      });
      marker.on("click", () => onSelect(stop));
      const tooltipHtml = anitabiPreviewHtml(stop);
      if (tooltipHtml) {
        marker.bindTooltip(tooltipHtml, {
          direction: "top",
          offset: [0, -20],
          opacity: 1,
          className: "anitabi-map-tooltip"
        });
      }
      marker.addTo(this.markerLayer);
    });
  }

  setRoute(coordinates: Array<[number, number]> | undefined, stale: boolean) {
    this.routeLayer.clearLayers();
    if (!coordinates || coordinates.length < 2) return;
    L.polyline(coordinates, {
      color: stale ? "#9c7a22" : "#167c80",
      weight: 5,
      opacity: stale ? 0.58 : 0.82
    }).addTo(this.routeLayer);
  }

  fitTo(points: LatLng[]) {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [48, 48], animate: true });
    }
  }

  latLngToContainerPoint(location: LatLng) {
    const point = this.map.latLngToContainerPoint([location.lat, location.lng]);
    return { x: point.x, y: point.y };
  }
}

function createLeafletMap(container: HTMLElement) {
  const map = L.map(container, {
    zoomControl: true,
    boxZoom: false
  }).setView([defaultCenter.lat, defaultCenter.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  return new LeafletMapController(map);
}

export async function createMapController(container: HTMLElement): Promise<MapController> {
  try {
    const googleApi = await loadGoogleMaps();
    const map = new googleApi.maps.Map(container, {
      center: defaultCenter,
      zoom: 12,
      mapId: googleMapId || undefined,
      gestureHandling: "greedy",
      fullscreenControl: false,
      streetViewControl: false,
      mapTypeControl: false
    });
    return new GoogleMapController(map, container, googleApi);
  } catch (error) {
    console.warn("[map] Falling back to OpenStreetMap", error);
    return createLeafletMap(container);
  }
}
