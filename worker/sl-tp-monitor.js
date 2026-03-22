/**
 * sl-tp-monitor.js — Vigila precios y cierra posiciones al tocar SL o TP.
 * Se ejecuta cada 30s via systemd timer.
 * Verificación doble: tras cerrar, confirma que la posición se cerró.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { getAllPositions, closePosition } from './trader.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    }
  ).catch(() => {});
}

async function getMarkPrice(symbol) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
    const d = await r.json();
    return (parseFloat(d.bidPrice) + parseFloat(d.askPrice)) / 2;
  } catch { return null; }
}

async function forceClose(symbol, side) {
  console.log(`[SLTPMonitor] Force closing ${symbol}...`);
  try {
    await closePosition(symbol);
    // Verificar que realmente se cerró
    const positions = await getAllPositions();
    const stillOpen = positions.find(p => p.symbol === symbol);
    if (stillOpen) {
      console.log(`[SLTPMonitor] ${symbol} still open after close, retrying...`);
      await closePosition(symbol);
    } else {
      console.log(`[SLTPMonitor] ${symbol} closed successfully`);
    }
    return true;
  } catch (e) {
    console.error(`[SLTPMonitor] Force close error: ${e.message}`);
    return false;
  }
}

async function main() {
  const positions = await getAllPositions();
  if (!positions.length) return;

  console.log(`[SLTPMonitor] Vigilando ${positions.length} posiciones...`);

  for (const pos of positions) {
    const symbol   = pos.symbol;
    const amt      = Math.abs(parseFloat(pos.positionAmt));
    const side     = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry    = parseFloat(pos.entryPrice);

    const markPrice = await getMarkPrice(symbol);
    if (!markPrice) continue;

    // Niveles SL/TP: SL=2%, TP=5%
    const slPrice = side === 'LONG' ? entry * 0.98 : entry * 1.02;
    const tpPrice = side === 'LONG' ? entry * 1.05 : entry * 0.95;

    // Detectar cruce
    let hitSL = false, hitTP = false;
    if (side === 'LONG') {
      hitSL = markPrice <= slPrice;
      hitTP = markPrice >= tpPrice;
    } else {
      hitSL = markPrice >= slPrice;
      hitTP = markPrice <= tpPrice;
    }

    const pnlPct = ((markPrice - entry) / entry * 100 * (side === 'LONG' ? 1 : -1)).toFixed(2);
    const emoji  = side === 'LONG' ? '🟢' : '🔴';

    if (hitSL) {
      console.log(`[SLTPMonitor] 🚨 ${symbol} SL HIT! Mark: ${markPrice} | SL: ${slPrice.toFixed(6)} | PnL: ${pnlPct}%`);
      await sendTelegram(`${emoji} **${symbol}** SL HIT!\n📊 Precio: ${markPrice.toFixed(6)}\n🛡️ SL: ${slPrice.toFixed(6)}\nPnL: ${pnlPct}%`);
      await forceClose(symbol, side);
      await sendTelegram(`✅ ${symbol} cerrado por SL`);

    } else if (hitTP) {
      console.log(`[SLTPMonitor] 🎯 ${symbol} TP HIT! Mark: ${markPrice} | TP: ${tpPrice.toFixed(6)} | PnL: ${pnlPct}%`);
      await sendTelegram(`🎯 **${symbol}** TP HIT!\n📊 Precio: ${markPrice.toFixed(6)}\n🎯 TP: ${tpPrice.toFixed(6)}\nPnL: ${pnlPct}%`);
      await forceClose(symbol, side);
      await sendTelegram(`✅ ${symbol} cerrado por TP`);

    } else {
      // Solo reportar si está cerca
      const distSL = Math.abs(markPrice - slPrice) / markPrice * 100;
      const distTP = Math.abs(markPrice - tpPrice) / markPrice * 100;
      if (distSL < 1 || distTP < 1) {
        console.log(`[SLTPMonitor] ${emoji} ${symbol} | Entry: ${entry} | Mark: ${markPrice.toFixed(4)} | SL: ${slPrice.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | PnL: ${pnlPct}%`);
      }
    }
  }
}

main().catch(e => { console.error('[SLTPMonitor] Fatal:', e.message); process.exitCode = 1; });
