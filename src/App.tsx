import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SYMBOLS,
  type Venue,
  type Quote,
  type Row,
  computeSpreadPct,
  mkEmptyState,
  type SymbolState,
  SignalState,
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
const DEFAULT_HOT_OPEN_PCT = 0.08;     // HOT threshold
const DEFAULT_HOT_STRONG_PCT = 0.15;   // HOT* threshold
const DEFAULT_CLOSE_PCT = 0.02;        // collapse threshold
const DEFAULT_CLOSE_SPREAD_PCT = 0.02; // explicit spread target to exit
const SIGNAL_COOLDOWN_MS = 1500;       // anti-spam state-change cooldown
const BLINK_DURATION_MS = 2500;        // blink duration on event
const STALE_MS = 5000;                 // quote freshness
const LOG_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export default function App() {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_SYMBOLS);
  const [filter, setFilter] = useState("");
  const [minHot, setMinHot] = useState(DEFAULT_HOT_OPEN_PCT);
  const [minStrong, setMinStrong] = useState(DEFAULT_HOT_STRONG_PCT);
  const [exitSpreadTarget, setExitSpreadTarget] = useState(DEFAULT_CLOSE_SPREAD_PCT);
  const [sortBy, setSortBy] = useState<"abs" | "hot">("hot"); // legacy sort
  const [sortField, setSortField] = useState<SortField>("signal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [deposit, setDeposit] = useState<number>(1000);
  const [dayStart, setDayStart] = useState<number>(1000);
  const [dayBase, setDayBase] = useState<number>(1000);
  const [dayKey, setDayKey] = useState<string>(new Date().toDateString());
  const [dayPnl, setDayPnl] = useState<number>(0);
  const depositRef = useRef(deposit);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const stateRef = useRef<Record<string, SymbolState>>(mkEmptyState(symbols));
  const [selected, setSelected] = useState<string>(DEFAULT_SYMBOLS[0]);
  const [tick, setTick] = useState(0);

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

  // Connect WS (Binance Futures + Bybit Linear + OKX direct + Bitget via backend relay)
  useEffect(() => {
    const b = new BinanceFuturesWS(symbols, (sym, q) => onQuote("binance", sym, q));
    const y = new BybitLinearWS(symbols, (sym, q) => onQuote("bybit", sym, q));
    const o = new OkxSwapWS(symbols, (sym, q) => onQuote("okx", sym, q));
    b.connect();
    y.connect();
    o.connect();
    let backendWS: WebSocket | null = null;

    function connectBackend() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const urls = [
        `${proto}://${window.location.hostname}:8787/ws`,
        `${proto}://localhost:8787/ws`,
      ];
      let idx = 0;
      const tryConnect = () => {
        const url = urls[idx % urls.length];
        try {
          backendWS = new WebSocket(url);
          backendWS.onmessage = (ev) => {
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
          backendWS.onclose = () => {
            idx += 1;
            setTimeout(tryConnect, 1500);
          };
          backendWS.onerror = () => {
            try { backendWS?.close(); } catch {}
          };
        } catch {
          idx += 1;
          setTimeout(tryConnect, 1500);
        }
      };
      tryConnect();
    }
    connectBackend();

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
      }
    }, 60 * 1000);

    return () => {
      window.clearInterval(interval);
      window.clearInterval(dayInterval);
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

    const qb = st.quotes.binance;
    const qy = st.quotes.bybit;
    const qk = st.quotes.okx;
    const qg = st.quotes.bitget;

    // Compute best spread across all venues
    const venues: { name: Venue; q?: Quote }[] = [
      { name: "binance", q: qb },
      { name: "bybit", q: qy },
      { name: "okx", q: qk },
      { name: "bitget", q: qg },
    ];

    let best = Number.NEGATIVE_INFINITY;
    let bestDir = "--";
    let bestBuy: Quote | undefined;
    let bestSell: Quote | undefined;
    let bestBuyName: Venue | null = null;
    let bestSellName: Venue | null = null;

    for (const buy of venues) {
      if (!buy.q || !buy.q.ask) continue;
      for (const sell of venues) {
        if (!sell.q || !sell.q.bid) continue;
        if (buy.name === sell.name) continue;
        const spread = computeSpreadPct(buy.q.ask, sell.q.bid);
        if (Number.isFinite(spread) && spread > best) {
          best = spread;
          bestBuy = buy.q;
          bestSell = sell.q;
          bestBuyName = buy.name;
          bestSellName = sell.name;
          bestDir = `BUY_${buy.name.toUpperCase()}_SELL_${sell.name.toUpperCase()}`;
        }
      }
    }

    if (bestBuy && bestSell && bestBuyName && bestSellName) {
      st.spreadPct = best;
      st.dir = bestDir;

      // HOT/CLOSE state machine
      const t = now();
      const canSignal = t - st.lastSignalMs >= SIGNAL_COOLDOWN_MS;

      const isHot = best >= minHot;
      const isStrong = best >= minStrong;

      if (isHot) {
        const nextSig = isStrong ? SignalState.HOT_STRONG : SignalState.HOT;
        const enteringHot = st.signal !== nextSig || !st.wasHot;

        st.wasHot = true;
        st.signal = nextSig;
        if (enteringHot) {
          st.lastHotSpread = best;
          st.lastHotTs = t;
          st.entry = {
            dir: bestDir,
            buyVenue: bestBuyName,
            sellVenue: bestSellName,
            quotes: { binance: qb, bybit: qy, okx: qk, bitget: qg },
          };
          const dep = depositRef.current;
          const balance = dayStart + dayPnl;
          setLogs((prev) => [
            {
              ts: t,
              symbol,
              dir: bestDir,
              action: "OPEN",
              openPct: best,
              closePct: Number.NaN,
              profitPct: Number.NaN,
              profitValue: Number.NaN,
              deposit: dep,
              dayStart,
              balance,
            },
            ...prev,
          ].slice(0, LOG_LIMIT));
        }

        // event on transition
        if (canSignal && st.lastSignalKind !== nextSig) {
          st.lastSignalKind = nextSig;
          st.lastSignalMs = t;
          st.blinkUntilMs = t + BLINK_DURATION_MS;
        }
      } else {
        // collapse only after being hot
        if (st.wasHot && best <= exitSpreadTarget) {
          st.wasHot = false;
          st.signal = SignalState.CLOSE;

          if (canSignal && st.lastSignalKind !== SignalState.CLOSE) {
            st.lastSignalKind = SignalState.CLOSE;
            st.lastSignalMs = t;
            st.blinkUntilMs = t + BLINK_DURATION_MS;
          }

          // log hypothetical result
          const openSpread = Number.isFinite(st.lastHotSpread) ? st.lastHotSpread : best;
          const closeSpread = best;
          const dep = depositRef.current;

          const exitQuotes: Partial<Record<Venue, Quote>> = { binance: qb, bybit: qy, okx: qk, bitget: qg };
          const { profitPct } = st.entry
            ? calcPnl(st.entry.dir, st.entry.quotes, exitQuotes)
            : { profitPct: closeSpread, profitValue: Number.NaN };
          const profitValue = Number.isFinite(profitPct) ? (dep * profitPct) / 100 : Number.NaN;
          const delta = Number.isFinite(profitValue) ? profitValue : 0;
          const balance = dayStart + dayPnl + delta;
          setDayPnl((p) => p + delta);

          setLogs((prev) => [
            {
              ts: t,
              symbol,
              dir: st.entry?.dir || st.dir,
              action: "CLOSE",
              openPct: openSpread,
              closePct: closeSpread,
              profitPct,
              profitValue: Number.isFinite(profitValue) ? profitValue : Number.NaN,
              deposit: dep,
              dayStart,
              balance,
            },
            ...prev,
          ].slice(0, LOG_LIMIT));

          st.lastHotSpread = Number.NaN;
          st.lastHotTs = 0;
          st.entry = undefined;
        } else {
          st.signal = SignalState.NEUTRAL;
        }
      }
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

      const liveB = !!(qb && t - qb.tsMs < STALE_MS);
      const liveY = !!(qy && t - qy.tsMs < STALE_MS);
      const liveOkx = !!(qk && t - qk.tsMs < STALE_MS);
      const liveBitget = !!(qg && t - qg.tsMs < STALE_MS);

      out.push({
        symbol,
        dir: st.dir,
        spreadPct: st.spreadPct,
        signal: st.signal,
        blink: st.blinkUntilMs > t,
        binance: qb,
        bybit: qy,
        okx: qk,
        bitget: qg,
        liveB,
        liveY,
        liveOkx,
        liveBitget,
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
    return `${tsTxt} ${l.symbol} | ${dirTxt} | open ${openTxt}% -> close ${closeTxt}% | pnl ${profitPctTxt}% ~= $${profitValTxt} | bal $${balanceTxt} (chg $${changeTxt})`;
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
          </div>

          <div className="grid">
            <div className="mainCol">
              <div className="table">
                <div className="thead">
                  <div className="th" onClick={() => toggleSort("symbol")}>Symbol</div>
                  <div className="th" onClick={() => toggleSort("signal")}>Signal</div>
                  <div className="th" onClick={() => toggleSort("spread")}>Spread%</div>
                  <div className="th">Direction</div>
                  <div className="th">Binance Perp (bid / ask)</div>
                  <div className="th">Bybit Perp (bid / ask)</div>
                  <div className="th">OKX Perp (bid / ask)</div>
                  <div className="th">Bitget Perp (bid / ask)</div>
                  <div className="th">Status</div>
                </div>

                {filtered.map((r) => (
                  <RowView key={r.symbol} row={r} onSelect={() => setSelected(r.symbol)} selected={selected === r.symbol} />
                ))}
              </div>

              <DepthPanel symbol={selected} state={stateRef.current[selected]} />
            </div>

            <aside className="sidebar">
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
                  HOT = spread ≥ HOT% (yellow)<br />
                  HOT* = spread ≥ STRONG% (orange)<br />
                  EXIT = spread ≤ EXIT% after HOT (green)<br />
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
  const spreadTxt = Number.isFinite(row.spreadPct) ? row.spreadPct.toFixed(3) : "-";

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

  return (
    <div className={cls + (selected ? " selected" : "") + " trow"} onClick={onSelect} role="button">
      <div className="sym">{row.symbol}</div>
      <div className="sig">{signalTxt}</div>
      <div className="spr">{spreadTxt}</div>
      <div className="dir">{dirTxt}</div>
      <div className="venue">{bTxt}</div>
      <div className="venue">{yTxt}</div>
      <div className="venue">{kTxt}</div>
      <div className="venue">{gTxt}</div>
      <div className="st">
        <span className={row.liveB ? "pill ok" : "pill bad"}>Bin</span>
        <span className={row.liveY ? "pill ok" : "pill bad"}>Byb</span>
        <span className={row.liveOkx ? "pill ok" : "pill bad"}>OKX</span>
        <span className={row.liveBitget ? "pill ok" : "pill bad"}>Bitget</span>
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


