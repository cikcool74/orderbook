/**
 * Node backend: Binance Futures + Bybit Linear + OKX Swap + Bitget Swap (perp) best bid/ask aggregator
 * Exposes:
 * - HTTP: http://localhost:8787/health
 * - WS:   ws://localhost:8787/ws  (broadcast quotes)
 *
 * Messages to client:
 * { t:"q", v:"binance"|"bybit"|"okx"|"bitget", s:"BTCUSDT", bid:123.4, ask:123.5, ts:169... }
 *
 * Run:
 *   npm i
 *   npm run server
 *
 * Env:
 *   PORT=8787
 *   SYMBOLS=BTCUSDT,ETHUSDT,...
 */

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const HOT_SPREAD = Number(process.env.HOT_SPREAD ?? 0.15);
const CLOSE_SPREAD = Number(process.env.CLOSE_SPREAD ?? 0.05);
const SIGNAL_LOG = process.env.SIGNAL_LOG || "signals.log";
const ALERT_RATE_MS = Number(process.env.ALERT_RATE_MS ?? 1000);
const HEARTBEAT_TIMEOUT_MS = 20000;
// Telegram: keep empty by default; set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable
// Example:
//   TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=-100123456 node index.js
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const SUMMARY_MS = Number(process.env.TELEGRAM_SUMMARY_MS || 300000); // default 5 minutes
const STALE_MS = 2000;
const OFF_MS = 10000;
const EMA_ALPHA = 0.2;
let telegramEnabled = true;

// You can override symbols via env: SYMBOLS=BTCUSDT,ETHUSDT,...
const DEFAULT_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","MATICUSDT",
  "DOTUSDT","LTCUSDT","BCHUSDT","TRXUSDT","ETCUSDT",
  "ATOMUSDT","UNIUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "NEARUSDT","SUIUSDT","FILUSDT","RNDRUSDT","INJUSDT",
  "WIFUSDT","STXUSDT","SANDUSDT","MANAUSDT","AAVEUSDT",
  "THETAUSDT","CHZUSDT","XLMUSDT","HBARUSDT","CRVUSDT",
  "XMRUSDT","KAVAUSDT","LRCUSDT","RSRUSDT","ONEUSDT",
  "RUNEUSDT","ARPAUSDT","FLOWUSDT","GMXUSDT","GALAUSDT",
  "DYDXUSDT","IMXUSDT","IDUSDT","JTOUSDT","JUPUSDT",
  "TIAUSDT","WLDUSDT","PYTHUSDT","STRKUSDT","SEIUSDT",
  "ORDIUSDT","ACEUSDT","BLURUSDT",
  "ZROUSDT","NOTUSDT","ENAUSDT","BOMEUSDT","TURBOUSDT",
  "BIGTIMEUSDT","ZECUSDT","ALGOUSDT","SNXUSDT",
  "ZILUSDT","BANDUSDT","ZRXUSDT","MASKUSDT",
  "INJUSDT","OPUSDT","ARBUSDT"
];

const SYMBOLS = (process.env.SYMBOLS ? process.env.SYMBOLS.split(",") : DEFAULT_SYMBOLS)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ----- Simple in-memory latest quotes -----
/** @type {Record<string, {binance?: any, bybit?: any, okx?: any, bitget?: any}>} */
const latest = Object.fromEntries(SYMBOLS.map((s) => [s, {}]));
const stateStore = Object.fromEntries(SYMBOLS.map((s) => [s, {}]));
const summary = { periodProfit: 0, periodAlerts: 0, totalProfit: 0, totalAlerts: 0 };

// ================== HTTP + WS SERVER ==================
const app = express();
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    symbols: SYMBOLS.length,
    port: PORT,
    ts: Date.now()
  });
});

