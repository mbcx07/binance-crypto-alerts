/**
 * close-all.js — Cierra todas las posiciones abiertas en Binance Futures.
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
  const text = await res.text();
  if (!res.ok) throw new Error(`Binance ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  // Obtener todas las posiciones abiertas
  const ts   = Date.now();
  const sig  = sign(`timestamp=${ts}&recvWindow=60000`);
  const r    = await fetch(`${BASE}/fapi/v2/positionRisk?timestamp=${ts}&recvWindow=60000&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const positions = await r.json();

  const open = positions.filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
  console.log(`Found ${open.length} open positions`);

  for (const pos of open) {
    const symbol = pos.symbol;
    const amt    = Math.abs(parseFloat(pos.positionAmt));
    const side   = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
    const entry  = parseFloat(pos.entryPrice);
    const pnl    = parseFloat(pos.unrealizedProfit);

    console.log(`Closing ${symbol} | ${side} | Qty: ${amt} | Entry: ${entry} | PNL: ${pnl}`);

    try {
      await sr('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity: amt.toFixed(6),
        reduceOnly: true,
      });
      console.log(`  -> Closed OK`);
    } catch (e) {
      console.error(`  -> Error: ${e.message}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; });
