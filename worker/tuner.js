import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const api = axios.create({ timeout: 10000 });

const CONFIG = {
  dataDir: path.join(__dirname, '..', 'data'),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  // Tuning objective
  targetWinrate: parseFloat(process.env.TUNE_TARGET_WINRATE || '0.70'),
  minSampleCloses: parseInt(process.env.TUNE_MIN_SAMPLE_CLOSES || '20', 10),
};

function tradesFile() {
  return path.join(CONFIG.dataDir, 'trades.jsonl');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  const lines = txt.split('\n').filter(Boolean);
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function envGet(key, fallback) {
  const v = process.env[key];
  return v == null || v === '' ? fallback : v;
}

function loadEnvLines() {
  if (!fs.existsSync(envPath)) return [];
  return fs.readFileSync(envPath, 'utf8').split('\n');
}

function setEnvKey(lines, key, value) {
  const re = new RegExp(`^${key}=`);
  let found = false;
  const out = lines.map((line) => {
    if (re.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function summarize(events, windowHours = 12) {
  const since = Date.now() - windowHours * 3600 * 1000;
  const closes = events.filter((e) => e.event === 'close_detected' && (e.ts || 0) >= since);
  const wins = closes.filter((c) => c.hit === 'TP').length;
  const losses = closes.filter((c) => c.hit === 'SL').length;
  const winrate = closes.length ? wins / closes.length : 0;
  return { windowHours, closes: closes.length, wins, losses, winrate };
}

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;
  await api.post(CONFIG.telegram.apiUrl, { chat_id: CONFIG.telegram.chatId, text });
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

async function tune() {
  const events = readJsonl(tradesFile());
  const s = summarize(events, 12);

  const target = CONFIG.targetWinrate;
  const minCloses = CONFIG.minSampleCloses;

  // Current knobs
  let minWin = parseFloat(envGet('BT_MIN_WINRATE', '0.70'));
  let topAlerts = parseInt(envGet('TOP_ALERTS', '3'), 10);
  let preselectTop = parseInt(envGet('PRESELECT_TOP', '30'), 10);
  let atrMult = parseFloat(envGet('ATR_MULT', '1.0'));
  let tpR = parseFloat(envGet('TAKE_PROFIT_R', '1.5'));
  let cooldown = parseInt(envGet('LOSS_SYMBOL_COOLDOWN_MIN', '240'), 10);

  const lines0 = loadEnvLines();
  let lines = [...lines0];

  let action = 'hold';

  // If not enough sample, tighten selection slightly rather than drastic changes
  if (s.closes < minCloses) {
    // Encourage more selective + reduce overtrading
    minWin = clamp(minWin + 0.02, 0.65, 0.90);
    topAlerts = clamp(topAlerts - 1, 1, 3);
    action = 'low_sample: tighten';
  } else if (s.winrate < target) {
    // Improve winrate: be MORE selective and MORE conservative on TP
    minWin = clamp(minWin + 0.03, 0.65, 0.92);
    tpR = clamp(tpR - 0.10, 1.0, 1.6); // closer TP => higher winrate
    atrMult = clamp(atrMult + 0.10, 0.9, 1.5); // a bit wider SL => fewer whipsaws
    preselectTop = clamp(preselectTop - 5, 15, 30); // focus on best liquidity/conditions
    topAlerts = clamp(topAlerts - 1, 1, 3);
    cooldown = clamp(cooldown + 60, 120, 720);
    action = 'under_target: tighten+conservative';
  } else {
    // Doing well: allow slightly more opportunities
    minWin = clamp(minWin - 0.01, 0.60, 0.92);
    tpR = clamp(tpR + 0.05, 1.0, 2.0);
    topAlerts = clamp(topAlerts + 1, 1, 3);
    preselectTop = clamp(preselectTop + 5, 15, 40);
    action = 'over_target: loosen';
  }

  // Persist
  lines = setEnvKey(lines, 'BT_MIN_WINRATE', minWin.toFixed(2));
  lines = setEnvKey(lines, 'TOP_ALERTS', String(topAlerts));
  lines = setEnvKey(lines, 'PRESELECT_TOP', String(preselectTop));
  lines = setEnvKey(lines, 'ATR_MULT', atrMult.toFixed(2));
  lines = setEnvKey(lines, 'TAKE_PROFIT_R', tpR.toFixed(2));
  lines = setEnvKey(lines, 'LOSS_SYMBOL_COOLDOWN_MIN', String(cooldown));

  atomicWrite(envPath, lines.join('\n'));

  // Background info messages disabled (Jefe requested only signals + closes)
  // const msg = [
  //   '🛠️ Auto-tune (cada hora)',
  //   `Ventana: 12h | Cierres=${s.closes} TP=${s.wins} SL=${s.losses} Winrate=${(s.winrate*100).toFixed(1)}% (target ${(target*100).toFixed(0)}%)`,
  //   `Acción: ${action}`,
  //   `Params: BT_MIN_WINRATE=${minWin.toFixed(2)} TOP_ALERTS=${topAlerts} PRESELECT_TOP=${preselectTop} ATR_MULT=${atrMult.toFixed(2)} TP_R=${tpR.toFixed(2)} COOLDOWN_MIN=${cooldown}`,
  //   'Nota: cambios aplican a la siguiente corrida del scanner.',
  // ].join('\n');
  // await sendTelegram(msg);
}

tune().catch(async (e) => {
  const msg = e?.message || String(e);
  try { await sendTelegram(`❌ Auto-tune error: ${msg}`); } catch {}
  process.exitCode = 1;
});
