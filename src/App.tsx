import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SYMBOLS,
  type Venue,
  type Quote,
  type Row,
  type VenueStatus,
  computeSpreadPct,
  mkEmptyState,
  type SymbolState,
  SignalState,
  type SpreadSample,
  type VenueSnapshot,
} from "./core/types";
import { BinanceFuturesWS } from "./ws/binanceFutures";
import { BybitLinearWS } from "./ws/bybitLinear";
import { OkxSwapWS } from "./ws/okxSwap";
// Bitget handled via backend relay
import { clamp, now, sortRows } from "./core/utils";

type SortField = "signal" | "spread" | "symbol";

type LogEntry = {
  ts: number;
  symbol: string;
  dir: Row["dir"];
  action: string;
  openPct: number;
  closePct: number;
  profitPct: number;
  profitValue: number;
  deposit: number;
  dayStart: number;
  balance: number;
  reason?: string;
  durationMs?: number;
};

const BANNER = String.raw`
███╗   ██╗  ██╗  ██████╗
████╗  ██║ ███║ ██╔════╝
██╔██╗ ██║ ╚██║ ██║     
██║╚██╗██║  ██║ ██║     
██║ ╚████║  ██║ ╚██████╗
╚═╝  ╚═══╝  ╚═╝  ╚═════╝
`;

// Signal + spread logic
const HOT_SPREAD_PCT = 0.15;            // HOT threshold
const STRONG_SPREAD_PCT = 0.22;         // HOT* threshold
const CLOSE_SPREAD_PCT = 0.05;          // collapse/close threshold
const SIGNAL_COOLDOWN_MS = 1500;        // anti-spam state-change cooldown
const BLINK_DURATION_MS = 2500;         // blink duration on event
const STALE_MS = 2000;                  // quote freshness
const OFF_MS = 10000;
const LOG_LIMIT = 200;
const ALERT_THROTTLE_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMA_ALPHA = 0.2;
const SLIPPAGE_BUFFER_PCT = 0.04;         // % buffer
const MIN_NET_EDGE_PCT = 0.06;            // min net edge to signal
const EQUITY_MODE: "fixed" | "compound" = "fixed";
const FIXED_NOTIONAL_USDT = 1000;         // for expected $ edge (fixed mode)
const START_EQUITY_USDT = 1000;
const RISK_PER_TRADE_PCT = 0.2;           // only for compound
const MAX_NOTIONAL_CAP_USDT = 5000;
const TAKER_FEES: Record<Venue, number> = {
  binance: 0.0005,
  bybit: 0.00055,
  okx: 0.0005,
  bitget: 0.0006,
};
const MIN_LIFETIME_MS = 500;
const ENTRY_NET_PCT = 0.06;
const EXIT_NET_PCT = 0.02;
const MAX_HOLD_MS = 30000;
const COOLDOWN_MS = 2000;
const MAX_CONCURRENT_TRADES = 20;
const QUEUE_ENABLED = true;

