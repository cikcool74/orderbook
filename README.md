# Arb Scanner — Binance vs Bybit

Frontend: React + Vite (TypeScript) streaming best bid/ask from Binance USDT-M Futures and Bybit USDT Perp.  
Backend: optional Node aggregator that exposes combined WS + `/health`.

## Prereqs
- Node 18+ (ESM + Vite)

## Install deps
```sh
npm install
```
If you had an old `node_modules` / `package-lock.json`, wipe and reinstall to avoid stale deps.

## Backend (aggregator)
```sh
PORT=8787 SYMBOLS=BTCUSDT,ETHUSDT npm run server
```
Endpoints:
- HTTP: `http://localhost:8787/health`
- WS:   `ws://localhost:8787/ws`
Messages: `{ t:"q", v:"binance"|"bybit", s:"BTCUSDT", bid:123.4, ask:123.5, ts:169... }`

## Frontend (direct to exchanges)
```sh
npm run dev
# open http://localhost:5173
```
- Edit symbols in the textarea (one per line, USDT perps).
- HOT / HOT🔥 / CLOSE thresholds adjustable in the top bar.
- Sort modes: signal-first or absolute spread.

## Production build
```sh
npm run build
npm run preview
```
