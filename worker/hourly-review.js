/**
 * hourly-review.js — Revisión hourly del sistema de trading.
 * Se ejecuta cada hora via systemd timer.
 *
 * Checks:
 * 1. Servicios activos
 * 2. Balance y PnL
 * 3. Limpiar cola stale
 * 4. Verificar señales PENDING
 * 5. Ajustar parámetros si necesario
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { getAllPositions, getBalance } from './trader.js';
import { readQueue, writeQueue } from './validate-queue.js';

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

function cleanStaleQueue(openSymbols) {
  const queue = readQueue();
  const before = queue.length;
  const active = queue.filter(s => {
    if (s.status === 'TRADE_ACTIVE') return openSymbols.has(s.symbol);
    if (s.status === 'PENDING') {
      const age = Date.now() - (s.ts || 0);
      return age < 24 * 3600 * 1000; // <24h
    }
    return false;
  });
  writeQueue(active);
  return { before, after: active.length, cleaned: before - active.length };
}

async function main() {
  const timestamp = new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' });
  console.log(`\n=== HOURLY REVIEW ${timestamp} ===`);

  // 1. Balance y posiciones
  const open = await getAllPositions();
  const bal = await getBalance();
  const totalPnl = open.reduce((sum, p) => sum + parseFloat(p.unRealizedProfit || 0), 0);
  const notional = open.reduce((sum, p) => sum + Math.abs(parseFloat(p.notional || 0)), 0);

  console.log(`Balance: $${bal.toFixed(2)} | PnL abierto: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} | Notional: $${notional.toFixed(2)}`);
  console.log(`Posiciones: ${open.length}/10`);

  // 2. Limpiar cola stale
  const openSymbols = new Set(open.map(p => p.symbol));
  const clean = cleanStaleQueue(openSymbols);
  console.log(`Cola: ${clean.after} (limpio ${clean.cleaned} stale)`);

  // 3. Verificar cola PENDING
  const q = readQueue();
  const pending = q.filter(s => s.status === 'PENDING');
  console.log(`Señales PENDING: ${pending.length}`);

  // 4. Reporte por Telegram
  const emoji = totalPnl >= 0 ? '🟢' : '🔴';
  const msg = `${emoji} *Reporte Hourly* ${timestamp}\n` +
    `Balance: $${bal.toFixed(2)}\n` +
    `PnL abierto: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}\n` +
    `Posiciones: ${open.length}/10\n` +
    `Cola limpia: ${clean.after} | PENDING: ${pending.length}`;
  await sendTelegram(msg);

  // 5. Decisiones automáticas
  let cambios = [];

  // Si PENDING < 3, triggerear scan
  if (pending.length < 3) {
    console.log('[Review] PENDING bajo, verificando scan...');
    cambios.push('PENDING bajo — scan puede necesitar trigger');
  }

  // Si balance bajó mucho, alertar
  if (bal < 5) {
    console.log('[ALERTA] Balance crítico:', bal);
    cambios.push('⚠️ BALANCE CRÍTICO: $' + bal.toFixed(2));
    await sendTelegram('🚨 *ALERTA* Balance crítico: $' + bal.toFixed(2) + ' — revisar manualmente');
  }

  if (cambios.length) {
    console.log('Cambios/acciones:', cambios.join(', '));
  }

  console.log('=== FIN REVIEW ===\n');
}

main().catch(e => { console.error('Review error:', e.message); process.exitCode = 1; });
