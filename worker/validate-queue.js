/**
 * Validation queue — signals pending AI confirmation before being sent to user.
 *
 * Pipeline:
 *  1. scanner/alpha-scan finds a signal
 *  2. Signal gets written to data/validate-queue.json (status: PENDING)
 *  3. Pia (this agent) reads the queue during heartbeat
 *  4. For each PENDING item:
 *       - Search web for recent news/events on the symbol
 *       - Analyze price action context
 *       - CONFIRM or REJECT
 *       - Update status + reason
 *  5. monitor.js only sends signals with status=CONFIRMED to Telegram
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'validate-queue.json');
const OPEN_TRADES_FILE = path.join(DATA_DIR, 'open-trades.json');

export function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function writeQueue(items) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}

export function enqueueSignal(signal) {
  const queue = readQueue();
  // Avoid duplicates: same symbol with PENDING or recent (< 30 min)
  const recent = Date.now() - 30 * 60 * 1000;
  if (queue.find((q) => q.symbol === signal.symbol && (q.status === 'PENDING' || (q.ts || 0) > recent))) return;
  queue.push({ ...signal, status: 'PENDING', validatedBy: null, validationReason: null, ts: signal.ts || Date.now() });
  writeQueue(queue);
}

export function updateStatus(id, status, reason, extra = {}) {
  const queue = readQueue().map((q) =>
    q.id === id
      ? { ...q, status, validationReason: reason, validatedAt: Date.now(), ...extra }
      : q
  );
  writeQueue(queue);
}

export function getConfirmed() {
  return readQueue().filter((q) => q.status === 'CONFIRMED');
}

export function getPending() {
  return readQueue().filter((q) => q.status === 'PENDING');
}

export function markConfirmedAsTrade(id) {
  const queue = readQueue().map((q) =>
    q.id === id ? { ...q, status: 'TRADE_ACTIVE', enteredAt: Date.now() } : q
  );
  writeQueue(queue);

  // Also register in open-trades.json so monitor tracks SL/TP
  const signal = queue.find((q) => q.id === id);
  if (!signal) return;

  let openTrades = { trades: [] };
  if (fs.existsSync(OPEN_TRADES_FILE)) {
    try { openTrades = JSON.parse(fs.readFileSync(OPEN_TRADES_FILE, 'utf8')); } catch {}
  }

  const tradeId = `${signal.symbol}:${signal.side}:${id}`;
  const trade = {
    id: tradeId,
    symbol: signal.symbol,
    side: signal.side,
    entry: null,
    entryPrice: null,
    sl: signal.sl,
    tp: signal.tp,
    status: 'OPEN',
    ts: Date.now(),
    meta: { strategyId: signal.source, confidence: signal.confidence },
  };

  openTrades.trades.push(trade);
  fs.writeFileSync(OPEN_TRADES_FILE, JSON.stringify(openTrades, null, 2));
}

export function cleanOld(hoursOld = 24) {
  const cutoff = Date.now() - hoursOld * 3600 * 1000;
  const queue = readQueue().filter(
    (q) => q.status === 'PENDING' || (q.ts || 0) > cutoff
  );
  writeQueue(queue);
}