export default function App() {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_SYMBOLS);
  const [filter, setFilter] = useState("");
  const [minHot, setMinHot] = useState(MIN_NET_EDGE_PCT);
  const [minStrong, setMinStrong] = useState(MIN_NET_EDGE_PCT * 2);
  const [exitSpreadTarget, setExitSpreadTarget] = useState(CLOSE_SPREAD_PCT);
  const [sortBy, setSortBy] = useState<"abs" | "hot">("hot"); // legacy sort
  const [sortField, setSortField] = useState<SortField>("signal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [deposit, setDeposit] = useState<number>(START_EQUITY_USDT);
  const [dayStart, setDayStart] = useState<number>(START_EQUITY_USDT);
  const [dayBase, setDayBase] = useState<number>(START_EQUITY_USDT);
  const [dayKey, setDayKey] = useState<string>(new Date().toDateString());
  const [dayPnl, setDayPnl] = useState<number>(0);
  const depositRef = useRef(deposit);
  const equityRef = useRef<number>(START_EQUITY_USDT);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tgEnabled, setTgEnabled] = useState<boolean>(true);

  const stateRef = useRef<Record<string, SymbolState>>(mkEmptyState(symbols));
  const storeRef = useRef<Record<string, Partial<Record<Venue, VenueSnapshot>>>>(
    Object.fromEntries(symbols.map((s) => [s, {}]))
  );
  const backendSendRef = useRef<WebSocket | null>(null);
  const lastAlertRef = useRef<Record<string, number>>({});
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [selected, setSelected] = useState<string>(DEFAULT_SYMBOLS[0]);
  const [tick, setTick] = useState(0);
  const venueEmaRef = useRef<Partial<Record<Venue, number>>>({});
  const [stats, setStats] = useState<any>(null);
  const [equityPoints, setEquityPoints] = useState<{ t: number; equity: number; dd?: number }[]>([]);
  const symbolLockRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    depositRef.current = deposit;
    setDayBase(deposit);
    setDayStart(deposit);
  }, [deposit]);

  // Keep stateRef aligned with symbols
  useEffect(() => {
    const next = mkEmptyState(symbols);
    for (const s of symbols) {
      const prev = stateRef.current[s];
      if (prev) next[s] = prev;
    }
    stateRef.current = next;

    const nextStore: Record<string, Partial<Record<Venue, VenueSnapshot>>> = Object.fromEntries(symbols.map((s) => [s, {}]));
    for (const s of symbols) {
      const prev = storeRef.current[s];
      if (prev) nextStore[s] = prev;
    }
    storeRef.current = nextStore;

    if (!next[selected]) setSelected(symbols[0] || "");
    setTick((x) => x + 1);
  }, [symbols, selected]);

  function calcPnl(
    dir: Row["dir"],
    entryQuotes: Partial<Record<Venue, Quote>>,
    exitQuotes: Partial<Record<Venue, Quote>>
  ) {
    const d = String(dir || "").toUpperCase();
    const buyVenue = d.includes("BUY_BINANCE") ? "binance" :
      d.includes("BUY_BYBIT") ? "bybit" :
      d.includes("BUY_OKX") ? "okx" :
      d.includes("BUY_BITGET") ? "bitget" : null;
    const sellVenue = d.includes("SELL_BINANCE") ? "binance" :
      d.includes("SELL_BYBIT") ? "bybit" :
      d.includes("SELL_OKX") ? "okx" :
      d.includes("SELL_BITGET") ? "bitget" : null;

    if (!buyVenue || !sellVenue) return { profitValue: Number.NaN, profitPct: Number.NaN };

    const eBuy = entryQuotes[buyVenue];
    const eSell = entryQuotes[sellVenue];
    const xBuy = exitQuotes[buyVenue];
    const xSell = exitQuotes[sellVenue];
    if (!eBuy || !eSell || !xBuy || !xSell) return { profitValue: Number.NaN, profitPct: Number.NaN };
    if (![eBuy.ask, eSell.bid, xBuy.ask, xSell.bid].every(Number.isFinite)) return { profitValue: Number.NaN, profitPct: Number.NaN };

    const openBuy = eBuy.ask;
    const openSell = eSell.bid;
    const closeBuy = xBuy.ask;
    const closeSell = xSell.bid;

    const profit = (closeSell - openBuy) + (openSell - closeBuy);
    const notional = (openBuy + openSell) / 2;
    const profitPct = notional > 0 ? (profit / notional) * 100 : Number.NaN;
    return { profitValue: profit, profitPct };
  }

  function playBeep(freq = 880, durationMs = 120) {
    try {
      const ctx = audioCtxRef.current || new AudioContext();
      audioCtxRef.current = ctx;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.16, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + durationMs / 1000);
    } catch {
      // Audio may be blocked before user interaction; ignore failures
    }
  }

  function pushLog(entry: LogEntry) {
    setLogs((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
  }

  function sendBackend(obj: any) {
    try {
      backendSendRef.current?.send(JSON.stringify(obj));
    } catch {}
  }

  function syncTg(enabled: boolean) {
    sendBackend({ t: "tg_toggle", enabled });
  }

  function toggleTg() {
    const next = !tgEnabled;
    setTgEnabled(next);
    syncTg(next);
  }

  function formatLogLine(l: LogEntry): string {
    const dt = new Date(l.ts);
    const tsTxt = dt.toLocaleTimeString();
    const dirTxt = (() => {
      const d = String(l.dir || "").toUpperCase();
      if (d.includes("BUY_BINANCE") && d.includes("SELL_BYBIT")) return "BUY Binance / SELL Bybit";
      if (d.includes("BUY_BYBIT") && d.includes("SELL_BINANCE")) return "BUY Bybit / SELL Binance";
      if (d.includes("BUY_BINANCE") && d.includes("SELL_OKX")) return "BUY Binance / SELL OKX";
      if (d.includes("BUY_OKX") && d.includes("SELL_BINANCE")) return "BUY OKX / SELL Binance";
      if (d.includes("BUY_BYBIT") && d.includes("SELL_OKX")) return "BUY Bybit / SELL OKX";
      if (d.includes("BUY_OKX") && d.includes("SELL_BYBIT")) return "BUY OKX / SELL Bybit";
      if (d.includes("BUY_BITGET") && d.includes("SELL_BINANCE")) return "BUY Bitget / SELL Binance";
      if (d.includes("BUY_BINANCE") && d.includes("SELL_BITGET")) return "BUY Binance / SELL Bitget";
      if (d.includes("BUY_BITGET") && d.includes("SELL_OKX")) return "BUY Bitget / SELL OKX";
      if (d.includes("BUY_OKX") && d.includes("SELL_BITGET")) return "BUY OKX / SELL Bitget";
      if (d.includes("BUY_BITGET") && d.includes("SELL_BYBIT")) return "BUY Bitget / SELL Bybit";
      if (d.includes("BUY_BYBIT") && d.includes("SELL_BITGET")) return "BUY Bybit / SELL Bitget";
      return d || "-";
    })();

    const openTxt = Number.isFinite(l.openPct) ? l.openPct.toFixed(3) : "-";
    const closeTxt = Number.isFinite(l.closePct) ? l.closePct.toFixed(3) : "-";
    const profitPctTxt = Number.isFinite(l.profitPct) ? l.profitPct.toFixed(3) : "-";
    const profitValTxt = Number.isFinite(l.profitValue) ? l.profitValue.toFixed(2) : "-";
    const balanceTxt = Number.isFinite(l.balance) ? l.balance.toFixed(2) : "-";
    const changeTxt = (Number.isFinite(l.balance) && Number.isFinite(l.dayStart)) ? (l.balance - l.dayStart).toFixed(2) : "-";
    const durTxt = Number.isFinite(l.durationMs) ? ` | dur ${(l.durationMs! / 1000).toFixed(2)}s` : "";
    const reasonTxt = l.reason ? ` | reason ${l.reason}` : "";
    return `${tsTxt} ${l.symbol} | ${dirTxt} | open ${openTxt}% -> close ${closeTxt}% | pnl ${profitPctTxt}% ~= $${profitValTxt} | bal $${balanceTxt} (chg $${changeTxt})${durTxt}${reasonTxt}`;
  }

  function venueStatus(tsLocal?: number): { status: VenueStatus["status"]; ageMs: number } {
    if (!Number.isFinite(tsLocal)) return { status: "OFF", ageMs: Number.POSITIVE_INFINITY };
    const ageMs = now() - (tsLocal as number);
    if (ageMs <= STALE_MS) return { status: "OK", ageMs };
    if (ageMs <= OFF_MS) return { status: "STALE", ageMs };
    return { status: "OFF", ageMs };
  }

  function updateEma(venue: Venue, value: number | undefined | null): number | undefined {
    if (!Number.isFinite(value)) return venueEmaRef.current[venue];
    const v = value as number;
    const prev = venueEmaRef.current[venue];
    const next = prev == null ? v : EMA_ALPHA * v + (1 - EMA_ALPHA) * prev;
    venueEmaRef.current[venue] = next;
    return next;
  }

  function tradeNotional(): number {
    if (EQUITY_MODE === "compound") {
      const eq = equityRef.current;
      const n = Math.min(MAX_NOTIONAL_CAP_USDT, eq * RISK_PER_TRADE_PCT);
      return Math.max(0, n);
    }
    return FIXED_NOTIONAL_USDT;
  }

  function emitAlert(level: "HOT" | "CLOSE", sample: SpreadSample, extra?: any) {
    const key = `${extra?.symbol || "?"}:${sample.buy}->${sample.sell}:${level}`;
    const nowMs = now();
    const last = lastAlertRef.current[key] || 0;
    if (nowMs - last < ALERT_THROTTLE_MS) return;
    lastAlertRef.current[key] = nowMs;

    sendBackend({
      t: "alert",
      level,
      symbol: extra?.symbol,
      from: sample.buy,
      to: sample.sell,
      spread: sample.spreadPct,
      ts: nowMs,
      ...extra,
    });

    playBeep(level === "HOT" ? 980 : 540);
  }

  // Connect WS (Binance Futures + Bybit Linear + OKX direct + Bitget via backend relay)
  useEffect(() => {
    const b = new BinanceFuturesWS(symbols, (sym, q) => onQuote("binance", sym, q));
    const y = new BybitLinearWS(symbols, (sym, q) => onQuote("bybit", sym, q));
    const o = new OkxSwapWS(symbols, (sym, q) => onQuote("okx", sym, q));
    b.connect();
    y.connect();
    o.connect();
    let backendWS: WebSocket | null = null;
    let backendReconnect: number | null = null;
    let backendHeartbeat: number | null = null;
    let backendBackoff = 800;
    let backendIdx = 0;
    let lastBackendMsg = now();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const backendUrls = [
      `${proto}://${window.location.hostname}:8787/ws`,
      `${proto}://localhost:8787/ws`,
      `${proto}://127.0.0.1:8787/ws`,
      `${proto}://192.168.1.2:8787/ws`,
    ];

    const scheduleBackendReconnect = () => {
      if (backendReconnect) return;
      const wait = Math.min(backendBackoff, 15000) * (1 + Math.random() * 0.25);
      backendReconnect = window.setTimeout(() => {
        backendReconnect = null;
        backendBackoff = Math.min(backendBackoff * 1.8, 15000);
        connectBackend();
      }, wait);
    };

    function connectBackend() {
      try { backendWS?.close(); } catch {}
      backendWS = null;
      backendSendRef.current = null;
      const url = backendUrls[backendIdx % backendUrls.length];

      try {
        backendWS = new WebSocket(url);
        backendWS.onopen = () => {
          backendBackoff = 800;
          backendSendRef.current = backendWS;
          backendIdx += 1;
          lastBackendMsg = now();
          syncTg(tgEnabled);
        };
        backendWS.onmessage = (ev) => {
          lastBackendMsg = now();
          try {
            const msg = JSON.parse(ev.data as string);
            if (msg?.t !== "q") return;
            if (msg.v === "bitget") {
              onQuote("bitget", msg.s, {
                bid: Number(msg.bid),
                ask: Number(msg.ask),
                tsMs: Number(msg.ts ?? Date.now()),
                bids: msg.bids,
                asks: msg.asks,
              });
            }
          } catch {}
        };
        backendWS.onclose = () => scheduleBackendReconnect();
        backendWS.onerror = () => {
          try { backendWS?.close(); } catch {}
          scheduleBackendReconnect();
        };
      } catch {
        scheduleBackendReconnect();
      }
    }
    connectBackend();
    backendHeartbeat = window.setInterval(() => {
      if (now() - lastBackendMsg > 15000) {
        try { backendWS?.close(); } catch {}
      }
    }, 5000);

    // poll stats/equity
    const pageProto = window.location.protocol;
    const httpProto = pageProto === "https:" ? "https" : "http";
    const statsUrls = [
      `${httpProto}://${window.location.hostname}:8787/stats`,
      `${httpProto}://localhost:8787/stats`,
      `${httpProto}://127.0.0.1:8787/stats`,
      `${httpProto}://192.168.1.2:8787/stats`,
    ];
    const statsPoll = window.setInterval(async () => {
      for (const url of statsUrls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json();
          if (data?.stats) setStats(data.stats);
          if (Array.isArray(data?.equity)) setEquityPoints(data.equity);
          break;
        } catch {}
      }
    }, 5000);

    // UI refresh ticker (keeps blink + freshness moving)
    const interval = window.setInterval(() => setTick((x) => x + 1), 120);
    const dayInterval = window.setInterval(() => {
      const nowDay = new Date().toDateString();
      if (nowDay !== dayKey) {
        setDayKey(nowDay);
        depositRef.current = dayBase;
        setDeposit(dayBase);
        setDayStart(dayBase);
        setDayPnl(0);
        equityRef.current = dayBase;
      }
    }, 60 * 1000);

    return () => {
      window.clearInterval(interval);
      window.clearInterval(dayInterval);
      if (backendHeartbeat) window.clearInterval(backendHeartbeat);
      if (backendReconnect) window.clearTimeout(backendReconnect);
      window.clearInterval(statsPoll);
      b.close();
      y.close();
      o.close();
      try { backendWS?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join("|"), minHot, minStrong, exitSpreadTarget]);

  function onQuote(venue: Venue, symbol: string, q: Quote) {
    const st = stateRef.current[symbol];
    if (!st) return;

    st.quotes[venue] = q;
    st.lastUpdateMs = now();
    if (!st.store) st.store = {};
    st.store[venue] = { bid: q.bid, ask: q.ask, ts: q.tsMs };
    storeRef.current[symbol] = {
      ...(storeRef.current[symbol] || {}),
      [venue]: { bid: q.bid, ask: q.ask, ts: q.tsMs },
    };

    const qb = st.quotes.binance;
    const qy = st.quotes.bybit;
    const qk = st.quotes.okx;
    const qg = st.quotes.bitget;

    // Compute best spread across all venues (only OK statuses)
    const venues: { name: Venue; q?: Quote; status: VenueStatus["status"]; ageMs: number; emaMs?: number }[] = [
      (() => {
        const v = venueStatus(qb?.tsMs);
        const emaMs = qb?.venueEmaMs ?? updateEma("binance", v.ageMs);
        return { name: "binance" as Venue, q: qb, status: v.status, ageMs: v.ageMs, emaMs };
      })(),
      (() => {
        const v = venueStatus(qy?.tsMs);
        const emaMs = qy?.venueEmaMs ?? updateEma("bybit", v.ageMs);
        return { name: "bybit" as Venue, q: qy, status: v.status, ageMs: v.ageMs, emaMs };
      })(),
      (() => {
        const v = venueStatus(qk?.tsMs);
        const emaMs = qk?.venueEmaMs ?? updateEma("okx", v.ageMs);
        return { name: "okx" as Venue, q: qk, status: v.status, ageMs: v.ageMs, emaMs };
      })(),
      (() => {
        const v = venueStatus(qg?.tsMs);
        const emaMs = qg?.venueEmaMs ?? updateEma("bitget", v.ageMs);
        return { name: "bitget" as Venue, q: qg, status: v.status, ageMs: v.ageMs, emaMs };
      })(),
    ];

    let best: SpreadSample | null = null;
    const t = now();

    // best = min ask vs max bid across venues
    const asks: { venue: Venue; price: number }[] = [];
    const bids: { venue: Venue; price: number }[] = [];
    for (const v of venues) {
      if (v.q && Number.isFinite(v.q.ask) && v.q.ask > 0) asks.push({ venue: v.name, price: v.q.ask });
      if (v.q && Number.isFinite(v.q.bid) && v.q.bid > 0) bids.push({ venue: v.name, price: v.q.bid });
    }
    const bestAsk = asks.sort((a, b) => a.price - b.price)[0];
    const bestBid = bids.sort((a, b) => b.price - a.price)[0];
    if (bestAsk && bestBid && bestAsk.venue !== bestBid.venue) {
      best = {
        buy: bestAsk.venue,
        sell: bestBid.venue,
        spreadPct: computeSpreadPct(bestAsk.price, bestBid.price),
        buyAsk: bestAsk.price,
        sellBid: bestBid.price,
        ts: t,
      };
    }

    if (!best) {
      const asks: { venue: Venue; price: number }[] = [];
      const bids: { venue: Venue; price: number }[] = [];
      for (const v of venues) {
        if (v.q && Number.isFinite(v.q.ask) && v.q.ask > 0) asks.push({ venue: v.name, price: v.q.ask });
        if (v.q && Number.isFinite(v.q.bid) && v.q.bid > 0) bids.push({ venue: v.name, price: v.q.bid });
      }
      const bestAsk = asks.sort((a, b) => a.price - b.price)[0];
      const bestBid = bids.sort((a, b) => b.price - a.price)[0];
      if (bestAsk && bestBid && bestAsk.venue !== bestBid.venue) {
        best = {
          buy: bestAsk.venue,
          sell: bestBid.venue,
          spreadPct: computeSpreadPct(bestAsk.price, bestBid.price),
          buyAsk: bestAsk.price,
          sellBid: bestBid.price,
          ts: t,
        };
      }
    }

    const bestBuyStatus = venues.find((v) => v.name === best?.buy)?.status;
    const bestSellStatus = venues.find((v) => v.name === best?.sell)?.status;
    const bothOk = best && bestBuyStatus === "OK" && bestSellStatus === "OK";

    const closeTrade = (reason: string, currentNet: number) => {
      const ot = st.openTrade;
      if (!ot) return;
      const durationMs = t - ot.openedAt;
      const closeNet = Number.isFinite(currentNet) ? currentNet : EXIT_NET_PCT;
      const pnlPct = Number.isFinite(ot.openNetEdgePct) ? (ot.openNetEdgePct - closeNet) : Number.NaN;
      const pnlUsdt = Number.isFinite(pnlPct) ? (ot.notional * pnlPct) / 100 : Number.NaN;
      const dep = depositRef.current;
      const eqNext = equityRef.current + (Number.isFinite(pnlUsdt) ? pnlUsdt : 0);
      equityRef.current = eqNext;
      const balance = eqNext;
      if (Number.isFinite(pnlUsdt)) setDayPnl((p) => p + pnlUsdt);

      const logEntry: LogEntry = {
        ts: t,
        symbol,
        dir: st.dir,
        action: "CLOSE",
        openPct: ot.openNetEdgePct,
        closePct: closeNet,
        profitPct: pnlPct,
        profitValue: pnlUsdt,
        deposit: dep,
        dayStart,
        balance,
        reason,
        durationMs,
      };
      pushLog(logEntry);
      const fallbackSample: SpreadSample = {
        buy: ot.buyVenue,
        sell: ot.sellVenue,
        spreadPct: closeNet,
        buyAsk: Number.NaN,
        sellBid: Number.NaN,
        ts: t,
      };
      emitAlert("CLOSE", best || fallbackSample, {
        symbol,
        spread_open: ot.openNetEdgePct,
        spread_close: closeNet,
        duration_ms: durationMs,
        virtual_pnl: Number.isFinite(pnlPct) ? `${pnlPct.toFixed(2)}%` : "n/a",
        profit_value: pnlUsdt,
        profit_pct: pnlPct,
        text: formatLogLine(logEntry),
        reason,
      });
      st.openTrade = undefined;
      st.lastCloseMs = t;
      symbolLockRef.current[symbol] = false;
      st.candidate = undefined;
      st.wasHot = false;
      st.signal = SignalState.NEUTRAL;

      sendBackend({
        t: "trade_log",
        journal: {
          id: ot.id,
          ts_open: ot.openedAt,
          ts_close: t,
          duration_ms: durationMs,
          symbol,
          buy: ot.buyVenue,
          sell: ot.sellVenue,
          mode: EQUITY_MODE,
          open_net: ot.openNetEdgePct,
          close_net: closeNet,
          pnl_pct: pnlPct,
          notional_usdt: ot.notional,
          pnl_usdt: pnlUsdt,
          reason,
          equity_after: balance,
        },
        equity: {
          t,
          equity: balance,
        },
      });
    };

    if (!best) {
      st.spreadPct = Number.NaN;
      st.dir = "-";
      st.signal = SignalState.NEUTRAL;
      st.candidate = undefined;
      if (st.openTrade) closeTrade("STALE", Number.NaN);
      return;
    }

    let grossSpread = Number.isFinite(best.spreadPct) ? best.spreadPct : Number.NaN;
    if (!Number.isFinite(grossSpread)) {
      if (Number.isFinite(best.buyAsk) && Number.isFinite(best.sellBid)) {
        grossSpread = computeSpreadPct(best.buyAsk, best.sellBid);
      }
    }
    const feePct = ((TAKER_FEES[best.buy] ?? 0) + (TAKER_FEES[best.sell] ?? 0)) * 100;
    const bufferPct = SLIPPAGE_BUFFER_PCT;
    let netEdgePct = grossSpread - feePct - bufferPct;
    if (!Number.isFinite(netEdgePct)) netEdgePct = grossSpread;
    const netEdgeUSDT = Number.isFinite(netEdgePct) ? (tradeNotional() * netEdgePct) / 100 : Number.NaN;

    st.spreadPct = netEdgePct;
    st.grossSpreadPct = grossSpread;
    st.netEdgePct = netEdgePct;
    st.netEdgeUSDT = netEdgeUSDT;
    st.feesPct = feePct;
    st.bufferPct = bufferPct;
    st.bestBuyVenue = best.buy;
    st.bestSellVenue = best.sell;
    st.dir = `BUY_${best.buy.toUpperCase()}_SELL_${best.sell.toUpperCase()}`;
    st.lastSpreadSample = best;

    const canSignal = t - st.lastSignalMs >= SIGNAL_COOLDOWN_MS;
    const entryOk = Number.isFinite(netEdgePct) && netEdgePct >= ENTRY_NET_PCT && bothOk;
    const cooldownDone = !st.lastCloseMs || t - st.lastCloseMs >= COOLDOWN_MS;
    const activeTrades = Object.values(stateRef.current).filter((s) => !!s.openTrade).length;
    const queueLimitHit = activeTrades >= MAX_CONCURRENT_TRADES;

    // Exit checks for open trade
    if (st.openTrade) {
      const ot = st.openTrade;
      const holdMs = t - ot.openedAt;
      const legStatuses = {
        buy: venues.find((v) => v.name === ot.buyVenue)?.status,
        sell: venues.find((v) => v.name === ot.sellVenue)?.status,
      };
      if (legStatuses.buy !== "OK" || legStatuses.sell !== "OK") {
        closeTrade("STALE", netEdgePct);
      } else if (ot.buyVenue !== best.buy || ot.sellVenue !== best.sell) {
        closeTrade("DIRECTION_CHANGE", netEdgePct);
      } else if (Number.isFinite(netEdgePct) && netEdgePct <= EXIT_NET_PCT) {
        closeTrade("EDGE_COLLAPSE", netEdgePct);
      } else if (holdMs >= MAX_HOLD_MS) {
        closeTrade("TIMEOUT", netEdgePct);
      }
    }

    // Candidate / open logic
    if (entryOk && !st.openTrade && cooldownDone) {
      if (symbolLockRef.current[symbol]) {
        st.candidate = undefined;
        return;
      }
      if (queueLimitHit && QUEUE_ENABLED) {
        st.candidate = undefined;
        return;
      }
      if (!st.candidate || st.candidate.buyVenue !== best.buy || st.candidate.sellVenue !== best.sell) {
        st.candidate = {
          startedAt: t,
          lastSeenAt: t,
          buyVenue: best.buy,
          sellVenue: best.sell,
          netEdgePct,
        };
      } else {
        st.candidate.lastSeenAt = t;
        st.candidate.netEdgePct = netEdgePct;
      }

      const lifetime = t - (st.candidate?.startedAt || t);
      if (lifetime >= MIN_LIFETIME_MS) {
        const id = `${symbol}-${t}`;
        const notional = tradeNotional();
        symbolLockRef.current[symbol] = true;
        st.openTrade = {
          id,
          openedAt: t,
          buyVenue: best.buy,
          sellVenue: best.sell,
          openNetEdgePct: netEdgePct,
          openGrossPct: grossSpread,
          openFeesPct: feePct,
          openBufferPct: bufferPct,
          notional,
        };
        st.candidate = undefined;
        const logEntry: LogEntry = {
          ts: t,
          symbol,
          dir: st.dir,
          action: "OPEN",
          openPct: netEdgePct,
          closePct: Number.NaN,
          profitPct: Number.NaN,
          profitValue: Number.NaN,
          deposit: depositRef.current,
          dayStart,
          balance: equityRef.current,
        };
        pushLog(logEntry);
      }
    } else if (!entryOk) {
      st.candidate = undefined;
    }

    // Signal coloring based on net edge
    const isHot = Number.isFinite(netEdgePct) && netEdgePct >= minHot;
    const isStrong = Number.isFinite(netEdgePct) && netEdgePct >= minStrong;

    if (isHot) {
      const nextSig = isStrong ? SignalState.HOT_STRONG : SignalState.HOT;
      st.wasHot = true;
      st.signal = nextSig;
      if (canSignal && st.lastSignalKind !== nextSig) {
        st.lastSignalKind = nextSig;
        st.lastSignalMs = t;
        st.blinkUntilMs = t + BLINK_DURATION_MS;
      }
    } else {
      st.signal = SignalState.NEUTRAL;
    }
  }

  const rows: Row[] = useMemo(() => {
    const t = now();
    const out: Row[] = [];

    for (const [symbol, st] of Object.entries(stateRef.current)) {
      const qb = st.quotes.binance;
      const qy = st.quotes.bybit;
      const qk = st.quotes.okx;
      const qg = st.quotes.bitget;

      const activeTrades = Object.values(stateRef.current).filter((s) => !!s.openTrade).length;
      const queueLimitHit = activeTrades >= MAX_CONCURRENT_TRADES && QUEUE_ENABLED;
      const stateKind: "IDLE" | "CANDIDATE" | "OPEN" =
        st.openTrade ? "OPEN" :
        st.candidate ? "CANDIDATE" : "IDLE";
      const stateLabel = (() => {
        if (st.openTrade) {
          const age = Math.max(0, t - st.openTrade.openedAt);
          return `OPEN ${(age / 1000).toFixed(1)}s`;
        }
        if (st.candidate) {
          const age = Math.max(0, t - st.candidate.startedAt);
          return queueLimitHit ? "QUEUE" : `CAND ${age.toFixed(0)}ms`;
        }
        if (queueLimitHit) return "QUEUE";
        return "IDLE";
      })();

      out.push({
        symbol,
        dir: st.dir,
        spreadPct: st.netEdgePct ?? st.spreadPct,
        grossSpreadPct: st.grossSpreadPct,
        netEdgePct: st.netEdgePct,
        netEdgeUSDT: st.netEdgeUSDT,
        feesPct: st.feesPct,
        bufferPct: st.bufferPct,
        bestBuyVenue: st.bestBuyVenue,
        bestSellVenue: st.bestSellVenue,
        stateKind,
        stateLabel,
        signal: st.signal,
        blink: st.blinkUntilMs > t,
        binance: qb,
        bybit: qy,
        okx: qk,
        bitget: qg,
        venues: {
          binance: (() => {
            const v = venueStatus(qb?.tsMs);
            const emaMs = qb?.venueEmaMs ?? updateEma("binance", v.ageMs);
            return { status: v.status, ageMs: v.ageMs, emaMs: emaMs != null ? Math.round(emaMs) : undefined };
          })(),
          bybit: (() => {
            const v = venueStatus(qy?.tsMs);
            const emaMs = qy?.venueEmaMs ?? updateEma("bybit", v.ageMs);
            return { status: v.status, ageMs: v.ageMs, emaMs: emaMs != null ? Math.round(emaMs) : undefined };
          })(),
          okx: (() => {
            const v = venueStatus(qk?.tsMs);
            const emaMs = qk?.venueEmaMs ?? updateEma("okx", v.ageMs);
            return { status: v.status, ageMs: v.ageMs, emaMs: emaMs != null ? Math.round(emaMs) : undefined };
          })(),
          bitget: (() => {
            const v = venueStatus(qg?.tsMs);
            const emaMs = qg?.venueEmaMs ?? updateEma("bitget", v.ageMs);
            return { status: v.status, ageMs: v.ageMs, emaMs: emaMs != null ? Math.round(emaMs) : undefined };
          })(),
        },
      });
    }

    const baseSorted = sortRows(out, sortBy);

    const ranked = baseSorted.slice().sort((a, b) => {
      const dirMul = sortDir === "asc" ? 1 : -1;
      if (sortField === "symbol") return dirMul * a.symbol.localeCompare(b.symbol);
      if (sortField === "spread") {
        const sa = Number.isFinite(a.spreadPct) ? a.spreadPct : -1e9;
        const sb = Number.isFinite(b.spreadPct) ? b.spreadPct : -1e9;
        return dirMul * (sa - sb);
      }
      // signal (ranked)
      const rank = (s: SignalState) =>
        s === SignalState.HOT_STRONG ? 3 :
        s === SignalState.HOT ? 2 :
        s === SignalState.CLOSE ? 1 : 0;
      const ra = rank(a.signal);
      const rb = rank(b.signal);
      if (ra !== rb) return dirMul * (ra - rb);
      const sa = Number.isFinite(a.spreadPct) ? a.spreadPct : -1e9;
      const sb = Number.isFinite(b.spreadPct) ? b.spreadPct : -1e9;
      return dirMul * (sa - sb);
    });

    return ranked;
  }, [sortBy, sortField, sortDir, tick]);

  const filtered = useMemo(() => {
    const f = filter.trim().toUpperCase();
    if (!f) return rows;
    return rows.filter((r) => r.symbol.includes(f));
  }, [rows, filter]);

  const logLines = useMemo(() => logs.map((l) => {
    return formatLogLine(l);
  }), [logs]);

  function toggleSort(field: SortField) {
    setSortField((prevField) => {
      if (prevField === field) {
        setSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
        return prevField;
      }
      setSortDir(field === "symbol" ? "asc" : "desc");
      return field;
    });
  }

  return (
    <div className="shell">
      <div className="term">
        <div className="term-bar">
          <span className="dot red" /> <span className="dot yellow" /> <span className="dot green" />
          <span className="term-title">perp-arb@localhost</span>
        </div>

        <div className="term-body">
          <pre className="banner">{BANNER}</pre>
          <div className="status-line">
            [{symbols.length} symbols] [HOT≥{minHot.toFixed(2)}%] [STRONG≥{minStrong.toFixed(2)}%] [EXIT≤{exitSpreadTarget.toFixed(2)}%] [sort={sortBy}]
          </div>

          <div className="controls-line">
            <label className="prompt">
              filter&gt;
              <input
                className="prompt-input"
                placeholder="BTCUSDT"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>

            <label className="prompt">
              sort&gt;
              <select className="prompt-input" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
                <option value="hot">signal→spread</option>
                <option value="abs">spread(abs)</option>
              </select>
            </label>

            <label className="prompt">
              HOT%&gt;
              <input
                className="prompt-input"
                type="number"
                step="0.01"
                value={minHot}
                onChange={(e) => setMinHot(clamp(Number(e.target.value), 0, 10))}
              />
            </label>
            <label className="prompt">
              STRONG%&gt;
              <input
                className="prompt-input"
                type="number"
                step="0.01"
                value={minStrong}
                onChange={(e) => setMinStrong(clamp(Number(e.target.value), 0, 10))}
              />
            </label>
            <label className="prompt">
              EXIT%&gt;
              <input
                className="prompt-input"
                type="number"
                step="0.01"
                value={exitSpreadTarget}
                onChange={(e) => setExitSpreadTarget(clamp(Number(e.target.value), 0, 10))}
              />
            </label>
            <label className="prompt">
              deposit&gt;
              <input
                className="prompt-input"
                type="number"
                step="10"
                value={deposit}
                onChange={(e) => setDeposit(Math.max(0, Number(e.target.value)))}
              />
            </label>
            <button
              className={`pill ${tgEnabled ? "ok" : "bad"}`}
              style={{ marginLeft: 8 }}
              onClick={toggleTg}
              type="button"
              title="Toggle Telegram alerts"
            >
              TG {tgEnabled ? "ON" : "OFF"}
            </button>
          </div>

          <div className="grid">
            <div className="mainCol">
              <div className="table">
                <div className="thead">
                  <div className="th" onClick={() => toggleSort("symbol")} style={{ minWidth: 90 }}>Symbol</div>
                  <div className="th" onClick={() => toggleSort("signal")} style={{ minWidth: 70 }}>Signal</div>
                  <div className="th" style={{ minWidth: 140 }}>State</div>
                  <div className="th" onClick={() => toggleSort("spread")} style={{ minWidth: 180 }}>Net / Spread %</div>
                  <div className="th" style={{ minWidth: 150 }}>Direction</div>
                  <div className="th" style={{ minWidth: 150 }}>Binance Perp (bid / ask)</div>
                  <div className="th" style={{ minWidth: 150 }}>Bybit Perp (bid / ask)</div>
                  <div className="th" style={{ minWidth: 150 }}>OKX Perp (bid / ask)</div>
                  <div className="th" style={{ minWidth: 130 }}>Status</div>
                </div>

                {filtered.map((r) => (
                  <RowView key={r.symbol} row={r} onSelect={() => setSelected(r.symbol)} selected={selected === r.symbol} />
                ))}
              </div>

              <DepthPanel symbol={selected} state={stateRef.current[selected]} />
            </div>

            <aside className="sidebar">
              <div className="card">
                <div className="cardTitle">Equity</div>
                <EquityChart points={equityPoints} />
                <div className="mono small muted">
                  mode {EQUITY_MODE}, start ${START_EQUITY_USDT}, risk {RISK_PER_TRADE_PCT * 100}% {EQUITY_MODE === "fixed" ? `(fixed $${FIXED_NOTIONAL_USDT})` : ""}
                </div>
              </div>

              <div className="card">
                <div className="cardTitle">KPI</div>
                <div className="mono small">
                  {stats ? (
                    <>
                      <div>trades {stats.trades} | win {stats.win_rate?.toFixed?.(1) ?? "-"}%</div>
                      <div>avg pnl {stats.avg_pnl?.toFixed?.(2) ?? "-"} | pf {stats.profit_factor?.toFixed?.(2) ?? "-"}</div>
                      <div>eq {stats.equity_start ?? "-"} → {stats.equity_now ?? "-"}</div>
                      <div>max DD {stats.max_dd?.toFixed?.(2) ?? "-"}%</div>
                    </>
                  ) : "- loading stats -"}
                </div>
              </div>

              <div className="card">
                <div className="cardTitle">Symbols</div>
                <textarea
                  className="textarea"
                  spellCheck={false}
                  value={symbols.join("\n")}
                  onChange={(e) =>
                    setSymbols(
                      e.target.value
                        .split("\n")
                        .map((s) => s.trim().toUpperCase())
                        .filter(Boolean)
                    )
                  }
                />
                <div className="hint">
                  One symbol per line. USDT perps only. Keep 20-200.
                </div>
              </div>

              <div className="card">
                <div className="cardTitle">Legend</div>
                <div className="mono small">
                  HOT = net edge ≥ HOT% (yellow)<br />
                  HOT* = net edge ≥ STRONG% (orange)<br />
                  EXIT = net edge ≤ EXIT% after HOT (green)<br />
                  Blink on event ~2.5s
                </div>
              </div>

              <div className="card">
                <div className="cardTitle">Log</div>
                <div className="logList mono small">
                  {logLines.length === 0 ? "- no events yet -" : logLines.map((line, i) => (
                    <div key={i} className="logLine">{line}</div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

function RowView({ row, onSelect, selected }: { row: Row; onSelect: () => void; selected: boolean }) {
  const fmt = (v: any, d = 3) => Number.isFinite(v) ? Number(v).toFixed(d) : "-";
  const deriveFromQuotes = () => {
    const quotes: { venue: Venue; bid?: number; ask?: number }[] = [];
    if (row.binance) quotes.push({ venue: "binance", bid: row.binance.bid, ask: row.binance.ask });
    if (row.bybit) quotes.push({ venue: "bybit", bid: row.bybit.bid, ask: row.bybit.ask });
    if (row.okx) quotes.push({ venue: "okx", bid: row.okx.bid, ask: row.okx.ask });
    if (row.bitget) quotes.push({ venue: "bitget", bid: row.bitget.bid, ask: row.bitget.ask });
    const asks = quotes.filter((q) => Number.isFinite(q.ask) && (q.ask as number) > 0)
      .map((q) => ({ venue: q.venue, price: q.ask as number }));
    const bids = quotes.filter((q) => Number.isFinite(q.bid) && (q.bid as number) > 0)
      .map((q) => ({ venue: q.venue, price: q.bid as number }));
    const bestAsk = asks.sort((a, b) => a.price - b.price)[0];
    const bestBid = bids.sort((a, b) => b.price - a.price)[0];
    if (!bestAsk || !bestBid || bestAsk.venue === bestBid.venue) return null;
    const gross = computeSpreadPct(bestAsk.price, bestBid.price);
    const fee = ((TAKER_FEES[bestAsk.venue] ?? 0) + (TAKER_FEES[bestBid.venue] ?? 0)) * 100;
    const buffer = SLIPPAGE_BUFFER_PCT;
    const net = gross - fee - buffer;
    const netUsd = Number.isFinite(net) ? (FIXED_NOTIONAL_USDT * net) / 100 : Number.NaN;
    return { gross, fee, buffer, net, netUsd };
  };

  const fallback = deriveFromQuotes();
  const netVal = Number.isFinite(row.netEdgePct)
    ? row.netEdgePct
    : Number.isFinite(fallback?.net) ? fallback?.net! : (Number.isFinite(row.spreadPct) ? row.spreadPct : Number.NaN);
  const grossVal = Number.isFinite(row.grossSpreadPct) ? row.grossSpreadPct
    : Number.isFinite(fallback?.gross) ? fallback?.gross! : Number.NaN;
  const feeVal = Number.isFinite(row.feesPct) ? row.feesPct
    : Number.isFinite(fallback?.fee) ? fallback?.fee! : Number.NaN;
  const bufVal = Number.isFinite(row.bufferPct) ? row.bufferPct
    : Number.isFinite(fallback?.buffer) ? fallback?.buffer! : Number.NaN;
  const netUsdVal = Number.isFinite(row.netEdgeUSDT) ? row.netEdgeUSDT
    : Number.isFinite(fallback?.netUsd) ? fallback?.netUsd! : Number.NaN;

  const netTxt = fmt(netVal, 3);
  const grossTxt = fmt(grossVal, 3);
  const feeTxt = fmt(feeVal, 3);
  const bufTxt = fmt(bufVal, 3);
  const netUsdTxt = fmt(netUsdVal, 2);
  const stateTxt = row.stateLabel || "IDLE";

  const dirTxt = (() => {
    const d = String(row.dir || "").toUpperCase();
    if (d.includes("BUY_BINANCE") && d.includes("SELL_BYBIT")) return "Buy Binance / Sell Bybit";
    if (d.includes("BUY_BYBIT") && d.includes("SELL_BINANCE")) return "Buy Bybit / Sell Binance";
    if (d.includes("BUY_BINANCE") && d.includes("SELL_OKX")) return "Buy Binance / Sell OKX";
    if (d.includes("BUY_OKX") && d.includes("SELL_BINANCE")) return "Buy OKX / Sell Binance";
    if (d.includes("BUY_BYBIT") && d.includes("SELL_OKX")) return "Buy Bybit / Sell OKX";
    if (d.includes("BUY_OKX") && d.includes("SELL_BYBIT")) return "Buy OKX / Sell Bybit";
    if (d.includes("BUY_BITGET") && d.includes("SELL_BINANCE")) return "Buy Bitget / Sell Binance";
    if (d.includes("BUY_BINANCE") && d.includes("SELL_BITGET")) return "Buy Binance / Sell Bitget";
    if (d.includes("BUY_BITGET") && d.includes("SELL_OKX")) return "Buy Bitget / Sell OKX";
    if (d.includes("BUY_OKX") && d.includes("SELL_BITGET")) return "Buy OKX / Sell Bitget";
    if (d.includes("BUY_BITGET") && d.includes("SELL_BYBIT")) return "Buy Bitget / Sell Bybit";
    if (d.includes("BUY_BYBIT") && d.includes("SELL_BITGET")) return "Buy Bybit / Sell Bitget";
    return "-";
  })();

  const signalTxt =
    row.signal === SignalState.HOT_STRONG ? "HOT*" :
    row.signal === SignalState.HOT ? "HOT" :
    row.signal === SignalState.CLOSE ? "CLOSE" :
    "-";

  const cls =
    "trow " +
    (row.signal === SignalState.HOT_STRONG ? "hot strong " : "") +
    (row.signal === SignalState.HOT ? "hot " : "") +
    (row.signal === SignalState.CLOSE ? "close " : "") +
    (row.blink ? "blink " : "");

  const b = row.binance;
  const y = row.bybit;
  const k = row.okx;
  const g = row.bitget;

  const bTxt = b ? `${b.bid.toFixed(2)} / ${b.ask.toFixed(2)}` : "-";
  const yTxt = y ? `${y.bid.toFixed(2)} / ${y.ask.toFixed(2)}` : "-";
  const kTxt = k ? `${k.bid.toFixed(2)} / ${k.ask.toFixed(2)}` : "-";
  const gTxt = g ? `${g.bid.toFixed(2)} / ${g.ask.toFixed(2)}` : "-";

  const pillCls = (status?: string) =>
    status === "OK" ? "pill ok" :
    status === "STALE" ? "pill warn" :
    "pill bad";

  const pillTitle = (v?: VenueStatus) => {
    if (!v) return "no data";
    const emaTxt = v.emaMs != null ? `, ema ${v.emaMs}ms` : "";
    const ageTxt = Number.isFinite(v.ageMs) ? `${Math.round(v.ageMs)}ms` : "n/a";
    return `${v.status} (${ageTxt}${emaTxt})`;
  };

  return (
    <div className={cls + (selected ? " selected" : "") + " trow"} onClick={onSelect} role="button">
      <div className="sym">{row.symbol}</div>
      <div className="sig">{signalTxt}</div>
      <div className="dir">{stateTxt}</div>
      <div
        className="spr mono"
        title={`net ${netTxt}% (~$${netUsdTxt}) | gross ${grossTxt}% | fees ${feeTxt}% | buf ${bufTxt}%`}
        style={{ paddingTop: 4, minWidth: 180 }}
      >
        <div>net {netTxt}% {Number.isFinite(row.netEdgeUSDT) ? `(~$${netUsdTxt})` : ""}</div>
        <div className="mono small muted" style={{ color: "var(--muted)", opacity: 0.6 }}>
          g {grossTxt}% | fee {feeTxt}%
        </div>
        <div className="mono small muted" style={{ color: "var(--muted)", opacity: 0.6 }}>
          buf {bufTxt}%
        </div>
      </div>
      <div className="dir">{dirTxt}</div>
      <div className="venue">{bTxt}</div>
      <div className="venue">{yTxt}</div>
      <div className="venue">{kTxt}</div>
      <div className="st">
        <span className={pillCls(row.venues?.binance?.status)} title={pillTitle(row.venues?.binance)}>Bin</span>
        <span className={pillCls(row.venues?.bybit?.status)} title={pillTitle(row.venues?.bybit)}>Byb</span>
        <span className={pillCls(row.venues?.okx?.status)} title={pillTitle(row.venues?.okx)}>OKX</span>
      </div>
    </div>
  );
}

function DepthPanel({ symbol, state }: { symbol?: string; state?: SymbolState }) {
  if (!symbol || !state) return null;

  const books: { title: string; q?: Quote }[] = [
    { title: "Binance", q: state.quotes.binance },
    { title: "Bybit", q: state.quotes.bybit },
    { title: "OKX", q: state.quotes.okx },
    { title: "Bitget", q: state.quotes.bitget },
  ];

  const renderBook = (title: string, q?: Quote) => {
    const bids = q?.bids || [];
    const asks = q?.asks || [];

    return (
      <div className="card depthCard">
        <div className="cardTitle">{title}</div>
        {(!q || bids.length === 0 || asks.length === 0) ? (
          <div className="mono small muted">waiting for depth…</div>
        ) : (
          <div className="depthGrid mono">
            <div>
              {asks.slice(0).reverse().map((l, i) => (
                <div key={`a${i}`} className="depthRow ask">
                  <span>{l.price}</span>
                  <span>{l.qty}</span>
                </div>
              ))}
            </div>
            <div>
              {bids.map((l, i) => (
                <div key={`b${i}`} className="depthRow bid">
                  <span>{l.price}</span>
                  <span>{l.qty}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="depthWrapper">
      <div className="depthTitle">L2 snapshot: {symbol}</div>
      <div className="depthCols">
        {books.map((b) => (
          <React.Fragment key={b.title}>{renderBook(b.title, b.q)}</React.Fragment>
        ))}
      </div>
    </div>
  );
}

function EquityChart({ points }: { points: { t: number; equity: number; dd?: number }[] }) {
  if (!points || points.length < 2) return <div className="mono small muted">- no equity data yet -</div>;
  const width = 280;
  const height = 120;
  const lastPoints = points.slice(-300);
  const equities = lastPoints.map((p) => p.equity);
  const minEq = Math.min(...equities);
  const maxEq = Math.max(...equities);
  const range = maxEq - minEq || 1;
  const path = lastPoints.map((p, i) => {
    const x = (i / (lastPoints.length - 1)) * width;
    const y = height - ((p.equity - minEq) / range) * height;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = lastPoints[lastPoints.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke="#33e7ff" strokeWidth="2" />
      <text x="4" y="12" fill="#9df7c4" fontSize="10">eq {last.equity.toFixed(2)}</text>
      <text x="4" y="24" fill="#ffb86c" fontSize="10">dd {last.dd?.toFixed?.(2) ?? "-" }%</text>
    </svg>
  );
}
