/**
 * sl-tp-monitor.js — Trailing Stop + Fixed TP para posiciones abiertas.
 * Se ejecuta cada segundo via systemd service (loop interno).
 *
 * Ratio 1:2 — SL 4% trailing / TP 8%
 * LONG:  trailing SL = peakPrice * 0.96 (sube con el precio)
 * SHORT: trailing SL = peakPrice * 1.04 (baja con el precio)
 * TP: 8% sobre entry (LONG=*1.08, SHORT=*0.92)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { getAllPositions, closePosition } from './trader.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const TRAILING_PCT      = 0.04; // 5% trailing (riesgo)
const TP_PCT            = 0.08; // 10% take profit (recompensa 1:2)

// Archivo para guardar el peak/lowest price de cada posición
const TRAIL_FILE = path.join(__dirname, '..', 'data', 'trailing-state.json');

function loadTrailState() {
  try {
    return JSON.parse(fs.readFileSync(TRAIL_FILE, 'utf8'));
  } catch { return {}; }
}

function saveTrailState(state) {
  fs.writeFileSync(TRAIL_FILE, JSON.stringify(state, null, 2));
}

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

async function forceClose(symbol) {
  try {
    await closePosition(symbol);
    const positions = await getAllPositions();
    if (positions.some(p => p.symbol === symbol)) {
      await closePosition(symbol);
    }
    return true;
  } catch (e) {
    console.error(`[TrailingSL] Close error: ${e.message}`);
    return false;
  }
}

async function main() {
  const positions = await getAllPositions();
  if (!positions.length) return;

  const trail = loadTrailState();
  let changed = false;

  for (const pos of positions) {
    const symbol = pos.symbol;
    const amt    = Math.abs(parseFloat(pos.positionAmt));
    const side   = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry  = parseFloat(pos.entryPrice);
    const markPrice = await getMarkPrice(symbol);
    if (!markPrice) continue;

    // Inicializar trail state si es nueva posición
    if (!trail[symbol]) {
      trail[symbol] = {
        entry,
        side,
        peak: markPrice,
        tpPrice: side === 'LONG' ? entry * 1.08 : entry * 0.95,
        trailingSL: side === 'LONG' ? entry * 0.96 : entry * 1.04,
      };
      changed = true;
      continue;
    }

    const state = trail[symbol];

    // Si cambió de dirección, reiniciar
    if (state.side !== side) {
      trail[symbol] = {
        entry, side, peak: markPrice,
        tpPrice: side === 'LONG' ? entry * 1.08 : entry * 0.95,
        trailingSL: side === 'LONG' ? entry * 0.96 : entry * 1.04,
      };
      changed = true;
      continue;
    }

    // ─── Actualizar peak/lowest ────────────────────────────────────────────
    if (side === 'LONG') {
      if (markPrice > state.peak) {
        state.peak = markPrice;
        state.trailingSL = state.peak * (1 - TRAILING_PCT);
        changed = true;
      }
    } else {
      if (markPrice < state.peak) {
        state.peak = markPrice; // lowest para SHORT
        state.trailingSL = state.peak * (1 + TRAILING_PCT);
        changed = true;
      }
    }

    // ─── Calcular PnL actual ───────────────────────────────────────────────
    const pnlPct = side === 'LONG'
      ? (markPrice - entry) / entry * 100
      : (entry - markPrice) / entry * 100;

    // ─── Verificar TP ─────────────────────────────────────────────────────
    let hitTP = false;
    if (side === 'LONG') {
      hitTP = markPrice >= state.tpPrice;
    } else {
      hitTP = markPrice <= state.tpPrice;
    }

    if (hitTP) {
      const emoji = side === 'LONG' ? '🟢' : '🔴';
      console.log(`[TrailingSL] 🎯 ${symbol} TP HIT! Price: ${markPrice} | TP: ${state.tpPrice.toFixed(6)} | PnL: ${pnlPct.toFixed(2)}%`);
      await sendTelegram(`${emoji} **${symbol}** 🎯 TP HIT!\n📊 Precio: ${markPrice.toFixed(6)}\n🎯 TP: ${state.tpPrice.toFixed(6)}\n📈 PnL: ${pnlPct.toFixed(2)}%`);
      if (await forceClose(symbol)) {
        delete trail[symbol];
        changed = true;
        await sendTelegram(`✅ ${symbol} cerrado por TP`);
      }
      continue;
    }

    // ─── Verificar Trailing SL ─────────────────────────────────────────────
    let hitSL = false;
    if (side === 'LONG') {
      hitSL = markPrice <= state.trailingSL;
    } else {
      hitSL = markPrice >= state.trailingSL;
    }

    if (hitSL) {
      const emoji = side === 'LONG' ? '🟢' : '🔴';
      console.log(`[TrailingSL] 🚨 ${symbol} TRAILING SL HIT! Price: ${markPrice} | TrailingSL: ${state.trailingSL.toFixed(6)} | PnL: ${pnlPct.toFixed(2)}%`);
      await sendTelegram(`${emoji} **${symbol}** 🚨 Trailing SL HIT!\n📊 Precio: ${markPrice.toFixed(6)}\n🛡️ SL: ${state.trailingSL.toFixed(6)}\n📈 PnL: ${pnlPct.toFixed(2)}%`);
      if (await forceClose(symbol)) {
        delete trail[symbol];
        changed = true;
        await sendTelegram(`✅ ${symbol} cerrado por SL`);
      }
      continue;
    }

    // ─── Reporte si hay cambios significativos ───────────────────────────
    const distToSL = Math.abs(markPrice - state.trailingSL) / markPrice * 100;
    if (distToSL < 1 || Math.abs(pnlPct) > 5) {
      const emoji = side === 'LONG' ? '🟢' : '🔴';
      console.log(`[TrailingSL] ${emoji} ${symbol} | Entry: ${entry.toFixed(4)} | Mark: ${markPrice.toFixed(4)} | SL: ${state.trailingSL.toFixed(4)} | Peak: ${state.peak.toFixed(4)} | PnL: ${pnlPct.toFixed(2)}% | DistSL: ${distToSL.toFixed(2)}%`);
    }
  }

  if (changed) saveTrailState(trail);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLoop() {
  while (true) {
    try {
      await main();
    } catch (e) {
      console.error('[TrailingSL] Error in loop:', e.message);
    }
    await sleep(1000); // 1 second between checks
  }
}

runLoop().catch(e => {
  console.error('[TrailingSL] Fatal:', e.message);
  process.exit(1);
});
