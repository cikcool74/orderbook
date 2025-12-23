import type { Row } from "./types";
import { SignalState } from "./types";

export const now = () => Date.now();

export function clamp(n: number, a: number, b: number) {
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function signalRank(s: SignalState): number {
  // higher = more important
  if (s === SignalState.HOT_STRONG) return 3;
  if (s === SignalState.HOT) return 2;
  if (s === SignalState.CLOSE) return 1;
  return 0;
}

export function sortRows(rows: Row[], mode: "abs" | "hot") {
  const copy = rows.slice();
  copy.sort((a, b) => {
    if (mode === "hot") {
      const ra = signalRank(a.signal);
      const rb = signalRank(b.signal);
      if (rb !== ra) return rb - ra;

      const sa = Number.isFinite(a.spreadPct) ? a.spreadPct : -1e9;
      const sb = Number.isFinite(b.spreadPct) ? b.spreadPct : -1e9;
      return sb - sa;
    } else {
      const aa = Number.isFinite(a.spreadPct) ? Math.abs(a.spreadPct) : -1e9;
      const ab = Number.isFinite(b.spreadPct) ? Math.abs(b.spreadPct) : -1e9;
      return ab - aa;
    }
  });
  return copy;
}
