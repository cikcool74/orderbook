import type { Quote, DepthLevel } from "../core/types";

type OnQuote = (symbol: string, quote: Quote) => void;

// OKX USDT perpetual (SWAP) depth5
export class OkxSwapWS {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly symbols: string[];
  private readonly onQuote: OnQuote;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private backoffMs = 1000;
  private lastMsgMs = 0;

  constructor(symbols: string[], onQuote: OnQuote) {
    // OKX expects BTC-USDT-SWAP format
    this.symbols = symbols.map((s) => `${s.replace("USDT", "")}-USDT-SWAP`);
    this.onQuote = onQuote;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private open() {
    if (this.stopped) return;

    const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
    this.ws = ws;
    this.backoffMs = 1000;
    this.lastMsgMs = Date.now();

    ws.onopen = () => {
      const args = this.symbols.map((instId) => ({ channel: "books5", instId }));
      ws.send(JSON.stringify({ op: "subscribe", args }));
    };

    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.scheduleReconnect();

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg?.arg?.channel !== "books5" || !Array.isArray(msg?.data) || msg.data.length === 0) return;
        const instId = msg.arg.instId;
        if (!instId) return;
        const symbol = instId.replace("-USDT-SWAP", "") + "USDT";

        this.lastMsgMs = Date.now();

        const data = msg.data[0];
        const bidsArr = data?.bids || [];
        const asksArr = data?.asks || [];
        const topBid = bidsArr[0];
        const topAsk = asksArr[0];
        const bid = Number(topBid?.[0]);
        const ask = Number(topAsk?.[0]);
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
      } catch {}
    };

    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastMsgMs > 15000) {
        try { this.ws.close(); } catch {}
      }
    }, 6000);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 1.8, 15000);
      this.open();
    }, Math.min(this.backoffMs, 15000) * (1 + Math.random() * 0.25));
  }
}
