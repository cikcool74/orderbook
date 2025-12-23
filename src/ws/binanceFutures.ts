import type { Quote, DepthLevel } from "../core/types";

/**
 * Binance USDT-M Futures (perpetual) best bid/ask:
 * - Endpoint: wss://fstream.binance.com
 * - Stream: <symbol>@bookTicker
 * - We use a single combined stream for 20+ symbols
 */

type OnQuote = (symbol: string, quote: Quote) => void;

export class BinanceFuturesWS {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly symbols: string[];
  private readonly onQuote: OnQuote;
  private reconnectTimer: number | null = null;

  constructor(symbols: string[], onQuote: OnQuote) {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.onQuote = onQuote;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open() {
    if (this.stopped) return;

    const streams = this.symbols.map((s) => `${s}@depth5@100ms`).join("/");
    const url = `wss://fstream.binance.com/stream?streams=${encodeURIComponent(streams)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.scheduleReconnect();

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        const data = msg?.data;
        if (!data?.s) return;

        const symbol = String(data.s).toUpperCase();
        const bidsArr = (data.bids || data.b || []) as any[];
        const asksArr = (data.asks || data.a || []) as any[];

        const topBid = bidsArr[0];
        const topAsk = asksArr[0];
        const bid = Number(topBid?.[0]);
        const ask = Number(topAsk?.[0]);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

        const toLevels = (arr: any[]): DepthLevel[] =>
          arr.slice(0, 5).map((r) => ({ price: Number(r?.[0]), qty: Number(r?.[1]) }))
            .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));

        const quote: Quote = {
          bid,
          ask,
          tsMs: Date.now(),
          bids: toLevels(bidsArr),
          asks: toLevels(asksArr),
        };

        this.onQuote(symbol, quote);
      } catch {}
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 800);
  }
}
