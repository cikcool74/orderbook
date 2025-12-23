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

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
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
});

// ================== BINANCE FUTURES ==================
let binanceWS = null;
let binanceReconnect = null;

function connectBinance() {
  if (binanceReconnect) clearTimeout(binanceReconnect);

  const streams = SYMBOLS.map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
  const url = `wss://fstream.binance.com/stream?streams=${encodeURIComponent(streams)}`;

  binanceWS = new WebSocket(url);

  binanceWS.on("open", () => console.log("[BINANCE] connected"));
  binanceWS.on("close", () => {
    console.log("[BINANCE] closed -> reconnect");
    binanceReconnect = setTimeout(connectBinance, 800);
  });
  binanceWS.on("error", (e) => {
    console.log("[BINANCE] error", e.message);
    try { binanceWS.close(); } catch {}
  });

  binanceWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const d = msg?.data;
      if (!d?.s) return;

      const s = String(d.s).toUpperCase();
      if (!latest[s]) return;

      const bid = Number(d.b);
      const ask = Number(d.a);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: d.bids?.slice(0, 5), asks: d.asks?.slice(0, 5) };
      latest[s].binance = payload;

      broadcast({ t: "q", v: "binance", s, ...payload });
    } catch {}
  });
}

// ================== BYBIT LINEAR ==================
let bybitWS = null;
let bybitReconnect = null;
let bybitPing = null;

function connectBybit() {
  if (bybitReconnect) clearTimeout(bybitReconnect);
  if (bybitPing) clearInterval(bybitPing);

  bybitWS = new WebSocket("wss://stream.bybit.com/v5/public/linear");

  bybitWS.on("open", () => {
    console.log("[BYBIT] connected");
    // subscribe
    const args = SYMBOLS.map((s) => `orderbook.1.${s}`);
    bybitWS.send(JSON.stringify({ op: "subscribe", args }));

    // keepalive
    bybitPing = setInterval(() => {
      try { bybitWS.send(JSON.stringify({ op: "ping" })); } catch {}
    }, 15000);
  });

  bybitWS.on("close", () => {
    console.log("[BYBIT] closed -> reconnect");
    bybitReconnect = setTimeout(connectBybit, 900);
  });

  bybitWS.on("error", (e) => {
    console.log("[BYBIT] error", e.message);
    try { bybitWS.close(); } catch {}
  });

  bybitWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (typeof msg?.topic === "string" && msg.topic.startsWith("orderbook.1.")) {
        const s = msg.topic.split(".").pop();
        if (!s || !latest[s]) return;

      const d = msg.data;
      const br = d?.b?.[0];
      const ar = d?.a?.[0];
      if (!br || !ar) return;

      const bid = Number(br[0]);
      const ask = Number(ar[0]);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: d.b?.slice(0, 5), asks: d.a?.slice(0, 5) };
      latest[s].bybit = payload;

      broadcast({ t: "q", v: "bybit", s, ...payload });
      }
    } catch {}
  });
}

// ================== OKX SWAP ==================
let okxWS = null;
let okxReconnect = null;
let okxPing = null;

function connectOkx() {
  if (okxReconnect) clearTimeout(okxReconnect);
  if (okxPing) clearInterval(okxPing);

  okxWS = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");

  okxWS.on("open", () => {
    console.log("[OKX] connected");
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
    console.log("[OKX] closed -> reconnect");
    okxReconnect = setTimeout(connectOkx, 1200);
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
      const symbol = instId.replace("-USDT-SWAP", "");

      const data = msg.data[0];
      const bidsArr = data?.bids || [];
      const asksArr = data?.asks || [];
      const topBid = bidsArr[0];
      const topAsk = asksArr[0];
      const bid = Number(topBid?.[0]);
      const ask = Number(topAsk?.[0]);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: bidsArr, asks: asksArr };
      latest[symbol].okx = payload;
      broadcast({ t: "q", v: "okx", s: symbol, ...payload });
    } catch {}
  });
}

// ================== BITGET SWAP ==================
let bitgetWS = null;
let bitgetReconnect = null;
let bitgetPing = null;

function connectBitget() {
  if (bitgetReconnect) clearTimeout(bitgetReconnect);
  if (bitgetPing) clearInterval(bitgetPing);

  bitgetWS = new WebSocket("wss://ws.bitget.com/v2/ws/public");

  bitgetWS.on("open", () => {
    console.log("[BITGET] connected");
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
    console.log("[BITGET] closed -> reconnect");
    bitgetReconnect = setTimeout(connectBitget, 1400);
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

      const data = msg.data[0];
      const bidsArr = data.bids || [];
      const asksArr = data.asks || [];
      const topBid = bidsArr[0];
      const topAsk = asksArr[0];
      const bid = Number(topBid?.[0]);
      const ask = Number(topAsk?.[0]);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const payload = { bid, ask, ts: Date.now(), bids: bidsArr, asks: asksArr };
      latest[symbol].bitget = payload;
      broadcast({ t: "q", v: "bitget", s: symbol, ...payload });
    } catch {}
  });
}

// ================== START ==================
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WS endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Symbols: ${SYMBOLS.length}`);
});

connectBinance();
connectBybit();
connectOkx();
connectBitget();
