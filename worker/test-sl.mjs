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
  const res = await fetch(`${BASE}${endpoint}?${qs}&signature=${sign(qs)}`, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return JSON.parse(text);
}

// Probar con BNBUSDT SHORT - SL con STOP_MARKET tipo
async function testSL(symbol, side, qty, stopPrice) {
  const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
  console.log(`Testing STOP_MARKET: ${symbol} ${orderSide} qty=${qty} stopPrice=${stopPrice}`);
  try {
    const r = await sr('POST', '/fapi/v1/order', {
      symbol,
      side: orderSide,
      type: 'STOP_MARKET',
      stopPrice: stopPrice.toFixed(6),
      quantity: qty.toFixed(6),
      reduceOnly: true,
      timeInForce: 'GTE_GTC',
    });
    console.log('SUCCESS:', JSON.stringify(r));
    return r;
  } catch (e) {
    console.log('FAILED:', e.message.slice(0, 200));
    // Probar con stopPrice directo
    try {
      const r2 = await sr('POST', '/fapi/v1/order', {
        symbol,
        side: orderSide,
        type: 'STOP',
        stopPrice: stopPrice.toFixed(6),
        price: stopPrice.toFixed(6),
        quantity: qty.toFixed(6),
        reduceOnly: true,
        timeInForce: 'GTE_GTC',
      });
      console.log('STOP OK:', JSON.stringify(r2));
      return r2;
    } catch (e2) {
      console.log('STOP also FAILED:', e2.message.slice(0, 200));
    }
  }
  return null;
}

// Probar conconditional order
async function testConditional(symbol, side, qty, triggerPrice, triggerSide) {
  const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
  const trigSide = triggerSide === 'LOW' ? 'GREATER_THAN' : 'LESS_THAN';
  console.log(`Testing CONDITIONAL: ${symbol} ${orderSide} trigger=${triggerPrice} (${trigSide})`);
  try {
    const r = await sr('POST', '/fapi/v1/order', {
      symbol,
      side: orderSide,
      type: 'CONDITIONAL',
      triggerPrice: triggerPrice.toFixed(6),
      triggerSide,
      quantity: qty.toFixed(6),
      reduceOnly: true,
      timeInForce: 'GTE_GTC',
    });
    console.log('CONDITIONAL SUCCESS:', JSON.stringify(r));
    return r;
  } catch (e) {
    console.log('CONDITIONAL FAILED:', e.message.slice(0, 300));
  }
  return null;
}

// Obtener posicion BNBUSDT
const ts = Date.now();
const sig = sign(`timestamp=${ts}&recvWindow=60000`);
const r = await fetch(`${BASE}/fapi/v2/positionRisk?timestamp=${ts}&recvWindow=60000&signature=${sig}`, {
  headers: { 'X-MBX-APIKEY': API_KEY }
});
const positions = await r.json();
const bnbusdt = positions.find(p => p.symbol === 'BNBUSDT');
console.log('BNBUSDT position:', bnbusdt?.symbol, bnbusdt?.positionAmt, bnbusdt?.entryPrice);

if (bnbusdt && Math.abs(parseFloat(bnbusdt.positionAmt || 0)) > 0) {
  const amt = Math.abs(parseFloat(bnbusdt.positionAmt));
  const side = parseFloat(bnbusdt.positionAmt) > 0 ? 'LONG' : 'SHORT';
  const entry = parseFloat(bnbusdt.entryPrice);
  const sl = side === 'LONG' ? entry * 0.99 : entry * 1.01;
  const tp = side === 'LONG' ? entry * 1.02 : entry * 0.98;

  console.log(`\\nSide: ${side} | Entry: ${entry} | SL: ${sl} | TP: ${tp}`);

  // Test 1: STOP_MARKET
  await testSL('BNBUSDT', side, amt, sl);

  // Test 2: CONDITIONAL order
  await testConditional('BNBUSDT', side, amt, sl, side === 'LONG' ? 'LOW' : 'GREATER_THAN');
}
