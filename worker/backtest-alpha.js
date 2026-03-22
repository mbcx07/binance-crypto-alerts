// backtest-alpha.js — Backtest completo de pro_ema_bounce_tv en todas las symbols
// Usage: node backtest-alpha.js [topN] [lookbackKlines]
// Output: top 10 symbols ranked by net profit + win rate

import axios from 'axios';

const BINANCE_BASE = 'https://api.binance.com';
const TICKER = '/api/v3/ticker';
const KLINES = '/api/v3/klines';

const TOP_N = parseInt(process.argv[2] || '100', 10);
const LOOKBACK = parseInt(process.argv[3] || '200', 10); // velas de 15m (200 × 15m = 50h)
const TIMEFRAME = '15m';

// ─── Indicators ───────────────────────────────────────────────────────────────

function computeEmaSeries(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function computeAtr(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 2) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const hl  = highs[i]  - lows[i];
    const hpc  = Math.abs(highs[i]  - closes[i - 1]);
    const lpc  = Math.abs(lows[i]   - closes[i - 1]);
    trs.push(Math.max(hl, hpc, lpc));
  }
  const slice = trs.slice(-period);
  const k = 2 / (period + 1);
  let atr = slice[0];
  for (let i = 1; i < slice.length; i++) atr = slice[i] * k + atr * (1 - k);
  return atr;
}

// ─── Strategy signal (simplificado para backtest) ────────────────────────────
// Lógica: bearish = EMA8 < EMA14 < EMA50 Y todas cayendo
// Entrada SHORT: precio toca o supera EMA8 (rebote) y gira
// No requiere rechazo visible perfecto — usa condición de reversión aprox.

function getSignal(closes, highs, lows, idx) {
  if (idx < 55 || idx >= closes.length - 2) return null;

  const sub = closes.slice(0, idx + 1);
  const subH = highs.slice(0, idx + 1);
  const subL = lows.slice(0, idx + 1);

  const e8s  = computeEmaSeries(sub, 8);
  const e14s = computeEmaSeries(sub, 14);
  const e50s = computeEmaSeries(sub, 50);
  if (!e8s || !e14s || !e50s) return null;

  const c   = closes[idx];
  const h   = highs[idx];
  const l   = lows[idx];
  const e8  = e8s.at(-1);
  const e14 = e14s.at(-1);
  const e50 = e50s.at(-1);

  // Filtro BAJ: todas las EMA cayendo y precio debajo de EMA50
  const allFalling = e8 < e8s.at(-2) && e14 < e14s.at(-2) && e50 < e50s.at(-2);
  const bearAlign  = e8 < e14 && e14 < e50 && c < e50;

  // Rebote: mínimo devela anterior cerca de EMA (within 1.5 ATR)
  const atr = computeAtr(subH, subL, sub, 14);
  if (!atr) return null;
  const prevL = lows[idx - 1];
  const distToEma = Math.abs(prevL - e8s.at(-2));
  const touchEma = distToEma < atr * 1.5;

  // Rechazo: vela actual cerró abajo Y alto superó EMA (rechazo hacia abajo)
  const rejected = h > e8 && c < e8;

  if (bearAlign && allFalling && touchEma && rejected) return 'SHORT';

  // Filtro ALC
  const allRising  = e8 > e8s.at(-2) && e14 > e14s.at(-2) && e50 > e50s.at(-2);
  const bullAlign  = e8 > e14 && e14 > e50 && c > e50;
  const prevH = highs[idx - 1];
  const touchEmaBull = Math.abs(prevH - e8s.at(-2)) < atr * 1.5;
  const rejectedDown = l < e8 && c > e8;

  if (bullAlign && allRising && touchEmaBull && rejectedDown) return 'LONG';

  return null;
}

// ─── Backtest single candle ───────────────────────────────────────────────────

function backtestSignal(closes, highs, lows, idx, side, atr) {
  const entry = closes[idx];
  const slDist = atr * 1.8;
  const tpDist  = slDist * 2.0;
  const sl = side === 'LONG' ? entry - slDist : entry + slDist;
  const tp = side === 'LONG' ? entry + tpDist : entry - tpDist;

  // Simulate forward
  for (let i = idx + 1; i < closes.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];

    if (side === 'LONG') {
      if (c <= sl) return { exit: sl, hit: 'SL', pnl: -slDist, pct: -slDist / entry };
      if (c >= tp) return { exit: tp, hit: 'TP', pnl: tpDist, pct: tpDist / entry };
    } else {
      if (c >= sl) return { exit: sl, hit: 'SL', pnl: -slDist, pct: -slDist / entry };
      if (c <= tp) return { exit: tp, hit: 'TP', pnl: tpDist, pct: tpDist / entry };
    }
  }
  return null; // no close within data
}

