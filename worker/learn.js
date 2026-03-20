import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const CONFIG = {
  dataDir: path.join(__dirname, '..', 'data'),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  windowHours: parseInt(process.env.LEARN_WINDOW_HOURS || '72', 10),
  minCloses: parseInt(process.env.LEARN_MIN_CLOSES || '20', 10),
};

const api = axios.create({ timeout: 10000 });

function tradesFile() {
  return path.join(CONFIG.dataDir, 'trades.jsonl');
}

function statsFile() {
  return path.join(CONFIG.dataDir, 'strategy-stats.json');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  return txt
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;
  await api.post(CONFIG.telegram.apiUrl, { chat_id: CONFIG.telegram.chatId, text });
}

function computePF(wins, losses) {
  // With SL/TP fixed RR, PF roughly wins/losses * RR; we keep simple and safe.
  if (losses === 0) return wins > 0 ? 99 : 0;
  return wins / losses;
}

async function run() {
  const since = Date.now() - CONFIG.windowHours * 3600 * 1000;
  const events = readJsonl(tradesFile()).filter((e) => (e.ts || 0) >= since);

  // Build id -> strategyId map from entry_alerts (so we can attribute closes)
  const idToStrategy = new Map();
  for (const e of events) {
    if (e.event === 'entry_alert' && e.id && e.strategyId) {
      idToStrategy.set(e.id, e.strategyId);
    }
  }

  // Aggregate by strategyId using close_detected
  const by = new Map();
  for (const e of events) {
    if (e.event !== 'close_detected') continue;
    const sid = e.strategyId || idToStrategy.get(e.id) || 'unknown';
    if (!by.has(sid)) by.set(sid, { strategyId: sid, closes: 0, wins: 0, losses: 0, lastTs: 0 });
    const s = by.get(sid);
    s.closes += 1;
    if (e.hit === 'TP') s.wins += 1;
    else if (e.hit === 'SL') s.losses += 1;
    s.lastTs = Math.max(s.lastTs, e.ts || 0);
  }

  const stats = [];
  for (const s of by.values()) {
    const winrate = s.closes ? s.wins / s.closes : 0;
    const pf = computePF(s.wins, s.losses);
    // Bandit-style score (UCB-ish) to allow exploration.
    const n = s.closes;
    const total = events.filter((e) => e.event === 'close_detected').length || 1;
    const ucb = winrate + Math.sqrt((2 * Math.log(total + 1)) / (n + 1));
    // Status: block if consistent bad performer
    const blocked = n >= CONFIG.minCloses && winrate < 0.45;

    stats.push({
      strategyId: s.strategyId,
      closes: n,
      wins: s.wins,
      losses: s.losses,
      winrate,
      pf,
      ucb,
      blocked,
      lastTs: s.lastTs,
    });
  }

  stats.sort((a, b) => b.ucb - a.ucb);

  atomicWrite(statsFile(), JSON.stringify({ ts: Date.now(), windowHours: CONFIG.windowHours, stats }, null, 2));

  // Background info messages disabled (Jefe requested only signals + closes)
  // const top = stats.slice(0, 5);
  // const msg = [
  //   '🧠 Learn update (por estrategia)',
  //   `Ventana: ${CONFIG.windowHours}h | estrategias=${stats.length}`,
  //   'Top 5:',
  //   ...top.map((s) => `- ${s.strategyId}: closes=${s.closes} win=${(s.winrate*100).toFixed(1)}% PF≈${s.pf.toFixed(2)} blocked=${s.blocked}`),
  // ].join('\n');
  // await sendTelegram(msg);
}

run().catch(async (e) => {
  const msg = e?.message || String(e);
  try { await sendTelegram(`❌ Learn error: ${msg}`); } catch {}
  process.exitCode = 1;
});
