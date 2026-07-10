import { anitabiPointToStop, normalizeDayPlan } from "../domain/stops";
import type { AnitabiSearchResult, DayPlan, RoutePlan, SearchResult, Stop } from "../domain/types";

export async function readApiJson(response: Response, fallback: string) {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const text = await response.text();
  let data: any = {};

  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 180);
      throw new Error(`${fallback}（${status}：返回内容不是 JSON：${excerpt}）`);
    }
  }

  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : "";
    throw new Error(message ? `${fallback}（${status}：${message}）` : `${fallback}（${status}）`);
  }

  return data;
}

export async function fetchPlans() {
  const response = await fetch("/api/plans");
  const data = await readApiJson(response, "服务端规划读取失败");
  return Array.isArray(data?.plans)
    ? (data.plans.map(normalizeDayPlan).filter(Boolean) as DayPlan[])
    : [];
}

export async function savePlan(plan: DayPlan) {
  const response = await fetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan })
  });
  const data = await readApiJson(response, "规划保存失败");
  return normalizeDayPlan(data?.plan) || plan;
}

export async function deletePlan(id: string) {
  const response = await fetch(`/api/plans?id=${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  await readApiJson(response, "删除规划失败");
}

export async function searchPlaces(query: string) {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  const data = await readApiJson(response, "地点搜索失败");
  return Array.isArray(data?.results) ? (data.results as SearchResult[]) : [];
}

export async function searchAnitabiWorks(query: string) {
  const response = await fetch(`/api/anitabi/search?q=${encodeURIComponent(query)}`);
  const data = await readApiJson(response, "Anitabi 搜索失败");
  return Array.isArray(data?.results) ? (data.results as AnitabiSearchResult[]) : [];
}

export async function importAnitabiSubject(subjectId: number | string) {
  const response = await fetch(`/api/anitabi/detail?subjectId=${encodeURIComponent(subjectId)}`);
  const data = await readApiJson(response, "Anitabi 导入失败");
  const subject = data?.subject || {};
  const points = Array.isArray(data?.points) ? data.points : [];
  return points.map((point: any) => anitabiPointToStop(point, subject)).filter(Boolean) as Stop[];
}

export async function requestAutoRoute(input: {
  stops: Stop[];
  transitLocalDateTime: string;
  transitTimePreference: "departure" | "arrival";
}) {
  const response = await fetch("/api/auto-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await readApiJson(response, "路线规划失败");
  const route = Array.isArray(data?.routes) ? data.routes[0] : null;
  if (!route) {
    throw new Error("路线规划失败（服务端没有返回路线）");
  }
  return route as RoutePlan;
}