app.get("/stats", (_req, res) => {
  res.json({
    stats: statsAgg,
    equity: equitySeries.slice(-1000),
    trades: journal.slice(-200),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function recordQuote(symbol, venue, payload) {
  if (!stateStore[symbol]) stateStore[symbol] = {};
  const tsLocal = Date.now();
  const statusInfo = venueStatus(tsLocal);
  const emaMs = updateEma(venue, statusInfo.ageMs);
  const ts = payload.ts ?? tsLocal;
  stateStore[symbol][venue] = {
    bid: payload.bid,
    ask: payload.ask,
    ts,
    tsLocal,
    status: statusInfo.status,
    ageMs: statusInfo.ageMs,
    emaMs,
  };
  payload.ts = ts;
  payload.tsLocal = tsLocal;
  payload.status = statusInfo.status;
  payload.ageMs = statusInfo.ageMs;
  if (emaMs != null) payload.venueEmaMs = Math.round(emaMs);
  return { status: statusInfo.status, ageMs: statusInfo.ageMs, emaMs };
}

function validateQuote(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false;
  if (bid <= 0 || ask <= 0) return false;
  if (ask < bid) return false;
  return true;
}

const ema = {};
function updateEma(venue, value) {
  if (!Number.isFinite(value)) return ema[venue];
  ema[venue] = ema[venue] == null ? value : (EMA_ALPHA * value + (1 - EMA_ALPHA) * ema[venue]);
  return ema[venue];
}

const lastAlertAt = new Map();
const journal = [];
let equitySeries = [];
let equityPeak = 0;
const statsAgg = {
  trades: 0,
  wins: 0,
  losses: 0,
  pnlSum: 0,
  pnlWin: 0,
  pnlLoss: 0,
  totalDuration: 0,
  byReason: {},
  bySymbol: {},
  byPair: {},
  startEquity: null,
  lastEquity: null,
  maxDD: 0,
};

function updateStats(entry, equityVal) {
  statsAgg.trades += 1;
  const pnl = Number(entry.pnl_usdt);
  if (Number.isFinite(pnl)) {
    statsAgg.pnlSum += pnl;
    if (pnl >= 0) {
      statsAgg.wins += 1;
      statsAgg.pnlWin += pnl;
    } else {
      statsAgg.losses += 1;
      statsAgg.pnlLoss += pnl;
    }
  }
  const dur = Number(entry.duration_ms);
  if (Number.isFinite(dur)) statsAgg.totalDuration += dur;

  if (entry.reason) statsAgg.byReason[entry.reason] = (statsAgg.byReason[entry.reason] || 0) + 1;
  if (entry.symbol) {
    const s = statsAgg.bySymbol[entry.symbol] || { trades: 0, pnl: 0 };
    s.trades += 1;
    if (Number.isFinite(pnl)) s.pnl += pnl;
    statsAgg.bySymbol[entry.symbol] = s;
  }
  if (entry.buy && entry.sell) {
    const key = `${entry.buy}->${entry.sell}`;
    const p = statsAgg.byPair[key] || { trades: 0, pnl: 0 };
    p.trades += 1;
    if (Number.isFinite(pnl)) p.pnl += pnl;
    statsAgg.byPair[key] = p;
  }
  if (equityVal != null && Number.isFinite(equityVal)) {
    if (statsAgg.startEquity == null) statsAgg.startEquity = equityVal;
    statsAgg.lastEquity = equityVal;
    // dd tracked via equityPeak outside; update using equityVal vs equityPeak
    const ddPct = equityPeak > 0 ? ((equityVal - equityPeak) / equityPeak) * 100 : 0;
    if (ddPct < statsAgg.maxDD) statsAgg.maxDD = ddPct;
  }
  const winRate = statsAgg.trades > 0 ? (statsAgg.wins / statsAgg.trades) * 100 : 0;
  const avgPnl = statsAgg.trades > 0 ? statsAgg.pnlSum / statsAgg.trades : 0;
  const profitFactor = statsAgg.pnlLoss !== 0 ? Math.abs(statsAgg.pnlWin / statsAgg.pnlLoss) : null;
  const avgDuration = statsAgg.trades > 0 ? statsAgg.totalDuration / statsAgg.trades : 0;
  const out = {
    trades: statsAgg.trades,
    wins: statsAgg.wins,
    losses: statsAgg.losses,
    win_rate: winRate,
    pnl_sum: statsAgg.pnlSum,
    avg_pnl: avgPnl,
    profit_factor: profitFactor,
    avg_duration_ms: avgDuration,
    by_reason: statsAgg.byReason,
    by_symbol: statsAgg.bySymbol,
    by_pair: statsAgg.byPair,
    equity_start: statsAgg.startEquity,
    equity_now: statsAgg.lastEquity,
    max_dd: statsAgg.maxDD,
  };
  fs.writeFile(path.join(DATA_DIR, "stats.json"), JSON.stringify(out, null, 2), () => {});
}

const DATA_DIR = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_DIR, "trades.ndjson");
const EQUITY_FILE = path.join(DATA_DIR, "equity.ndjson");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  if (!telegramEnabled) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text }),
    });
  } catch (err) {
    console.warn("[TELEGRAM] send failed", err?.message || err);
  }
}

