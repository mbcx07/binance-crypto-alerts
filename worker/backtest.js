import { computeEMA } from './strategies.js';

export function computeATRFromKlines(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 2) return null;
  const lastClosedIdx = klines.length - 2;
  const start = lastClosedIdx - period + 1;
  if (start <= 0) return null;
  const trs = [];
  for (let i = start; i <= lastClosedIdx; i++) {
    const k = klines[i];
    const prev = klines[i - 1];
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const prevClose = parseFloat(prev[4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

export function backtestStrategy({
  strategy,
  klines,
  atrPeriod = 14,
  atrMult = 1.0,
  takeProfitR = 1.5,
  timeStopCandles = 12,
  feeBps = 4,
  minTrades = 3,
}) {
  // Very fast, conservative backtest:
  // - entry at close
  // - SL/TP based on ATR
  // - if both SL/TP hit in same candle -> assume SL (worst-case)
  const closes = klines.map((k) => parseFloat(k[4]));
  const highs = klines.map((k) => parseFloat(k[2]));
  const lows = klines.map((k) => parseFloat(k[3]));

  const trades = [];
  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  const startIdx = Math.max(atrPeriod + 50, 50);
  for (let i = startIdx; i < klines.length - 2; i++) {
    // Evaluate signal on candle i (closed)
    const subCloses = closes.slice(0, i + 1);
    const dir = strategy.signal(subCloses, highs.slice(0, i + 1), lows.slice(0, i + 1));
    if (!dir) continue;

    // Regime filter: decide when MR vs Trend strategies are allowed
    const entry = closes[i];
    const ema = computeEMA(subCloses, 100);
    if (ema != null) {
      // Only allow mean-reversion families when price is near EMA (range-ish)
      if (strategy.family === 'rsi_mr' || strategy.family === 'bb_mr') {
        const dist = Math.abs(entry - ema) / entry;
        if (dist > 0.006) continue; // >0.6% away => likely trending, skip MR
      }
      // Only allow breakout/trend families when price is away from EMA (trend-ish)
      if (strategy.family === 'ema_cross' || strategy.family === 'donchian' || strategy.family === 'macd') {
        const dist = Math.abs(entry - ema) / entry;
        if (dist < 0.0025) continue; // too close to EMA => choppy range
      }

      // Direction sanity: align with EMA slope proxy (price vs EMA)
      if (dir === 'LONG' && entry <= ema) continue;
      if (dir === 'SHORT' && entry >= ema) continue;
    }

    const atr = computeATRFromKlines(klines.slice(0, i + 2), atrPeriod);
    if (!atr || atr <= 0) continue;

    const stopDist = atr * atrMult;
    const tpDist = stopDist * takeProfitR;
    const sl = dir === 'LONG' ? entry - stopDist : entry + stopDist;
    const tp = dir === 'LONG' ? entry + tpDist : entry - tpDist;

    let exit = null;
    let hit = null;
    let exitIdx = null;

    const end = Math.min(klines.length - 2, i + timeStopCandles);
    for (let j = i + 1; j <= end; j++) {
      const hi = highs[j];
      const lo = lows[j];
      const tpHit = dir === 'LONG' ? hi >= tp : lo <= tp;
      const slHit = dir === 'LONG' ? lo <= sl : hi >= sl;

      if (tpHit && slHit) {
        // worst-case
        hit = 'SL';
        exit = sl;
        exitIdx = j;
        break;
      }
      if (slHit) {
        hit = 'SL';
        exit = sl;
        exitIdx = j;
        break;
      }
      if (tpHit) {
        hit = 'TP';
        exit = tp;
        exitIdx = j;
        break;
      }
    }

    if (exit == null) {
      // time stop at close of end
      exitIdx = end;
      exit = closes[end];
      hit = 'TIME';
    }

    const gross = dir === 'LONG' ? (exit - entry) : (entry - exit);
    const fee = (feeBps / 10000) * (Math.abs(entry) + Math.abs(exit));
    const pnl = gross - fee;

    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;

    trades.push({ dir, entry, sl, tp, exit, hit, pnl, entryIdx: i, exitIdx });
  }

  if (trades.length < minTrades) {
    return {
      ok: false,
      reason: `minTrades(${trades.length}<${minTrades})`,
      trades: trades.length,
      winrate: 0,
      expectancy: -Infinity,
      profitFactor: 0,
      maxDD,
    };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const winrate = wins.length / trades.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0;
  const expectancy = (winrate * avgWin) + ((1 - winrate) * avgLoss);
  const grossWin = wins.reduce((a, b) => a + b.pnl, 0);
  const grossLoss = losses.reduce((a, b) => a + Math.abs(b.pnl), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  return {
    ok: true,
    trades: trades.length,
    winrate,
    expectancy,
    profitFactor,
    maxDD,
  };
}
