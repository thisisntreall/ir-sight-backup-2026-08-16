export type ActivityEntry = {
  id: string;
  at: number;
  peak: number;
  sources: number;
  facing: "user" | "environment";
  thumb: string;
  event?: string;
  threshold?: number;
  spots?: string;
  note?: string;
  extra?: string;
};

const KEY = "ir-sight-log-v3";
const MAX = 80;

export function loadActivityLog(): ActivityEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      localStorage.getItem(KEY) ??
      localStorage.getItem("ir-sight-log-v2") ??
      localStorage.getItem("ir-sight-log-v1");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.id === "string");
  } catch {
    return [];
  }
}

export function saveActivityLog(entries: ActivityEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    try {
      const slim = entries.slice(0, 20).map((e, i) => (i < 8 ? e : { ...e, thumb: "" }));
      localStorage.setItem(KEY, JSON.stringify(slim));
    } catch {
      /* give up */
    }
  }
}

export function formatLogTime(at: number) {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function regionLabel(spots: { x: number; y: number }[]) {
  if (!spots.length) return "";
  const x = spots.reduce((s, p) => s + p.x, 0) / spots.length;
  const y = spots.reduce((s, p) => s + p.y, 0) / spots.length;
  const lr = x < 0.33 ? "left" : x > 0.66 ? "right" : "center";
  const tb = y < 0.33 ? "top" : y > 0.66 ? "bottom" : "mid";
  return `${tb}-${lr}`;
}

export function formatSpots(spots: { x: number; y: number; r?: number; score: number }[]) {
  return spots
    .slice(0, 8)
    .map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}@${Math.round(s.score)}r${Math.round(s.r ?? 0)}`)
    .join(";");
}

export function formatEntryLine(e: ActivityEntry) {
  return [
    new Date(e.at).toISOString(),
    "hit",
    e.event ?? "-",
    `peak=${e.peak}`,
    `sources=${e.sources}`,
    `facing=${e.facing}`,
    `thr=${e.threshold ?? ""}`,
    `spots=${e.spots ?? ""}`,
    e.note ?? "",
    e.extra ?? "",
  ].join("\t");
}