function sendSummary() {
  if (!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  if (!telegramEnabled) return;
  if (summary.periodAlerts === 0) return;
  const mins = Math.max(1, Math.round(SUMMARY_MS / 60000));
  const msg = `PnL summary (last ${mins}m): $${summary.periodProfit.toFixed(2)} across ${summary.periodAlerts} alerts. Total: $${summary.totalProfit.toFixed(2)} (${summary.totalAlerts} alerts).`;
  sendTelegram(msg);
  summary.periodProfit = 0;
  summary.periodAlerts = 0;
}

function venueStatus(tsLocal) {
  if (!tsLocal) return { status: "OFF", ageMs: Infinity };
  const ageMs = Date.now() - tsLocal;
  if (ageMs <= STALE_MS) return { status: "OK", ageMs };
  if (ageMs <= OFF_MS) return { status: "STALE", ageMs };
  return { status: "OFF", ageMs };
}

function logSignal(entry) {
  const line = JSON.stringify(entry);
  try {
    fs.appendFile(SIGNAL_LOG, line + "\n", () => {});
  } catch {}
  console.log("[ALERT]", line);
}

async function handleIncomingAlert(evt = {}) {
  const symbol = evt.symbol || evt.s;
  const from = evt.from || evt.buy || evt.source;
  const to = evt.to || evt.sell || evt.target;
  const level = evt.level || evt.type || "alert";
  if (!symbol) return;

  const key = `${symbol}:${from || ""}:${to || ""}:${level}`;
  const nowTs = Date.now();
  const last = lastAlertAt.get(key) || 0;
  if (nowTs - last < ALERT_RATE_MS) return;
  lastAlertAt.set(key, nowTs);

  const payload = {
    ts: nowTs,
    level,
    symbol,
    from,
    to,
    spread_open: evt.spread_open ?? evt.spread ?? null,
    spread_close: evt.spread_close ?? evt.spread ?? null,
    duration_ms: evt.duration_ms ?? null,
    virtual_pnl: evt.virtual_pnl ?? null,
  };

  const isClose = String(level || "").toUpperCase() === "CLOSE";
  if (isClose) {
    summary.periodAlerts += 1;
    summary.totalAlerts += 1;
    const pvRaw = evt.profit_value ?? evt.profitValue ?? evt.pnl_value ?? evt.pnl ?? null;
    const pv = Number(pvRaw);
    if (Number.isFinite(pv)) {
      summary.periodProfit += pv;
      summary.totalProfit += pv;
    }
  }

  broadcast({ t: "alert", ...payload });
  logSignal(payload);
  const txt = evt.text || `[${level}] ${symbol} ${from || ""} -> ${to || ""} open ${payload.spread_open ?? ""} close ${payload.spread_close ?? ""}`;
  await sendTelegram(txt);
}

wss.on("connection", (ws) => {
  // send snapshot
  for (const s of SYMBOLS) {
    const b = latest[s]?.binance;
    const y = latest[s]?.bybit;
    const k = latest[s]?.okx;
    const g = latest[s]?.bitget;
    if (b) ws.send(JSON.stringify({ t: "q", v: "binance", s, ...b }));
    if (y) ws.send(JSON.stringify({ t: "q", v: "bybit", s, ...y }));
    if (k) ws.send(JSON.stringify({ t: "q", v: "okx", s, ...k }));
    if (g) ws.send(JSON.stringify({ t: "q", v: "bitget", s, ...g }));
  }

   ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.t === "alert") handleIncomingAlert(msg);
      if (msg?.t === "tg_toggle" && typeof msg.enabled === "boolean") {
        telegramEnabled = msg.enabled;
        console.log("[TELEGRAM] enabled =", telegramEnabled);
      }
      if (msg?.t === "trade_log") {
        if (msg.journal) {
          journal.push(msg.journal);
          fs.appendFile(TRADES_FILE, JSON.stringify(msg.journal) + "\n", () => {});
        }
        if (msg.equity) {
          const eq = msg.equity;
          const val = Number(eq.equity);
          if (Number.isFinite(val)) {
            equityPeak = Math.max(equityPeak, val);
            const dd = equityPeak > 0 ? ((val - equityPeak) / equityPeak) * 100 : 0;
            const point = { t: eq.t || Date.now(), equity: val, dd };
            equitySeries.push(point);
            fs.appendFile(EQUITY_FILE, JSON.stringify(point) + "\n", () => {});
            if (msg.journal) updateStats(msg.journal, val);
          }
        } else if (msg.journal) {
          updateStats(msg.journal, null);
        }
      }
    } catch {}
  });
});

