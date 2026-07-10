import type { LatLng, Stop } from "./types";

export const autoTransitThresholdMeters = 1000;

export function haversineMeters(a: LatLng | Stop, b: LatLng | Stop) {
  const pointA = "location" in a ? a.location : a;
  const pointB = "location" in b ? b.location : b;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRad(Number(pointB.lat) - Number(pointA.lat));
  const dLng = toRad(Number(pointB.lng) - Number(pointA.lng));
  const lat1 = toRad(Number(pointA.lat));
  const lat2 = toRad(Number(pointB.lat));
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

export function preferredTravelMode(from: Stop, to: Stop) {
  return haversineMeters(from, to) > autoTransitThresholdMeters ? "TRANSIT" : "WALK";
}

export function estimateTravelMinutes(from: Stop, to: Stop) {
  const distance = haversineMeters(from, to);
  if (distance <= autoTransitThresholdMeters) {
    return Math.max(3, Math.ceil(distance / 75));
  }

  const lineHaulMinutes = distance / 420;
  const accessAndWaitMinutes = 14;
  return Math.max(16, Math.ceil(accessAndWaitMinutes + lineHaulMinutes));
}
