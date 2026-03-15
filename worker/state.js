import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function dataDir() {
  return path.join(__dirname, '..', 'data');
}

export function openTradesFile() {
  const dir = dataDir();
  ensureDir(dir);
  return path.join(dir, 'open-trades.json');
}

export function tradesJsonlFile() {
  const dir = dataDir();
  ensureDir(dir);
  return path.join(dir, 'trades.jsonl');
}

export function loadOpenTrades() {
  const file = openTradesFile();
  if (!fs.existsSync(file)) return { trades: [] };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.trades)) return { trades: [] };
    return parsed;
  } catch {
    return { trades: [] };
  }
}

export function saveOpenTrades(state) {
  const file = openTradesFile();
  const safe = { trades: Array.isArray(state?.trades) ? state.trades : [] };
  // Atomic write to avoid partial reads while monitor runs frequently
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
  fs.renameSync(tmp, file);
}

export function appendTradeEvent(event) {
  const file = tradesJsonlFile();
  const payload = { ts: Date.now(), ...event };
  fs.appendFileSync(file, JSON.stringify(payload) + '\n');
}

export function makeTradeId({ symbol, side, entryTs }) {
  return `${symbol}:${side}:${entryTs}`;
}