// ================== BINANCE FUTURES ==================
let binanceWS = null;
let binanceReconnect = null;
let binanceBackoff = 800;
let binanceHeartbeat = null;
let binanceLastMsg = Date.now();

function connectBinance() {
  if (binanceReconnect) clearTimeout(binanceReconnect);
  if (binanceHeartbeat) clearInterval(binanceHeartbeat);

  const streams = SYMBOLS.map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
  const url = `wss://fstream.binance.com/stream?streams=${encodeURIComponent(streams)}`;

  if (binanceWS) {
    try { binanceWS.close(); } catch {}
  }

  binanceWS = new WebSocket(url);
  binanceBackoff = 800;
  binanceLastMsg = Date.now();

  binanceWS.on("open", () => {
    console.log("[BINANCE] connected");
    binanceBackoff = 800;
    binanceLastMsg = Date.now();
  });
  binanceWS.on("close", () => {
    if (binanceHeartbeat) {
      clearInterval(binanceHeartbeat);
      binanceHeartbeat = null;
    }
    console.log("[BINANCE] closed -> reconnect");
    const wait = Math.min(binanceBackoff, 15000) * (1 + Math.random() * 0.25);
    binanceReconnect = setTimeout(() => {
      binanceBackoff = Math.min(binanceBackoff * 1.8, 15000);
      connectBinance();
    }, wait);
  });
  binanceWS.on("error", (e) => {
    console.log("[BINANCE] error", e.message);
    try { binanceWS.close(); } catch {}
  });

  binanceWS.on("message", (raw) => {
    binanceLastMsg = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      const d = msg?.data;
      if (!d?.s) return;

      const s = String(d.s).toUpperCase();
      if (!latest[s]) return;

      const bid = Number(d.b);
      const ask = Number(d.a);
      if (!validateQuote(bid, ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: d.bids?.slice(0, 5), asks: d.asks?.slice(0, 5) };
      latest[s].binance = payload;
      recordQuote(s, "binance", payload);

      broadcast({ t: "q", v: "binance", s, ...payload });
    } catch {}
  });

  binanceHeartbeat = setInterval(() => {
    if (Date.now() - binanceLastMsg > HEARTBEAT_TIMEOUT_MS) {
      try { binanceWS?.close(); } catch {}
    }
  }, 5000);
}

// ================== BYBIT LINEAR ==================
let bybitWS = null;
let bybitReconnect = null;
let bybitPing = null;
let bybitHeartbeat = null;
let bybitBackoff = 900;
let bybitLastMsg = Date.now();

