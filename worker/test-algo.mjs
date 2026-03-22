import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config({ path: '/home/moises-beltran-castro/.openclaw/workspace/binance-crypto-alerts/worker/.env' });

const API_KEY = process.env.FUTURES_API_KEY;
const API_SECRET = process.env.FUTURES_API_SECRET;
const BASE = 'https://fapi.binance.com';

function sign(qs) { return crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex'); }

async function sr(method, endpoint, params = {}) {
  const ts = Date.now();
  const qp = { ...params, timestamp: ts, recvWindow: 60000 };
  const qs = Object.entries(qp).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = sign(qs);
  const url = `${BASE}${endpoint}?${qs}&signature=${sig}`;
  console.log(`[REQ] ${method} ${endpoint}`);
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/json' } });
  const text = await res.text();
  console.log(`[RES] ${res.status} | ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Probar: GET algo orders ( historial )
try {
  await sr('GET', '/fapi/v1/algoOrders', { symbol: 'BNBUSDT' });
} catch(e) { console.log('GET algo error:', e.message.slice(0,200)); }

// Probar: GET open orders con tipo
try {
  await sr('GET', '/fapi/v1/openOrders', { symbol: 'BNBUSDT' });
} catch(e) { console.log('GET openOrders error:', e.message.slice(0,200)); }

// Probar: POST algo order con BNBUSDT SHORT
try {
  await sr('POST', '/fapi/v1/algoOrders', {
    symbol: 'BNBUSDT',
    side: 'BUY',
    positionSide: 'SHORT',
    orderType: 'STOP',
    stopPrice: '630.00',
    quantity: '0.01',
    reduceOnly: true,
    timeInForce: 'GTE_GTC',
  });
} catch(e) { console.log('POST algo error:', e.message.slice(0,200)); }

// Probar con side 'BUY' sin positionSide (One-Way)
try {
  await sr('POST', '/fapi/v1/algoOrders', {
    symbol: 'BNBUSDT',
    side: 'BUY',
    orderType: 'STOP',
    stopPrice: '630.00',
    quantity: '0.01',
    reduceOnly: true,
    timeInForce: 'GTE_GTC',
  });
} catch(e) { console.log('POST algo (no pos side) error:', e.message.slice(0,200)); }
