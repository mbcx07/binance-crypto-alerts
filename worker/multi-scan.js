import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { rankTop3 } from './multi-engine.js';
import { loadOpenTrades, saveOpenTrades, appendTradeEvent, makeTradeId } from './state.js';
import { enqueueSignal } from './validate-queue.js';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function tradesJsonlPath() {
  return path.join(__dirname, '..', 'data', 'trades.jsonl');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env for server runs
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const CONFIG = {
  binance: {
    baseUrl: 'https://fapi.binance.com',
    exchangeInfo: '/fapi/v1/exchangeInfo',
    ticker24h: '/fapi/v1/ticker/24hr',
    klines: '/fapi/v1/klines',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  scan: {
    timeframe: process.env.SCAN_TIMEFRAME || '15m',
    lookback: parseInt(process.env.SCAN_LOOKBACK || '400', 10),
    minVolume24h: parseFloat(process.env.MIN_VOLUME_24H || '5000000'),
    universeLimit: parseInt(process.env.UNIVERSE_LIMIT || '545', 10), // 545 ≈ all USDT-M perp
    preselectTop: parseInt(process.env.PRESELECT_TOP || '30', 10),
    topAlerts: parseInt(process.env.TOP_ALERTS || '3', 10),
  },
  bt: {
    atrPeriod: parseInt(process.env.ATR_PERIOD || '14', 10),
    atrMult: parseFloat(process.env.ATR_MULT || '1.0'),
    takeProfitR: parseFloat(process.env.TAKE_PROFIT_R || '1.5'),
    timeStopCandles: parseInt(process.env.TIME_STOP_CANDLES || '12', 10),
    feeBps: parseFloat(process.env.BT_FEE_BPS || '4'),
    minTrades: parseInt(process.env.BT_MIN_TRADES || '3', 10),
  },
  risk: {
    lossSymbolCooldownMin: parseInt(process.env.LOSS_SYMBOL_COOLDOWN_MIN || '240', 10),
  },
};

const api = axios.create({ timeout: 30000 });

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log('⚠️ Missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID; printing:', text);
    return;
  }
  await api.post(CONFIG.telegram.apiUrl, { chat_id: CONFIG.telegram.chatId, text });
}

async function getExchangeInfo() {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.exchangeInfo}`);
  return data;
}

async function get24hTicker() {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker24h}`);
  return data;
}