function connectBybit() {
  if (bybitReconnect) clearTimeout(bybitReconnect);
  if (bybitPing) clearInterval(bybitPing);
  if (bybitHeartbeat) clearInterval(bybitHeartbeat);

  bybitWS = new WebSocket("wss://stream.bybit.com/v5/public/linear");
  bybitBackoff = 900;
  bybitLastMsg = Date.now();

  bybitWS.on("open", () => {
    console.log("[BYBIT] connected");
    bybitBackoff = 900;
    bybitLastMsg = Date.now();
    // subscribe
    const args = SYMBOLS.map((s) => `orderbook.1.${s}`);
    bybitWS.send(JSON.stringify({ op: "subscribe", args }));

    // keepalive
    bybitPing = setInterval(() => {
      try { bybitWS.send(JSON.stringify({ op: "ping" })); } catch {}
    }, 15000);
  });

  bybitWS.on("close", () => {
    if (bybitHeartbeat) {
      clearInterval(bybitHeartbeat);
      bybitHeartbeat = null;
    }
    console.log("[BYBIT] closed -> reconnect");
    const wait = Math.min(bybitBackoff, 15000) * (1 + Math.random() * 0.25);
    bybitReconnect = setTimeout(() => {
      bybitBackoff = Math.min(bybitBackoff * 1.8, 15000);
      connectBybit();
    }, wait);
  });

  bybitWS.on("error", (e) => {
    console.log("[BYBIT] error", e.message);
    try { bybitWS.close(); } catch {}
  });

  bybitWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (typeof msg?.topic === "string" && msg.topic.startsWith("orderbook.1.")) {
        bybitLastMsg = Date.now();
        const s = msg.topic.split(".").pop();
        if (!s || !latest[s]) return;

      const d = msg.data;
      const br = d?.b?.[0];
      const ar = d?.a?.[0];
      if (!br || !ar) return;

      const bid = Number(br[0]);
      const ask = Number(ar[0]);
      if (!validateQuote(bid, ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: d.b?.slice(0, 5), asks: d.a?.slice(0, 5) };
      latest[s].bybit = payload;
      recordQuote(s, "bybit", payload);

      broadcast({ t: "q", v: "bybit", s, ...payload });
      }
    } catch {}
  });

  bybitHeartbeat = setInterval(() => {
    if (Date.now() - bybitLastMsg > HEARTBEAT_TIMEOUT_MS) {
      try { bybitWS?.close(); } catch {}
    }
  }, 6000);
}

// ================== OKX SWAP ==================
let okxWS = null;
let okxReconnect = null;
let okxPing = null;
let okxHeartbeat = null;
let okxBackoff = 1200;
let okxLastMsg = Date.now();

function connectOkx() {
  if (okxReconnect) clearTimeout(okxReconnect);
  if (okxPing) clearInterval(okxPing);
  if (okxHeartbeat) clearInterval(okxHeartbeat);

  okxWS = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
  okxBackoff = 1200;
  okxLastMsg = Date.now();

  okxWS.on("open", () => {
    console.log("[OKX] connected");
    okxBackoff = 1200;
    okxLastMsg = Date.now();
    const argsAll = SYMBOLS.map((s) => ({ channel: "books5", instId: `${s.replace("USDT", "")}-USDT-SWAP` }));
    const chunkSize = 20;
    for (let i = 0; i < argsAll.length; i += chunkSize) {
      const args = argsAll.slice(i, i + chunkSize);
      okxWS.send(JSON.stringify({ op: "subscribe", args }));
    }
    okxPing = setInterval(() => {
      try { okxWS.send(JSON.stringify({ op: "ping" })); } catch {}
    }, 20000);
  });

  okxWS.on("close", () => {
    if (okxHeartbeat) {
      clearInterval(okxHeartbeat);
      okxHeartbeat = null;
    }
    console.log("[OKX] closed -> reconnect");
    const wait = Math.min(okxBackoff, 15000) * (1 + Math.random() * 0.25);
    okxReconnect = setTimeout(() => {
      okxBackoff = Math.min(okxBackoff * 1.8, 15000);
      connectOkx();
    }, wait);
  });
  okxWS.on("error", (e) => {
    console.log("[OKX] error", e.message);
    try { okxWS.close(); } catch {}
  });

  okxWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.event === "pong") return;
      if (msg?.arg?.channel !== "books5" || !Array.isArray(msg?.data) || msg.data.length === 0) return;
      const instId = msg.arg.instId;
      if (!instId) return;
      const symbol = instId.replace("-USDT-SWAP", "") + "USDT";
      if (!latest[symbol]) return;
      okxLastMsg = Date.now();

      const data = msg.data[0];
      const bidsArr = data?.bids || [];
      const asksArr = data?.asks || [];
      const topBid = bidsArr[0];
      const topAsk = asksArr[0];
      const bid = Number(topBid?.[0]);
      const ask = Number(topAsk?.[0]);
      if (!validateQuote(bid, ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: bidsArr, asks: asksArr };
      latest[symbol].okx = payload;
      recordQuote(symbol, "okx", payload);
      broadcast({ t: "q", v: "okx", s: symbol, ...payload });
    } catch {}
  });

  okxHeartbeat = setInterval(() => {
    if (Date.now() - okxLastMsg > HEARTBEAT_TIMEOUT_MS) {
      try { okxWS?.close(); } catch {}
    }
  }, 7000);
}

