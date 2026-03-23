/**
 * position-monitor.js — Mantiene 10 posiciones abiertas en Binance Futures.
 * Se ejecuta cada 60s via systemd timer.
 *
 * Flujo:
 *  1. Cuenta posiciones abiertas en Binance
 *  2. Si < 10 → ejecuta las mejores señales pendientes
 *  3. Registra resultado en Telegram
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const MAX_OPEN = 10;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const api = axios.create({ timeout: 10000 });

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await api.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
  ).catch(() => {});
}

import { getPosition } from './trader.js';
import { readQueue, updateStatus } from './validate-queue.js';
import { openPosition } from './trader.js';

async function getOpenPositions() {
  const positions = await getPosition(); // todas las abiertas
  return positions.map(p => ({
    symbol: p.symbol,
    side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
    qty: Math.abs(parseFloat(p.positionAmt)),
    entry: parseFloat(p.entryPrice),
    pnl: parseFloat(p.unrealizedProfit),
    leverage: parseInt(p.leverage || '1', 10),
  }));
}

async function main() {
  console.log('[PositionMonitor] Checking open positions...');

  const open = await getOpenPositions();
  // Solo contar como "nuestras" las posiciones que están en nuestra cola
  const queue = readQueue();
  const ourTracked = new Set(queue.filter(s => s.status === 'TRADE_ACTIVE').map(s => s.symbol));
  const ourOpen = open.filter(p => ourTracked.has(p.symbol));

  console.log(`[PositionMonitor] Binance: ${open.length} | Ours: ${ourOpen.length}/${MAX_OPEN}`);

  if (ourOpen.length >= MAX_OPEN) {
    // Todas nuestras slots están llenas — verificar si Belastrader tiene posiciones
    if (open.length > ourOpen.length) {
      console.log(`[PositionMonitor] Belastrader tiene ${open.length - ourOpen.length} posiciones — ignorando`);
    }
    return;
  }

  // Cuantas faltan?
  const slots = MAX_OPEN - ourOpen.length;
  console.log(`[PositionMonitor] ${slots} slots available — filling from queue...`);

  // Buscar mejores pendientes en cola
  const pending = queue
    .filter(s => s.status === 'PENDING')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 50); // tomar hasta 50 para encontrar fichas con notional suficiente

  if (!pending.length) {
    console.log('[PositionMonitor] No pending signals in queue');
    // Trigger alpha-scan para generar nuevas señales
    console.log('[PositionMonitor] Triggering alpha-scan...');
    const { spawn } = await import('child_process');
    spawn('node', ['alpha-scan.js'], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
    });
    return;
  }

  // Intentar ejecutar hasta `slots` posiciones
  let filled = 0;
  for (const sig of pending) {
    if (filled >= slots) break;

    // Verificar que no haya ya posición en ese símbolo
    if (open.some(p => p.symbol === sig.symbol)) continue;

    try {
      console.log(`[PositionMonitor] Executing: ${sig.symbol} ${sig.side} SL:${sig.sl} TP:${sig.tp}`);
      const result = await openPosition({
        symbol: sig.symbol,
        side: sig.side,
        sl: sig.sl,
        tp: sig.tp,
      });

      if (result && !result.test) {
        filled++;
        updateStatus(sig.id, 'TRADE_ACTIVE', 'Executed by PositionMonitor');

        const emoji = sig.side === 'LONG' ? '🟢' : '🔴';
        await sendTelegram(
          `${emoji} **NUEVA OPERACIÓN**\n` +
          `📊 ${sig.symbol} | ${sig.side}\n` +
          `💰 Qty: ${result.qty}\n` +
          `📌 Entry: $${result.entryPrice?.toFixed(6)}\n` +
          `🛡️ SL: $${sig.sl?.toFixed(6)}\n` +
          `🎯 TP: $${sig.tp?.toFixed(6)}\n` +
          `⚡ Leverage: ${result.leverage}x\n` +
          `🔢 Order ID: ${result.orderId}`
        );
      }
    } catch (e) {
      console.error(`[PositionMonitor] Error executing ${sig.symbol}: ${e.message}`);
    }
  }

  console.log(`[PositionMonitor] Filled ${filled} positions. Total open: ${open.length + filled}`);
}

main().catch(e => {
  console.error('[PositionMonitor] Fatal:', e.message);
  process.exitCode = 1;
});
