/**
 * sl-tp-monitor.js — Vigila precios y cierra posiciones al tocar SL o TP.
 * Se ejecuta cada 30s via systemd timer.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { getAllPositions, closePosition, getPrice } from './trader.js';

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
  const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
  const d = await r.json();
  return (parseFloat(d.bidPrice) + parseFloat(d.askPrice)) / 2;
}


async function main() {
  const positions = await getAllPositions();
  if (!positions.length) return;

  console.log(`[SLTPMonitor] ${positions.length} posiciones vigiladas`);

  for (const pos of positions) {
    const symbol   = pos.symbol;
    const side     = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const qty      = Math.abs(parseFloat(pos.positionAmt));
    const entry    = parseFloat(pos.entryPrice);

    const markPrice = await getMarkPrice(symbol);
    const atr       = await getATR(symbol);

    if (!atr) continue;

    const slPrice = side === 'LONG' ? entry - (entry * 0.02) : entry + (entry * 0.02);
    const tpPrice = side === 'LONG' ? entry + (entry * 0.05) : entry - (entry * 0.05);

    const hitSL = side === 'LONG' ? markPrice <= slPrice : markPrice >= slPrice;
    const hitTP = side === 'LONG' ? markPrice >= tpPrice : markPrice <= tpPrice;

    const pnlPct = ((markPrice - entry) / entry * 100 * (side === 'LONG' ? 1 : -1)).toFixed(2);
    const emoji  = side === 'LONG' ? '🟢' : '🔴';

    if (hitSL) {
      console.log(`[SLTPMonitor] 🚨 ${symbol} SL HIT! Mark: ${markPrice} | SL: ${slPrice.toFixed(6)}`);
      await sendTelegram(`${emoji} **${symbol}** SL HIT!\nPrecio: ${markPrice.toFixed(6)}\nSL: ${slPrice.toFixed(6)}\nPnL: ${pnlPct}%`);
      try {
        await closePosition(symbol);
        await sendTelegram(`✅ ${symbol} cerrado por SL`);
      } catch (e) { console.error(`[SLTPMonitor] Close error: ${e.message}`); }

    } else if (hitTP) {
      console.log(`[SLTPMonitor] 🎯 ${symbol} TP HIT! Mark: ${markPrice} | TP: ${tpPrice.toFixed(6)}`);
      await sendTelegram(`🎯 **${symbol}** TP HIT!\nPrecio: ${markPrice.toFixed(6)}\nTP: ${tpPrice.toFixed(6)}\nPnL: ${pnlPct}%`);
      try {
        await closePosition(symbol);
        await sendTelegram(`✅ ${symbol} cerrado por TP`);
      } catch (e) { console.error(`[SLTPMonitor] Close error: ${e.message}`); }

    } else {
      const distSL = Math.abs(markPrice - slPrice) / markPrice * 100;
      const distTP = Math.abs(markPrice - tpPrice) / markPrice * 100;
      // Solo reportar si está a menos de 1% del SL o TP
      if (distSL < 1 || distTP < 1) {
        console.log(`[SLTPMonitor] ${emoji} ${symbol} | Entry: ${entry} | Mark: ${markPrice.toFixed(4)} | SL: ${slPrice.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | PnL: ${pnlPct}% | DistSL: ${distSL.toFixed(2)}%`);
      }
    }
  }
}

main().catch(e => { console.error('[SLTPMonitor] Fatal:', e.message); process.exitCode = 1; });