// ─── Fetch all symbols ────────────────────────────────────────────────────────

async function fetchTopSymbols(limit = 100) {
  const { data } = await axios.get(`${BINANCE_BASE}${KLINES}`, {
    params: { symbol: 'BTCUSDT', interval: '15m', limit: 5 }
  });
  // Get all USDT pairs from 24h ticker
  const { data: tickers } = await axios.get(`${BINANCE_BASE}/api/v3/ticker/24hr`);
  return tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map(t => t.symbol);
}

async function fetchKlines(symbol, limit = 200) {
  const { data } = await axios.get(`${BINANCE_BASE}${KLINES}`, {
    params: { symbol, interval: TIMEFRAME, limit }
  });
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n🔍 AlphaSight Backtest — ${TOP_N} symbols, ${LOOKBACK} velas ${TIMEFRAME}\n`);

const symbols = await fetchTopSymbols(TOP_N);
console.log(`📊 Screener: ${symbols.length} symbols fetched (memecoins/altcoins included)\n`);

const results = [];

for (const symbol of symbols) {
  try {
    const klines = await fetchKlines(symbol, LOOKBACK);
    if (!klines || klines.length < 60) continue;

    const closes = klines.map(k => parseFloat(k[4]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const atr    = computeAtr(highs, lows, closes, 14);
    if (!atr) continue;

    let trades = 0, wins = 0, losses = 0;
    let grossProfit = 0, grossLoss = 0;
    let netPnl = 0;

    for (let i = 50; i < closes.length - 2; i++) {
      const sigNow = getSignal(closes, highs, lows, i);
      if (!sigNow) continue;

      const atrNow = computeAtr(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), 14) || atr;
      const res = backtestSignal(closes, highs, lows, i, sigNow, atrNow);
      if (!res) continue;
      trades++;
      if (res.hit === 'TP') { wins++; grossProfit += res.pnl; }
      else { losses++; grossLoss += Math.abs(res.pnl); }
      netPnl += res.pnl;
    }

    if (trades >= 3) {
      const wr = (wins / trades * 100).toFixed(1);
      results.push({
        symbol,
        trades,
        wins,
        losses,
        winRate: parseFloat(wr),
        grossProfit: grossProfit.toFixed(4),
        grossLoss: grossLoss.toFixed(4),
        netPnl: netPnl.toFixed(4),
      });
    }
  } catch (e) {
    // skip
  }
}

// ─── Top 10 ───────────────────────────────────────────────────────────────────

const top10 = results
  .filter(r => r.netPnl > 0)
  .sort((a, b) => parseFloat(b.netPnl) - parseFloat(a.netPnl))
  .slice(0, 10);

const top10any = results
  .sort((a, b) => b.winRate - a.winRate)
  .slice(0, 10);

console.log('══════════════════════════════════════════════════════════');
console.log('🏆 TOP 10 by NET PROFIT (positive only)');
console.log('══════════════════════════════════════════════════════════');
console.log(`${'Symbol'.padEnd(14)} ${'Trades'.padEnd(7)} ${'Win%'.padEnd(6)} ${'G.Prof'.padEnd(10)} ${'G.Loss'.padEnd(10)} ${'Net PNL'.padEnd(12)}`);
console.log('──────────────────────────────────────────────────────────');
for (const r of top10) {
  console.log(
    r.symbol.padEnd(14),
    String(r.trades).padEnd(7),
    (r.winRate + '%').padEnd(6),
    r.grossProfit.padEnd(10),
    r.grossLoss.padEnd(10),
    r.netPnl.padEnd(12)
  );
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('📈 TOP 10 by WIN RATE');
console.log('══════════════════════════════════════════════════════════');
console.log(`${'Symbol'.padEnd(14)} ${'Trades'.padEnd(7)} ${'Win%'.padEnd(6)} ${'Net PNL'.padEnd(12)}`);
console.log('──────────────────────────────────────────────────────────');
for (const r of top10any.slice(0, 10)) {
  console.log(
    r.symbol.padEnd(14),
    String(r.trades).padEnd(7),
    (r.winRate + '%').padEnd(6),
    r.netPnl.padEnd(12)
  );
}

console.log(`\n📊 Total symbols tested: ${symbols.length}`);
console.log(`📊 Symbols with ≥3 trades: ${results.length}`);
console.log(`📊 Symbols with profit: ${results.filter(r => parseFloat(r.netPnl) > 0).length}`);
