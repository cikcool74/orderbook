export type Venue = "binance" | "bybit" | "okx" | "bitget";

export type Quote = {
  bid: number;
  ask: number;
  tsMs: number;
  bids?: { price: number; qty: number }[];
  asks?: { price: number; qty: number }[];
};

export enum SignalState {
  NEUTRAL = "NEUTRAL",
  HOT = "HOT",
  HOT_STRONG = "HOT_STRONG",
  CLOSE = "CLOSE",
}

export type SymbolState = {
  quotes: Partial<Record<Venue, Quote>>;
  lastUpdateMs: number;

  spreadPct: number; // best direction spread
  dir: "BUY_BIN_SELL_BYB" | "BUY_BYB_SELL_BIN" | "—" | string;

  // HOT/CLOSE state machine
  wasHot: boolean;
  signal: SignalState;

  lastSignalKind: SignalState | null;
  lastSignalMs: number;
  blinkUntilMs: number;

  lastHotSpread?: number;
  lastHotTs?: number;
  entry?: {
    dir: string;
    buyVenue: string;
    sellVenue: string;
    quotes: Partial<Record<Venue, Quote>>;
  };
};

export type Row = {
  symbol: string;
  dir: SymbolState["dir"];
  spreadPct: number;
  signal: SignalState;
  blink: boolean;
  binance?: Quote;
  bybit?: Quote;
  okx?: Quote;
  bitget?: Quote;
  liveB: boolean;
  liveY: boolean;
  liveOkx: boolean;
  liveBitget: boolean;
};

export function mkEmptyState(symbols: string[]): Record<string, SymbolState> {
  const out: Record<string, SymbolState> = {};
  for (const s of symbols) {
    out[s] = {
      quotes: {},
      lastUpdateMs: 0,
      spreadPct: Number.NaN,
      dir: "—",
      wasHot: false,
      signal: SignalState.NEUTRAL,
      lastSignalKind: null,
      lastSignalMs: 0,
      blinkUntilMs: 0,
    };
  }
  return out;
}

// Lean list (~30) to simplify debugging and focus on the most liquid pairs
export const DEFAULT_SYMBOLS: string[] = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT",
  "DOTUSDT", "LTCUSDT", "BCHUSDT", "TRXUSDT", "ETCUSDT",
  "ATOMUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
  "NEARUSDT", "SUIUSDT", "FILUSDT", "INJUSDT", "AAVEUSDT",
  "LDOUSDT", "XMRUSDT", "CRVUSDT", "RSRUSDT",
];

export function computeSpreadPct(buyAsk: number, sellBid: number): number {
  // positive when sellBid > buyAsk
  const mid = (buyAsk + sellBid) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return Number.NaN;
  return ((sellBid - buyAsk) / mid) * 100;
}
