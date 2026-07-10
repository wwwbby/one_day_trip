import { createStop } from "./stops";
import type { SearchResult, Stop } from "./types";

export function parseCoordinateInput(value: string) {
  const text = value.trim();
  const patterns = [
    /(?:^|[^\d.-])(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|ll)=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

export function stopFromSearchResult(result: SearchResult, role: "normal" | "end" = "normal") {
  return createStop({
    name: result.name,
    address: result.address || result.source,
    placeId: result.placeId,
    location: { lat: Number(result.lat), lng: Number(result.lng) },
    role,
    isEnd: role === "end",
    stayMinutes: role === "end" ? 0 : 5,
    source: result.source || "search"
  });
}

export function stopsFromKml(content: string): Stop[] {
  const document = new DOMParser().parseFromString(content, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) {
    throw new Error("KML 文件无法解析。");
  }

  const placemarks = Array.from(document.querySelectorAll("Placemark"));
  const stops: Stop[] = [];
  for (const placemark of placemarks) {
    const name = placemark.querySelector("name")?.textContent?.trim() || "KML 地点";
    const description = placemark.querySelector("description")?.textContent?.trim() || "";
    const coordinateText = placemark.querySelector("coordinates")?.textContent?.trim();
    if (!coordinateText) continue;
    const [lngText, latText] = coordinateText.split(/[,\s]+/);
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stops.push(
      createStop({
        name,
        address: description,
        location: { lat, lng },
        source: "kml",
        stayMinutes: 5
      })
    );
  }

  return stops;
}