async function getKlines(symbol, interval, limit) {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.klines}`, {
    params: { symbol, interval, limit },
  });
  return data;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeATRPercent(klines, atrPeriod = 14) {
  if (!Array.isArray(klines) || klines.length < atrPeriod + 2) return null;
  const last = klines[klines.length - 2];
  const price = parseFloat(last[4]);
  // quick ATR using mean of (high-low) last N
  const ranges = klines.slice(- (atrPeriod + 2), -2).map((k) => parseFloat(k[2]) - parseFloat(k[3]));
  const atr = mean(ranges);
  if (!atr || !price) return null;
  return atr / price;
}

function scorePrefilter({ quoteVolume, atrPct }) {
  // Simple: prefer liquidity + mid volatility
  const volScore = Math.log10(Math.max(1, quoteVolume));
  const atrScore = atrPct == null ? 0 : (atrPct > 0.003 && atrPct < 0.05) ? 2 : 0.5;
  return volScore + atrScore;
}

function dataDir() {
  return path.join(__dirname, '..', 'data');
}

async function run() {
  const ex = await getExchangeInfo();
  const symbols = (ex.symbols || []).filter(
    (s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING'
  );

  const tickers = await get24hTicker();
  const tmap = new Map(tickers.map((t) => [t.symbol, t]));

  const universe = symbols
    .map((s) => {
      const t = tmap.get(s.symbol);
      if (!t) return null;
      const qv = parseFloat(t.quoteVolume);
      if (!Number.isFinite(qv) || qv < CONFIG.scan.minVolume24h) return null;
      return { symbol: s.symbol, quoteVolume: qv, lastPrice: parseFloat(t.lastPrice) };
    })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, CONFIG.scan.universeLimit);

  // Prefilter Top 30 with one kline call each (light)
  const pre = [];
  for (const u of universe) {
    const kl = await getKlines(u.symbol, CONFIG.scan.timeframe, 60);
    const atrPct = computeATRPercent(kl, 14);
    pre.push({ ...u, atrPct, preScore: scorePrefilter({ quoteVolume: u.quoteVolume, atrPct }) });
  }
  pre.sort((a, b) => b.preScore - a.preScore);
  const top = pre.slice(0, CONFIG.scan.preselectTop);

  // Fetch full klines for top candidates
  const klinesBySymbol = {};
  for (const u of top) {
    klinesBySymbol[u.symbol] = await getKlines(u.symbol, CONFIG.scan.timeframe, CONFIG.scan.lookback);
  }

  const rank = rankTop3({
    klinesBySymbol,
    config: CONFIG.bt,
  });

  // Load live strategy stats (learning) to boost good performers and block bad ones
  const statsPath = path.join(__dirname, '..', 'data', 'strategy-stats.json');
  let strategyStats = new Map();
  if (fs.existsSync(statsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      const arr = parsed?.stats || [];
      strategyStats = new Map(arr.map((s) => [s.strategyId, s]));
    } catch {}
  }

  const ranked = (rank.ranked || []).filter((r) => {
    const st = strategyStats.get(r.strategyId);
    if (!st) return true; // no data yet
    return !st.blocked;
  }).map((r) => {
    const st = strategyStats.get(r.strategyId);
    const liveWin = st?.winrate;
    const boost = typeof liveWin === 'number' ? Math.max(0.7, Math.min(1.3, 0.7 + liveWin)) : 1.0;
    return { ...r, liveWinrate: liveWin ?? null, scoreAdj: r.expectancy * boost };
  }).sort((a, b) => {
    // Primary: adjusted score, then expectancy, then profit factor
    if (b.scoreAdj !== a.scoreAdj) return b.scoreAdj - a.scoreAdj;
    if (b.expectancy !== a.expectancy) return b.expectancy - a.expectancy;
    return (b.profitFactor || 0) - (a.profitFactor || 0);
  });

  // Convert ranked results into concrete trade alerts at last closed candle.
  // IMPORTANT: we only accept strategies with winrate >= BT_MIN_WINRATE.
  // Then we walk the ranked list until we build TOP_ALERTS actionable alerts.
  const alerts = [];
  for (const r of (ranked || rank.top3 || [])) {
    if (alerts.length >= CONFIG.scan.topAlerts) break;
    if (typeof r.winrate === 'number' && r.winrate < CONFIG.bt.minWinrate) continue;
    const kl = klinesBySymbol[r.symbol];
    const last = kl[kl.length - 2];
    const entry = parseFloat(last[4]);

    // Determine direction from strategy signal at last candle
    const closes = kl.map((k) => parseFloat(k[4]));
    const highs = kl.map((k) => parseFloat(k[2]));
    const lows = kl.map((k) => parseFloat(k[3]));

    // Rebuild strategies and pick exact one
    const { buildStrategies50 } = await import('./strategies.js');
    const strat = buildStrategies50().find((s) => s.id === r.strategyId);
    const dir = strat?.signal(closes.slice(0, closes.length - 1), highs.slice(0, highs.length - 1), lows.slice(0, lows.length - 1));
    if (!dir) continue;

    // SL/TP distances
    const atrPct = computeATRPercent(kl, CONFIG.bt.atrPeriod);
    const atr = atrPct ? atrPct * entry : null;
    if (!atr || atr <= 0) continue;

    const stopDist = atr * CONFIG.bt.atrMult;
    const tpDist = stopDist * CONFIG.bt.takeProfitR;
    const sl = dir === 'LONG' ? entry - stopDist : entry + stopDist;
    const tp = dir === 'LONG' ? entry + tpDist : entry - tpDist;

    alerts.push({
      symbol: r.symbol,
      side: dir,
      entry,
      sl,
      tp,
      rr: CONFIG.bt.takeProfitR,
      score: r.expectancy,
      stats: r,
      strategyId: r.strategyId,
    });
  }

  // Persist data
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'multi-top3.json'), JSON.stringify({ ts: Date.now(), preselected: top, rank }, null, 2));

  // Send alerts + register open trades for monitor
  const state = loadOpenTrades();
  const openNow = new Set((state.trades || []).filter((t) => t.status === 'OPEN').map((t) => t.symbol));
  const usedThisRun = new Set();

  // Cooldown symbols that recently hit SL
  const now = Date.now();
  const cooldownMs = CONFIG.risk.lossSymbolCooldownMin * 60 * 1000;
  const events = readJsonl(tradesJsonlPath());
  const lastSL = new Map();
  for (const e of events) {
    if (e?.event === 'close_detected' && e?.hit === 'SL' && e?.symbol) {
      const ts = Number(e.ts || 0);
      if (!lastSL.has(e.symbol) || ts > lastSL.get(e.symbol)) lastSL.set(e.symbol, ts);
    }
  }

  for (const a of alerts.slice(0, CONFIG.scan.topAlerts)) {
    // De-dup: only 1 trade per symbol at a time
    if (openNow.has(a.symbol) || usedThisRun.has(a.symbol)) continue;
    const slTs = lastSL.get(a.symbol);
    if (slTs && now - slTs < cooldownMs) continue;
    const type = a.side === 'LONG' ? 'BUY' : 'SELL';

    // Generate trade ID before saving to state
    const entryTs = Date.now();
    const id = makeTradeId({ symbol: a.symbol, side: a.side, entryTs });

    // Enqueue for Pia validation — NOT sent directly anymore
    enqueueSignal({
      id,
      symbol: a.symbol,
      side: a.side,
      entry: a.entry,
      sl: a.sl,
      tp: a.tp,
      rr: a.rr,
      strategyId: a.strategyId,
      source: 'Strategy',
      confidence: a.stats.winrate || 0.5,
      ts: entryTs,
    });



    state.trades = [
      ...(state.trades || []),
      {
        id,
        symbol: a.symbol,
        side: a.side,
        entry: a.entry,
        sl: a.sl,
        tp: a.tp,
        qty: null,
        status: 'OPEN',
        createdAt: entryTs,
        meta: { strategyId: a.strategyId },
      },
    ];
    appendTradeEvent({ event: 'entry_alert', id, symbol: a.symbol, side: a.side, entryPrice: a.entry, sl: a.sl, tp: a.tp, strategyId: a.strategyId });

    usedThisRun.add(a.symbol);
    openNow.add(a.symbol);
  }
  saveOpenTrades(state);

  // Background info messages disabled (Jefe requested only signals + closes)
  // await sendTelegram(`ℹ️ MultiScan: universe=${universe.length} preselect=${top.length} strategies=50 candidates=${rank.candidates} alerts=${alerts.length}`);
}

run().catch(async (e) => {
  const msg = e?.message || String(e);
  console.error('multi-scan fatal:', msg);
  try {
    await sendTelegram(`❌ MultiScan error: ${msg}`);
  } catch {}
  process.exitCode = 1;
});
