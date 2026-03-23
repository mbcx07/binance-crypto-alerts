/**
 * trader.js - Ejecucion real en Binance Futures USDT-M
 * Recibe senales consolidadas (SL/TP/side/entry) y abre posiciones reales.
 * Usa 1% del balance por operacion, leverage maximo 20x.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ─── Config from .env ─────────────────────────────────────────────────────────

const API_KEY    = process.env.FUTURES_API_KEY    || '';
const API_SECRET = process.env.FUTURES_API_SECRET || '';
const POSITION_PCT = parseFloat(process.env.FUTURES_POSITION_PCT || '1'); // 1% del balance
const MAX_LEVERAGE = parseInt(process.env.FUTURES_MAX_LEVERAGE || '20', 10);
const TEST_MODE    = process.env.FUTURES_TEST_MODE === 'true';
const RECV_WINDOW  = 60000; // 60s recvWindow para binance

// ─── HMAC signing ─────────────────────────────────────────────────────────────

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET)
    .update(queryString)
    .digest('hex');
}

async function signedRequest(method, endpoint, params = {}) {
  const timestamp = Date.now();
  const queryParams = { ...params, timestamp, recvWindow: RECV_WINDOW };
  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = sign(queryString);
  const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Binance API ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Account info ─────────────────────────────────────────────────────────────

export async function getBalance() {
  const data = await signedRequest('GET', '/fapi/v2/balance');
  const usdt = data.find(b => b.asset === 'USDT');
  // balance = balance total (incluye PnL de posiciones abiertas)
  return usdt ? parseFloat(usdt.balance) : 0;
}

export async function getPosition(symbol) {
  if (!symbol) {
    const data = await signedRequest('GET', '/fapi/v2/positionRisk', {});
    return data.filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
  }
  const data = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol });
  return data[0] || null;
}

export async function getAllPositions() {
  const data = await signedRequest('GET', '/fapi/v2/positionRisk', {});
  return data.filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
}

export async function setLeverage(symbol, leverage) {
  await signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
}

export async function setCrossMarginMode(symbol) {
  try {
    await signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'CROSSED' });
  } catch (e) {
    // Si ya esta en cross, puede fallar - ignoramos
  }
}

// ─── Ticker price ─────────────────────────────────────────────────────────────

export async function getPrice(symbol) {
  const data = await signedRequest('GET', '/fapi/v1/ticker/price', { symbol });
  return parseFloat(data.price);
}

// ─── Open position ─────────────────────────────────────────────────────────────

export async function openPosition({ symbol, side, sl, tp, entryPrice }) {
  if (!API_KEY || !API_SECRET) {
    console.warn('[Trader] No API credentials configured');
    return null;
  }

  const balance = await getBalance();
  if (!balance) {
    console.error(`[Trader] No balance found for ${symbol}`);
    return null;
  }

  // Position size: 1% del balance
  const rawQtyUSDT = balance * (POSITION_PCT / 100);
  console.log(`[Trader] Balance: ${balance.toFixed(2)} USDT | Position size: ${rawQtyUSDT.toFixed(4)} USDT (${POSITION_PCT}%)`);

  // Obtener info del simbolo para decimals y minQty
  const exchangeInfo = await signedRequest('GET', '/fapi/v1/exchangeInfo');
  const symInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
  if (!symInfo) {
    console.error(`[Trader] Symbol ${symbol} not found in exchange info`);
    return null;
  }

  // Determinar leverage (maximo 20x)
  const maxLeverage = parseInt(symInfo.ctaZoneMaxLeverage || '20', 10);
  const leverage = Math.min(MAX_LEVERAGE, maxLeverage);
  console.log(`[Trader] Setting leverage ${leverage}x for ${symbol} (max allowed: ${maxLeverage}x)`);

  await setLeverage(symbol, leverage);

  // Cantidad en contratos (con leverage aplicado)
  const price = entryPrice || await getPrice(symbol);
  const qty = (rawQtyUSDT * leverage) / price;

  // Redondear segun precision del simbolo
  const lotSizeFilter = symInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const stepSize = parseFloat(lotSizeFilter?.stepSize || '1');
  const minQty = parseFloat(lotSizeFilter?.minQty || '0');
  const qtyPrecision = stepSize < 1 ? Math.ceil(-Math.log10(stepSize)) : 0;
  let qtyRounded = Math.floor(qty / stepSize) * stepSize;

  if (qtyRounded < minQty) {
    console.error(`[Trader] Quantity ${qtyRounded} below min ${minQty}`);
    return null;
  }

  // Verificar notional >= $5 (minimo de Binance)
  const notional = qtyRounded * price;
  if (notional < 5) {
    console.error(`[Trader] Notional ${notional.toFixed(2)} < $5 minimum. Increase position size.`);
    return null;
  }

  console.log(`[Trader] Opening ${side} ${symbol} | Qty: ${qtyRounded} | Notional: $${notional.toFixed(2)} | Entry: ${price}`);

  if (TEST_MODE) {
    console.log(`[Trader] TEST MODE - no real order placed`);
    return { test: true, symbol, side, qty: qtyRounded, price, sl, tp };
  }

  // ─── Market order (One-Way mode — no positionSide) ────────────────────────
  const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

  const marketOrder = await signedRequest('POST', '/fapi/v1/order', {
    symbol,
    side: orderSide,
    type: 'MARKET',
    quantity: qtyRounded.toFixed(qtyPrecision),
  });

  console.log(`[Trader] Market order filled: ${marketOrder.orderId}`);
  const fillPrice = parseFloat(marketOrder.avgPrice || price);

  // ─── SL order (stop loss algo) ─────────────────────────────────────────────
  const slOrderSide = side === 'LONG' ? 'SELL' : 'BUY';

  try {
    await signedRequest('POST', '/fapi/v1/algoOrders', {
      symbol,
      side: slOrderSide,
      orderType: 'STOP',
      price: sl.toFixed(6),
      stopPrice: sl.toFixed(6),
      quantity: qtyRounded.toFixed(qtyPrecision),
      reduceOnly: true,
      timeInForce: 'GTE_GTC',
    });
    console.log(`[Trader] SL set at ${sl}`);
  } catch (e) {
    console.error(`[Trader] Failed to set SL: ${e.message}`);
  }

  // ─── TP order (take profit algo) ──────────────────────────────────────────
  const tpOrderSide = side === 'LONG' ? 'SELL' : 'BUY';

  try {
    await signedRequest('POST', '/fapi/v1/algoOrders', {
      symbol,
      side: tpOrderSide,
      orderType: 'STOP',
      price: tp.toFixed(6),
      stopPrice: tp.toFixed(6),
      quantity: qtyRounded.toFixed(qtyPrecision),
      reduceOnly: true,
      timeInForce: 'GTE_GTC',
    });
    console.log(`[Trader] TP set at ${tp}`);
  } catch (e) {
    console.error(`[Trader] Failed to set TP: ${e.message}`);
  }

  return {
    orderId: marketOrder.orderId,
    symbol,
    side,
    qty: qtyRounded,
    entryPrice: fillPrice,
    notional,
    sl,
    tp,
    leverage,
  };
}

// ─── Close position ───────────────────────────────────────────────────────────

export async function closePosition(symbol) {
  const pos = await getPosition(symbol);
  if (!pos || Math.abs(parseFloat(pos.positionAmt || 0)) === 0) {
    console.log(`[Trader] No open position for ${symbol}`);
    return null;
  }

  const qty = Math.abs(parseFloat(pos.positionAmt));
  const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';

  await signedRequest('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: qty.toFixed(6),
    reduceOnly: true,
  });

  console.log(`[Trader] Closed ${symbol} position`);
  return true;
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function healthCheck() {
  try {
    const balance = await getBalance();
    console.log(`[Trader] Health OK | Balance: ${balance.toFixed(2)} USDT`);
    return true;
  } catch (e) {
    console.error(`[Trader] Health FAIL: ${e.message}`);
    return false;
  }
}
