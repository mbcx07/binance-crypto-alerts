import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { loadOpenTrades, saveOpenTrades, appendTradeEvent } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env for local/server runs
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const CONFIG = {
  binance: {
    baseUrl: 'https://fapi.binance.com',
    tickerPrice: '/fapi/v1/ticker/price',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  monitor: {
    // price polling cadence is controlled by the timer (systemd). Here we just do one pass.
    maxPerRun: parseInt(process.env.MONITOR_MAX_PER_RUN || '1000', 10),
  },
};

const api = axios.create({ timeout: 10000 });

async function getLastPrice(symbol) {
  const response = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.tickerPrice}`, {
    params: { symbol },
  });
  return parseFloat(response.data?.price);
}

function formatCloseMessage(t) {
  const pnl = typeof t.pnl === 'number' ? t.pnl : null;
  const pnlTxt = pnl == null ? '' : pnl >= 0 ? `✅ PnL: +${pnl.toFixed(4)}` : `❌ PnL: ${pnl.toFixed(4)}`;
  const hitTxt = t.hit === 'TP' ? '🎯 Take Profit' : t.hit === 'SL' ? '🛑 Stop Loss' : '⏹️ Close';
  return (
    `[15m][USDT-M] ${t.symbol} | CLOSE (${t.side})\n` +
    `${hitTxt} HIT\n` +
    `💰 Entry: ${t.entry.toFixed(6)}\n` +
    `📍 Exit: ${t.exit.toFixed(6)}\n` +
    `🛑 SL: ${t.sl.toFixed(6)}\n` +
    `🎯 TP: ${t.tp.toFixed(6)}\n` +
    (pnlTxt ? `${pnlTxt}\n` : '') +
    `🧾 ID: ${t.id}`
  );
}

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log('⚠️ Missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID; printing:', text);
    return;
  }
  await api.post(CONFIG.telegram.apiUrl, {
    chat_id: CONFIG.telegram.chatId,
    text,
  });
}

function estimatePnlUSDT({ side, entry, exit, qty }) {
  if (!qty || !entry || !exit) return null;
  return side === 'LONG' ? (exit - entry) * qty : (entry - exit) * qty;
}

async function runOnce() {
  const state = loadOpenTrades();
  const open = (state.trades || []).filter((t) => t.status === 'OPEN');

  if (!open.length) {
    console.log('ℹ️ No open trades to monitor.');
    return;
  }

  const toCheck = open.slice(0, CONFIG.monitor.maxPerRun);
  let changed = false;

  for (const t of toCheck) {
    try {
      const px = await getLastPrice(t.symbol);
      if (!Number.isFinite(px)) continue;

      const hitTP = t.side === 'LONG' ? px >= t.tp : px <= t.tp;
      const hitSL = t.side === 'LONG' ? px <= t.sl : px >= t.sl;

      if (!hitTP && !hitSL) continue;

      const hit = hitTP ? 'TP' : 'SL';
      const qty = t.qty ?? null;
      const pnl = qty ? estimatePnlUSDT({ side: t.side, entry: t.entry, exit: px, qty }) : null;

      t.status = 'CLOSED';
      t.closedAt = Date.now();
      t.exit = px;
      t.hit = hit;
      t.pnl = pnl;

      appendTradeEvent({
        event: 'close_detected',
        symbol: t.symbol,
        side: t.side,
        entryPrice: t.entry,
        exitPrice: px,
        sl: t.sl,
        tp: t.tp,
        hit,
        id: t.id,
        pnl,
      });

      await sendTelegram(formatCloseMessage({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        entry: t.entry,
        exit: px,
        sl: t.sl,
        tp: t.tp,
        hit,
        pnl,
      }));

      changed = true;
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`monitor: error for ${t.symbol}:`, msg);
    }
  }

  if (changed) saveOpenTrades(state);
}

runOnce().catch((e) => {
  console.error('monitor: fatal:', e?.message || String(e));
  process.exitCode = 1;
});
