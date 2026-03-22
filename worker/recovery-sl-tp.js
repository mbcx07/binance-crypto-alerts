/**
 * recovery-sl-tp.js — Coloca SL/TP en posiciones abiertas que no lo tienen.
 * Ejecutar manualmente o via cron.
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const API_KEY    = process.env.FUTURES_API_KEY;
const API_SECRET = process.env.FUTURES_API_SECRET;
const BASE       = 'https://fapi.binance.com';

function sign(qs) {
  return crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
}

async function sr(method, endpoint, params = {}) {
  const ts   = Date.now();
  const recv = 60000;
  const qp   = { ...params, timestamp: ts, recvWindow: recv };
  const qs   = Object.entries(qp).map(([k,v]) => `${k}=${v}`).join('&');
  const sig  = sign(qs);
  const url  = `${BASE}${endpoint}?${qs}&signature=${sig}`;
  const res  = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  if (!res.ok) { const e = await res.text(); throw new Error(`Binance ${res.status}: ${e}`); }
  return res.json();
}

import { getAllPositions } from './trader.js';

async function getOpenOrders(symbol) {
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', process.env.FUTURES_API_SECRET)
    .update(`timestamp=${ts}&recvWindow=60000&symbol=${symbol}`)
    .digest('hex');
  const r = await fetch(
    `https://fapi.binance.com/fapi/v1/openOrders?timestamp=${ts}&recvWindow=60000&symbol=${symbol}&signature=${sig}`,
    { headers: { 'X-MBX-APIKEY': process.env.FUTURES_API_KEY } }
  );
  return r.json();
}

async function getKlines(symbol, interval = '1m', limit = 14) {
  const r = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  return r.json();
}

function computeATR(klines) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const hl  = highs[i]  - lows[i];
    const hc  = Math.abs(highs[i]  - closes[i-1]);
    const lc  = Math.abs(lows[i]   - closes[i-1]);
    trs.push(Math.max(hl, hc, lc));
  }
  const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  return atr;
}

async function placeSLTP(symbol, side, qty, entryPrice, atr) {
  const slPrice = side === 'LONG' ? entryPrice - atr * 1.5 : entryPrice + atr * 1.5;
  const tpPrice = side === 'LONG' ? entryPrice + atr * 2.5 : entryPrice - atr * 2.5;
  const sellSide = side === 'LONG' ? 'SELL' : 'BUY';

  console.log(`[Recovery] ${symbol} | Entry: ${entryPrice} | ATR: ${atr.toFixed(6)}`);
  console.log(`[Recovery]   -> SL: ${slPrice.toFixed(6)} | TP: ${tpPrice.toFixed(6)}`);

  let slPlaced = false, tpPlaced = false;

  if (side === 'LONG') {
    // SL: precio baja al SL
    try {
      await sr('POST', '/fapi/v1/algoOrders', {
        symbol, side: 'SELL', orderType: 'STOP', price: slPrice.toFixed(6),
        stopPrice: slPrice.toFixed(6), quantity: qty.toFixed(6), reduceOnly: true,
      });
      slPlaced = true;
      console.log(`[Recovery]   SL placed at ${slPrice.toFixed(6)}`);
    } catch (e) { console.error(`[Recovery]   SL failed: ${e.message}`); }
    // TP: precio sube al TP
    try {
      await sr('POST', '/fapi/v1/algoOrders', {
        symbol, side: 'SELL', orderType: 'STOP', price: tpPrice.toFixed(6),
        stopPrice: tpPrice.toFixed(6), quantity: qty.toFixed(6), reduceOnly: true,
      });
      tpPlaced = true;
      console.log(`[Recovery]   TP placed at ${tpPrice.toFixed(6)}`);
    } catch (e) { console.error(`[Recovery]   TP failed: ${e.message}`); }
  } else {
    // SHORT: SL: precio sube
    try {
      await sr('POST', '/fapi/v1/algoOrders', {
        symbol, side: 'BUY', orderType: 'STOP', price: slPrice.toFixed(6),
        stopPrice: slPrice.toFixed(6), quantity: qty.toFixed(6), reduceOnly: true,
      });
      slPlaced = true;
      console.log(`[Recovery]   SL placed at ${slPrice.toFixed(6)}`);
    } catch (e) { console.error(`[Recovery]   SL failed: ${e.message}`); }
    // TP: precio baja
    try {
      await sr('POST', '/fapi/v1/algoOrders', {
        symbol, side: 'BUY', orderType: 'STOP', price: tpPrice.toFixed(6),
        stopPrice: tpPrice.toFixed(6), quantity: qty.toFixed(6), reduceOnly: true,
      });
      tpPlaced = true;
      console.log(`[Recovery]   TP placed at ${tpPrice.toFixed(6)}`);
    } catch (e) { console.error(`[Recovery]   TP failed: ${e.message}`); }
  }

  return { slPlaced, tpPlaced };
}

async function main() {
  const positions = await getAllPositions();
  console.log(`[Recovery] Found ${positions.length} open positions`);

  for (const pos of positions) {
    const symbol = pos.symbol;
    const amt    = Math.abs(parseFloat(pos.positionAmt));
    const side   = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry  = parseFloat(pos.entryPrice);

    if (!amt || !entry) continue;

    // Verificar si ya tiene SL/TP
    let openOrders = [];
    try { openOrders = await getOpenOrders(symbol); } catch {}

    const hasSL = Array.isArray(openOrders) && openOrders.some(o => o.type === 'STOP_MARKET');
    const hasTP = Array.isArray(openOrders) && openOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');

    if (hasSL && hasTP) {
      console.log(`[Recovery] ${symbol}: SL+TP ya existen, omitir`);
      continue;
    }

    console.log(`[Recovery] ${symbol}: ${side} | Sin SL=${!hasSL} Sin TP=${!hasTP}`);

    // Calcular ATR desde 1m velas
    let atr;
    try {
      const klines = await getKlines(symbol, '1m', 15);
      atr = computeATR(klines);
    } catch (e) {
      console.error(`[Recovery]   ATR error: ${e.message}`);
      atr = entry * 0.01; // fallback 1% de precio
    }

    await placeSLTP(symbol, side, amt, entry, atr);
  }
}

main().catch(e => { console.error('[Recovery] Fatal:', e.message); process.exitCode = 1; });
