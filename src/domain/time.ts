export const minutesPerDay = 24 * 60;

export function todayInputValue(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isDateInputValue(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeClockValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseClock(value: unknown, fallback = "09:00") {
  const normalized = normalizeClockValue(value) || fallback;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

export function formatClock(totalMinutes: number) {
  const normalized = ((Math.round(totalMinutes) % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function addClockMinutes(value: string | undefined, minutes: number) {
  return formatClock(parseClock(value) + minutes);
}

export function clockDiffMinutes(start?: string, end?: string) {
  const startValue = normalizeClockValue(start);
  const endValue = normalizeClockValue(end);
  if (!startValue || !endValue) return null;
  const diff = parseClock(endValue) - parseClock(startValue);
  return diff >= 0 ? diff : null;
}

export function normalizeStayMinutes(value: unknown, fallback = 5) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return fallback;
  return Math.max(0, Math.min(720, minutes));
}

export function localDateTimeString(tripDate: string, minutes: number) {
  const date = isDateInputValue(tripDate) ? tripDate : todayInputValue();
  return `${date}T${formatClock(minutes)}:00`;
}

export function formatDuration(seconds?: number) {
  if (!seconds || seconds <= 0) return "0 分钟";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  if (!rest) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

export function formatDistance(meters?: number) {
  if (!meters || meters <= 0) return "0 m";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatMoney(value?: number | string) {
  if (value === undefined || value === null || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

export function formatRouteClock(value?: string) {
  if (!value) return "";
  const directMatch = value.match(/T(\d{2}):(\d{2})/);
  if (directMatch) return `${directMatch[1]}:${directMatch[2]}`;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
