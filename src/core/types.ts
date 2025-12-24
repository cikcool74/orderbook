export type Venue = "binance" | "bybit" | "okx" | "bitget";

export type DepthLevel = {
  price: number;
  qty: number;
};

export type Quote = {
  bid: number;
  ask: number;
  tsMs: number;
  bids?: DepthLevel[];
  asks?: DepthLevel[];
  venueEmaMs?: number;
};

export enum SignalState {
  NEUTRAL = "NEUTRAL",
  HOT = "HOT",
  HOT_STRONG = "HOT_STRONG",
  CLOSE = "CLOSE",
}

export type VenueSnapshot = {
  bid: number;
  ask: number;
  ts: number;
};

export type SpreadSample = {
  buy: Venue;
  sell: Venue;
  spreadPct: number;
  buyAsk: number;
  sellBid: number;
  ts: number;
};

export type SymbolState = {
  quotes: Partial<Record<Venue, Quote>>;
  lastUpdateMs: number;

  spreadPct: number; // currently used as NET edge pct for ranking
  grossSpreadPct?: number;
  netEdgePct?: number;
  netEdgeUSDT?: number;
  feesPct?: number;
  bufferPct?: number;
  bestBuyVenue?: Venue | null;
  bestSellVenue?: Venue | null;
  dir: "BUY_BIN_SELL_BYB" | "BUY_BYB_SELL_BIN" | "-" | string;

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
    openSpread?: number;
    netEdgePct?: number;
    netEdgeUSDT?: number;
    feesPct?: number;
    bufferPct?: number;
    openedAt?: number;
    buyAsk?: number;
    sellBid?: number;
  };

  store?: Partial<Record<Venue, VenueSnapshot>>;
  lastSpreadSample?: SpreadSample;
  candidate?: {
    startedAt: number;
    lastSeenAt: number;
    buyVenue: Venue;
    sellVenue: Venue;
    netEdgePct: number;
  };
  openTrade?: {
    id: string;
    openedAt: number;
    buyVenue: Venue;
    sellVenue: Venue;
    openNetEdgePct: number;
    openGrossPct: number;
    openFeesPct: number;
    openBufferPct: number;
    notional: number;
  };
  queue?: TradeIntent[];
  activeTrades?: TradeIntent[];
  lastCloseMs?: number;
};

export type Row = {
  symbol: string;
  dir: SymbolState["dir"];
  spreadPct: number;
  grossSpreadPct?: number;
  netEdgePct?: number;
  netEdgeUSDT?: number;
  feesPct?: number;
  bufferPct?: number;
  bestBuyVenue?: Venue | null;
  bestSellVenue?: Venue | null;
  stateLabel?: string;
  stateKind?: "IDLE" | "CANDIDATE" | "OPEN";
  signal: SignalState;
  blink: boolean;
  binance?: Quote;
  bybit?: Quote;
  okx?: Quote;
  bitget?: Quote;
  venues?: Partial<Record<Venue, VenueStatus>>;
};

export type TradeIntent = {
  id: string;
  symbol: string;
  buyVenue: Venue;
  sellVenue: Venue;
  notional: number;
  edge: {
    gross: number;
    net: number;
  };
  ts: number;
};

export type VenueStatus = {
  status: "OK" | "STALE" | "OFF";
  ageMs: number;
  emaMs?: number;
};

export function mkEmptyState(symbols: string[]): Record<string, SymbolState> {
  const out: Record<string, SymbolState> = {};
  for (const s of symbols) {
    out[s] = {
      quotes: {},
      lastUpdateMs: 0,
      spreadPct: Number.NaN,
      dir: "-",
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
  // Added batch for extended scanning
  "ICPUSDT", "FTMUSDT", "GALAUSDT", "SANDUSDT", "MANAUSDT",
  "EOSUSDT", "ALGOUSDT", "FLOWUSDT", "KAVAUSDT", "DYDXUSDT",
  "ZRXUSDT", "ENJUSDT", "SNXUSDT", "1INCHUSDT", "MASKUSDT",
  "ROSEUSDT", "GMTUSDT", "CELOUSDT",
  // New batch
  "BALUSDT", "COMPUSDT", "SUSHIUSDT", "YFIUSDT", "KSMUSDT",
  "BANDUSDT", "NMRUSDT", "OMGUSDT", "QTUMUSDT", "ICXUSDT",
  "CFXUSDT", "SKLUSDT", "ANKRUSDT", "HOTUSDT", "IOSTUSDT",
  "LRCUSDT", "STORJUSDT", "COTIUSDT", "OCEANUSDT", "ARPAUSDT",
  "APEUSDT", "CHZUSDT", "AXSUSDT", "IMXUSDT", "RNDRUSDT",
  "RUNEUSDT", "THETAUSDT", "IOTAUSDT", "WAVESUSDT",
];

export function computeSpreadPct(buyAsk: number, sellBid: number): number {
  // Directional spread: (sellBid - buyAsk) / buyAsk * 100
  if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid) || buyAsk <= 0) return Number.NaN;
  return ((sellBid - buyAsk) / buyAsk) * 100;
}
