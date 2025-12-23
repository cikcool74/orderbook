# TVAcademy Perp Arb Scanner

Web UI for monitoring cross-exchange spreads (Binance, Bybit, OKX, Bitget) with HOT/CLOSE signals, blinking alerts, virtual PnL logging, and depth snapshots.

## Features
- Spread engine with multi-venue best bid/ask
- HOT / HOT* / CLOSE state machine with thresholds
- Live table with status pills and L2 snapshots per venue
- Virtual PnL logging (open/close spread, balance delta)
- Backend relay for Bitget (+ OKX alt) via `npm run server`

## Quick start
```bash
# install deps
npm install

# frontend (Vite)
npm run dev

# backend relay (WS on :8787 for Bitget/OKX passthrough)
npm run server
```

Open `http://localhost:5173` (or shown Vite URL). For Bitget/OKX depth to appear, keep `npm run server` running.

## GitHub
Existing remote: `https://github.com/cikcool74/orderbook.git`

If pushing from local:
```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/cikcool74/orderbook.git
git push -u origin main
```

## Config
- HOT_SPREAD, CLOSE_SPREAD in code (App.tsx) — adjust to your strategy.
- Default symbols: ~30 liquid USDT perps (see `src/core/types.ts`).

## Notes
- Sandbox/logs: frontend logs close events; backend logs WS reconnects.
- Heartbeats/reconnects: WS clients auto-reconnect with simple retry.
