import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env (server)
dotenv.config({ path: path.join(__dirname, '.env') });

const CONFIG = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
};

const api = axios.create({ timeout: 10000 });

function dataDir() {
  return path.join(__dirname, '..', 'data');
}

function tradesFile() {
  return path.join(dataDir(), 'trades.jsonl');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function stateFile() {
  return path.join(dataDir(), 'report-state.json');
}

function loadState() {
  const f = stateFile();
  if (!fs.existsSync(f)) return { baselineTs: null };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { baselineTs: null };
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

function summarize(events, { windowMin = 30 } = {}) {
  const state = loadState();

  // baselineTs: start of cumulative reporting window.
  // If not set, initialize to now and keep cumulative from that point forward.
  if (!state.baselineTs) {
    state.baselineTs = Date.now();
    saveState(state);
  }

  const baselineTs = state.baselineTs;
  const sinceRolling = Date.now() - windowMin * 60 * 1000;

  const cumulative = events.filter((e) => (e.ts || 0) >= baselineTs);
  const rolling = events.filter((e) => (e.ts || 0) >= sinceRolling);

  const sumBlock = (block) => {
    const entries = block.filter((e) => e.event === 'entry_alert');
    const closes = block.filter((e) => e.event === 'close_detected');
    const wins = closes.filter((c) => c.hit === 'TP');
    const losses = closes.filter((c) => c.hit === 'SL');
    const winrate = closes.length ? (wins.length / closes.length) : 0;
    return { entries: entries.length, closes: closes.length, wins: wins.length, losses: losses.length, winrate };
  };

  return {
    baselineTs,
    windowMin,
    rolling: sumBlock(rolling),
    cumulative: sumBlock(cumulative),
  };
}

function proposeChanges(summary) {
  const rec = [];
  // Simple heuristics (no price simulation): adjust strictness based on winrate and sample size
  if (summary.closes >= 8) {
    if (summary.winrate < 0.35) {
      rec.push('Bajar frecuencia: exigir mayor liquidez (subir MIN_VOLUME_24H) y/o aumentar confirmación (más estricta).');
      rec.push('Aumentar distancia SL (ATR_MULT) y/o bajar R:R para mejorar tasa de acierto (TAKE_PROFIT_R).');
    } else if (summary.winrate > 0.65) {
      rec.push('Estrategia saludable: podemos permitir más oportunidades (bajar prefilter) o subir R:R gradualmente.');
    } else {
      rec.push('Rendimiento medio: mantener parámetros y seguir juntando muestra.');
    }
  } else {
    rec.push('Muestra pequeña: seguir recolectando datos antes de cambios agresivos.');
  }
  return rec;
}

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log('⚠️ Missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID; printing:', text);
    return;
  }
  await api.post(CONFIG.telegram.apiUrl, { chat_id: CONFIG.telegram.chatId, text });
}

async function run() {
  const events = readJsonl(tradesFile());
  const summary = summarize(events, { windowMin: 30 });
  const rec = proposeChanges(summary.cumulative);

  const lines = [];
  lines.push('📊 Reporte 30m (rentabilidad / ejecución)');
  lines.push(`Baseline (acumulativo desde): ${new Date(summary.baselineTs).toISOString()}`);
  lines.push(`Rolling: últimas ${summary.windowMin} min`);
  lines.push(
    `Rolling → Entradas: ${summary.rolling.entries} | Cierres: ${summary.rolling.closes} | TP: ${summary.rolling.wins} | SL: ${summary.rolling.losses} | Winrate: ${(summary.rolling.winrate*100).toFixed(1)}%`
  );
  lines.push(
    `Acumulado → Entradas: ${summary.cumulative.entries} | Cierres: ${summary.cumulative.closes} | TP: ${summary.cumulative.wins} | SL: ${summary.cumulative.losses} | Winrate: ${(summary.cumulative.winrate*100).toFixed(1)}%`
  );
  lines.push('Sugerencias (basadas en acumulado):');
  for (const r of rec) lines.push(`- ${r}`);

  await sendTelegram(lines.join('\n'));
}

run().catch((e) => {
  console.error('report fatal:', e?.message || String(e));
  process.exitCode = 1;
});
