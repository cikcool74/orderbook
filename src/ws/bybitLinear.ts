import type { Quote, DepthLevel } from "../core/types";

/**
 * Bybit USDT Perpetual (linear) best bid/ask:
 * - Endpoint: wss://stream.bybit.com/v5/public/linear
 * - Topic: orderbook.1.<SYMBOL>
 *   data.b[0][0] = best bid price
 *   data.a[0][0] = best ask price
 *
 * Notes:
 * - We subscribe to orderbook.1 for each symbol (20+ is OK)
 * - We keep a ping to reduce disconnects
 */

type OnQuote = (symbol: string, quote: Quote) => void;

export class BybitLinearWS {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly symbols: string[];
  private readonly onQuote: OnQuote;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;

  constructor(symbols: string[], onQuote: OnQuote) {
    this.symbols = symbols.map((s) => s.toUpperCase());
    this.onQuote = onQuote;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open() {
    if (this.stopped) return;

    const ws = new WebSocket("wss://stream.bybit.com/v5/public/linear");
    this.ws = ws;

    ws.onopen = () => {
      this.subscribe();
      this.pingTimer = window.setInterval(() => {
        try { ws.send(JSON.stringify({ op: "ping" })); } catch {}
      }, 15000);
    };

    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.scheduleReconnect();

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);

        if (typeof msg?.topic === "string" && msg.topic.startsWith("orderbook.1.")) {
          const symbol = (msg.topic as string).split(".").pop()!;
          const d = msg.data;

          const bidsArr = d?.b || [];
          const asksArr = d?.a || [];
          const bestBidRow = bidsArr?.[0];
          const bestAskRow = asksArr?.[0];
          if (!bestBidRow || !bestAskRow) return;

          const bid = Number(bestBidRow[0]);
          const ask = Number(bestAskRow[0]);
          if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

          const toLevels = (arr: any[]): DepthLevel[] =>
            arr.slice(0, 5).map((r: any) => ({ price: Number(r?.[0]), qty: Number(r?.[1]) }))
              .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));

          this.onQuote(symbol, {
            bid,
            ask,
            tsMs: Date.now(),
            bids: toLevels(bidsArr),
            asks: toLevels(asksArr),
          });
        }
      } catch {}
    };
  }

  private subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const args = this.symbols.map((s) => `orderbook.1.${s}`);
    // Bybit may limit topics per request; chunk
    const chunkSize = 30;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      this.ws.send(JSON.stringify({ op: "subscribe", args: slice }));
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = null;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 900);
  }
}