// ================== BITGET SWAP ==================
let bitgetWS = null;
let bitgetReconnect = null;
let bitgetPing = null;
let bitgetHeartbeat = null;
let bitgetBackoff = 1400;
let bitgetLastMsg = Date.now();

function connectBitget() {
  if (bitgetReconnect) clearTimeout(bitgetReconnect);
  if (bitgetPing) clearInterval(bitgetPing);
  if (bitgetHeartbeat) clearInterval(bitgetHeartbeat);

  bitgetWS = new WebSocket("wss://ws.bitget.com/v2/ws/public");
  bitgetBackoff = 1400;
  bitgetLastMsg = Date.now();

  bitgetWS.on("open", () => {
    console.log("[BITGET] connected");
    bitgetBackoff = 1400;
    bitgetLastMsg = Date.now();
    const argsAll = SYMBOLS.map((s) => ({ instType: "SP", channel: "books5", instId: `${s}_UMCBL` }));
    const chunkSize = 20;
    for (let i = 0; i < argsAll.length; i += chunkSize) {
      const args = argsAll.slice(i, i + chunkSize);
      bitgetWS.send(JSON.stringify({ op: "subscribe", args }));
    }
    bitgetPing = setInterval(() => {
      try { bitgetWS.send(JSON.stringify({ op: "ping" })); } catch {}
    }, 20000);
  });

  bitgetWS.on("close", () => {
    if (bitgetHeartbeat) {
      clearInterval(bitgetHeartbeat);
      bitgetHeartbeat = null;
    }
    console.log("[BITGET] closed -> reconnect");
    const wait = Math.min(bitgetBackoff, 15000) * (1 + Math.random() * 0.25);
    bitgetReconnect = setTimeout(() => {
      bitgetBackoff = Math.min(bitgetBackoff * 1.8, 15000);
      connectBitget();
    }, wait);
  });
  bitgetWS.on("error", (e) => {
    console.log("[BITGET] error", e.message);
    try { bitgetWS.close(); } catch {}
  });

  bitgetWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.event === "pong") return;
      if (msg?.arg?.channel !== "books5" || !msg?.data?.[0]) return;
      const instId = msg.arg.instId;
      if (!instId) return;
      const symbol = instId.replace("_UMCBL", "");
      if (!latest[symbol]) return;
      bitgetLastMsg = Date.now();

      const data = msg.data[0];
      const bidsArr = data.bids || [];
      const asksArr = data.asks || [];
      const topBid = bidsArr[0];
      const topAsk = asksArr[0];
      const bid = Number(topBid?.[0]);
      const ask = Number(topAsk?.[0]);
      if (!validateQuote(bid, ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: bidsArr, asks: asksArr };
      latest[symbol].bitget = payload;
      recordQuote(symbol, "bitget", payload);
      broadcast({ t: "q", v: "bitget", s: symbol, ...payload });
    } catch {}
  });

  bitgetHeartbeat = setInterval(() => {
    if (Date.now() - bitgetLastMsg > HEARTBEAT_TIMEOUT_MS) {
      try { bitgetWS?.close(); } catch {}
    }
  }, 7000);
}

// ================== START ==================
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WS endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Symbols: ${SYMBOLS.length}`);
});

let summaryTimer = null;
if (SUMMARY_MS > 0) {
  summaryTimer = setInterval(sendSummary, SUMMARY_MS);
}

connectBinance();
connectBybit();
connectOkx();
connectBitget();
