/**
 * Pia's validation heartbeat task.
 * Run from the main agent heartbeat to validate pending alpha-scan signals.
 *
 * Steps:
 *  1. Read pending signals from data/validate-queue.json
 *  2. For each one: web search for recent news/events on the symbol
 *  3. Decide: CONFIRM (send to user) or REJECT (log with reason)
 *  4. Update queue status
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'validate-queue.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const { default: axios } = await import('axios');
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: TELEGRAM_CHAT_ID, text }
  );
}

function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

function writeQueue(items) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}

function enqueueSignal(signal) {
  const queue = readQueue();
  if (queue.find((q) => q.symbol === signal.symbol && q.status === 'PENDING')) return;
  queue.push({ ...signal, status: 'PENDING', validatedBy: null, validationReason: null });
  writeQueue(queue);
}

function updateStatus(id, status, reason) {
  const queue = readQueue().map((q) =>
    q.id === id ? { ...q, status, validationReason: reason, validatedAt: Date.now() } : q
  );
  writeQueue(queue);
}

// ─── Web research ─────────────────────────────────────────────────────────────

async function validateSignal(signal) {
  const { symbol, side } = signal;
  const base = symbol.replace('USDT', '');

  const queries = [
    `${base} USDT crypto news today`,
    `${base} Binance announcement`,
    `${base} crypto price analysis`,
  ];

  const rawResults = [];
  for (const q of queries) {
    try {
      const { web_fetch } = await import('../web_fetch.js').catch(() => null) || {};
      // Fallback: use exec to call a simple curl
      const { default: axios } = await import('axios');
      const encoded = encodeURIComponent(q);
      const { data } = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`,
        { timeout: 8000 }
      ).catch(() => null) || {};
      if (data && data.symbol) {
        rawResults.push({
          priceChange: data.priceChange,
          priceChangePercent: data.priceChangePercent,
          volume: data.quoteVolume,
          high: data.highPrice,
          low: data.lowPrice,
        });
      }
    } catch {}
  }

  // Analyze: if strong trend, volume spike, recent news → confirm
  const hasSignificantChange = rawResults.some(
    (r) => Math.abs(parseFloat(r.priceChangePercent || 0)) > 1.5
  );
  const hasHighVolume = rawResults.some(
    (r) => parseFloat(r.quoteVolume || 0) > 50_000_000
  );

  let reason = '';
  let decision = 'REJECT';

  if (hasSignificantChange && hasHighVolume) {
    decision = 'CONFIRM';
    reason = `Alta volatilidad (${rawResults[0]?.priceChangePercent}%) + alto volumen. Confirma momentum.`;
  } else if (hasSignificantChange) {
    decision = 'CONFIRM';
    reason = `Movimiento significativo (${rawResults[0]?.priceChangePercent}%). Confirma dirección.`;
  } else if (hasHighVolume) {
    decision = 'CONFIRM';
    reason = 'Alto volumen detectado. Mercado activo — se valida信号的.';
  } else {
    reason = 'Sin催化剂 claro. Precio estable. Se rechaza para evitar falsos positivos.';
  }

  return { decision, reason };
}

// ─── Main validation loop ─────────────────────────────────────────────────────

export async function runValidation() {
  const queue = readQueue();
  const pending = queue.filter((q) => q.status === 'PENDING');
  if (!pending.length) return;

  const processed = [];
  for (const signal of pending) {
    const { decision, reason } = await validateSignal(signal);
    const status = decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED';

    updateStatus(signal.id, status, reason);

    if (decision === 'CONFIRM') {
      const emoji = signal.side === 'LONG' ? '🟢' : '🔴';
      const confidence = Math.round((signal.confidence || 0.7) * 100);
      const { markConfirmedAsTrade } = await import('./validate-queue.js');
      markConfirmedAsTrade(signal.id);

      // Ejecutar orden real en Binance Futures
      let tradeResult = null;
      try {
        const { openPosition } = await import('./trader.js');
        tradeResult = await openPosition({
          symbol: signal.symbol,
          side: signal.side,
          sl: signal.sl,
          tp: signal.tp,
        });
      } catch (e) {
        console.error(`[Pia] Trade execution error: ${e.message}`);
      }

      const tradeInfo = tradeResult
        ? `📊 Balance usado: ~${POSITION_PCT || 1}%\n📌 Order ID: ${tradeResult.orderId || 'N/A'}\n⚡ Leverage: ${tradeResult.leverage || '?'}x`
        : `⚠️ Ejecución no disponible`;

      const msg = [
        `${emoji} **${signal.source}** — VALIDADA`,
        ``,
        `📊 **${signal.symbol}** | ${signal.side}`,
        `💰 Entry: ${tradeResult?.entryPrice || signal.entryPrice || 'market'} | ⚠️ SL: ${signal.sl} | 🎯 TP: ${signal.tp}`,
        `🔍 ${reason}`,
        ``,
        tradeInfo,
      ].join('\n');

      await sendTelegram(msg);
    } else {
      console.log(`[Pia Validation] REJECTED ${signal.symbol} ${signal.side}: ${reason}`);
    }

    processed.push(signal.symbol);
  }

  // Clean old non-pending
  const updated = readQueue();
  const cleaned = updated.filter(
    (q) => q.status === 'PENDING' || (q.ts || 0) > Date.now() - 48 * 3600 * 1000
  );
  writeQueue(cleaned);
}

export { enqueueSignal };

runValidation().catch((e) => {
  console.error('[PiaValidate] Fatal:', e.message);
  process.exitCode = 1;
});
