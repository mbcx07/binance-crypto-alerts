// 50-strategy library (parameter variants) for mini-backtests on Binance Futures klines.
// Each strategy returns a direction signal at a candle index (usually last closed).

export function computeSMA(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function computeEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = computeSMA(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

export function computeRSI(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gains += ch;
    else losses += -ch;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeStd(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  const v = slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length;
  return Math.sqrt(v);
}

export function computeMACD(values, fast = 12, slow = 26, signal = 9) {
  if (!values || values.length < slow + signal + 5) return null;
  // Build MACD line series for last (signal+2) points
  const macdLine = [];
  for (let i = values.length - (signal + 20); i < values.length; i++) {
    const sub = values.slice(0, i + 1);
    const emaFast = computeEMA(sub, fast);
    const emaSlow = computeEMA(sub, slow);
    if (emaFast == null || emaSlow == null) continue;
    macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < signal + 2) return null;
  const macd = macdLine[macdLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const sig = computeEMA(macdLine, signal);
  const prevSig = computeEMA(macdLine.slice(0, macdLine.length - 1), signal);
  if (sig == null || prevSig == null) return null;
  return { macd, sig, prevMacd, prevSig };
}

export function buildStrategies50() {
  const list = [];

  // 1) EMA cross variants (10)
  const emaPairs = [
    [5, 20], [8, 21], [9, 26], [10, 30], [12, 36],
    [20, 50], [21, 55], [26, 60], [30, 90], [50, 200],
  ];
  for (const [fast, slow] of emaPairs) {
    list.push({
      id: `ema_cross_${fast}_${slow}`,
      family: 'ema_cross',
      params: { fast, slow },
      signal(closes) {
        const emaF = computeEMA(closes, fast);
        const emaS = computeEMA(closes, slow);
        const emaFPrev = computeEMA(closes.slice(0, -1), fast);
        const emaSPrev = computeEMA(closes.slice(0, -1), slow);
        if ([emaF, emaS, emaFPrev, emaSPrev].some((x) => x == null)) return null;
        const crossUp = emaFPrev <= emaSPrev && emaF > emaS;
        const crossDn = emaFPrev >= emaSPrev && emaF < emaS;
        return crossUp ? 'LONG' : crossDn ? 'SHORT' : null;
      },
    });
  }

  // 1b) PRO EMA: EMA 8/14 crossover with EMA 50 trend filter (Jefes Pine Script adaptation)
  list.push({
    id: 'pro_ema_cross_8_14_50',
    family: 'ema_cross',
    params: { fast: 8, mid: 14, trend: 50 },
    signal(closes) {
      const ema8 = computeEMA(closes, 8);
      const ema14 = computeEMA(closes, 14);
      const ema50 = computeEMA(closes, 50);
      const ema8Prev = computeEMA(closes.slice(0, -1), 8);
      const ema14Prev = computeEMA(closes.slice(0, -1), 14);
      if ([ema8, ema14, ema50, ema8Prev, ema14Prev].some((x) => x == null)) return null;
      // Trend filter: all three aligned
      const bull = ema8 > ema50 && ema14 > ema50 && ema8 > ema14;
      const bear = ema8 < ema50 && ema14 < ema50 && ema8 < ema14;
      if (!bull && !bear) return null;
      // Crossover signals
      const crossUp = ema8Prev <= ema14Prev && ema8 > ema14;
      const crossDn = ema8Prev >= ema14Prev && ema8 < ema14;
      return crossUp && bull ? 'LONG' : crossDn && bear ? 'SHORT' : null;
    },
  });

  // 1c) PRO EMA bounce: price bounces off EMA 8/14 with candle confirmation (Jefes Pine Script adaptation)
  // Requires highs/lows to detect touches. Strategy signature: signal(closes, highs, lows)
  list.push({
    id: 'pro_ema_bounce_8_14',
    family: 'ema_bounce',
    params: { fast: 8, mid: 14, tolPct: 0.001 },
    signal(closes, highs, lows) {
      if (!highs || !lows || highs.length < 3 || lows.length < 3) return null;
      const ema8 = computeEMA(closes, 8);
      const ema14 = computeEMA(closes, 14);
      const ema50 = computeEMA(closes, 50);
      if ([ema8, ema14, ema50].some((x) => x == null)) return null;
      const bull = ema8 > ema50 && ema14 > ema50 && ema8 > ema14;
      const bear = ema8 < ema50 && ema14 < ema50 && ema8 < ema14;
      if (!bull && !bear) return null;
      const tol = 0.001;
      const lastLow = lows[lows.length - 1];
      const lastHigh = highs[highs.length - 1];
      const prevClose = closes[closes.length - 2];
      const lastClose = closes[closes.length - 1];
      // Touch detection (low <= ema * (1+tol) for longs, high >= ema * (1-tol) for shorts)
      const touchFastLong = lastLow <= ema8 * (1 + tol);
      const touchMidLong = lastLow <= ema14 * (1 + tol);
      const touchFastShort = lastHigh >= ema8 * (1 - tol);
      const touchMidShort = lastHigh >= ema14 * (1 - tol);
      // Candle confirmation: close > open for longs, close < open for shorts
      const bullReject = lastClose > prevClose && lastClose > ema8 && lastClose > ema14;
      const bearReject = lastClose < prevClose && lastClose < ema8 && lastClose < ema14;
      const longBounce = bull && (touchFastLong || touchMidLong) && bullReject;
      const shortBounce = bear && (touchFastShort || touchMidShort) && bearReject;
      return longBounce ? 'LONG' : shortBounce ? 'SHORT' : null;
    },
  });

  // 2) RSI mean reversion (10 variants)
  const rsiVariants = [
    [7, 25, 75], [7, 30, 70], [10, 25, 75], [10, 30, 70], [14, 30, 70],
    [14, 35, 65], [21, 30, 70], [21, 35, 65], [28, 30, 70], [28, 35, 65],
  ];
  for (const [period, low, high] of rsiVariants) {
    list.push({
      id: `rsi_mr_${period}_${low}_${high}`,
      family: 'rsi_mr',
      params: { period, low, high },
      signal(closes) {
        const rsi = computeRSI(closes, period);
        if (rsi == null) return null;
        if (rsi <= low) return 'LONG';
        if (rsi >= high) return 'SHORT';
        return null;
      },
    });
  }

  // 3) Donchian breakout (10 variants)
  const don = [10, 15, 20, 30, 40, 50, 60, 80, 100, 120];
  for (const n of don) {
    list.push({
      id: `donchian_${n}`,
      family: 'donchian',
      params: { n },
      signal(closes, highs, lows) {
        if (highs.length < n + 2) return null;
        const prevHigh = Math.max(...highs.slice(highs.length - (n + 1), highs.length - 1));
        const prevLow = Math.min(...lows.slice(lows.length - (n + 1), lows.length - 1));
        const lastClose = closes[closes.length - 1];
        if (lastClose > prevHigh) return 'LONG';
        if (lastClose < prevLow) return 'SHORT';
        return null;
      },
    });
  }

  // 4) Bollinger mean reversion (10 variants)
  const bbVariants = [
    [20, 2.0], [20, 2.5], [20, 3.0],
    [30, 2.0], [30, 2.5],
    [40, 2.0], [40, 2.5],
    [50, 2.0], [50, 2.5], [60, 2.0],
  ];
  for (const [period, mult] of bbVariants) {
    list.push({
      id: `bb_mr_${period}_${String(mult).replace('.', '_')}`,
      family: 'bb_mr',
      params: { period, mult },
      signal(closes) {
        const sma = computeSMA(closes, period);
        const std = computeStd(closes, period);
        if (sma == null || std == null) return null;
        const upper = sma + std * mult;
        const lower = sma - std * mult;
        const last = closes[closes.length - 1];
        if (last < lower) return 'LONG';
        if (last > upper) return 'SHORT';
        return null;
      },
    });
  }

  // 5) MACD cross (10 variants)
  const macdVariants = [
    [12, 26, 9], [8, 21, 9], [5, 35, 5], [10, 30, 9], [6, 19, 6],
    [20, 50, 9], [24, 52, 18], [9, 26, 9], [7, 28, 9], [16, 32, 9],
  ];
  for (const [fast, slow, sig] of macdVariants) {
    list.push({
      id: `macd_${fast}_${slow}_${sig}`,
      family: 'macd',
      params: { fast, slow, sig },
      signal(closes) {
        const m = computeMACD(closes, fast, slow, sig);
        if (!m) return null;
        const crossUp = m.prevMacd <= m.prevSig && m.macd > m.sig;
        const crossDn = m.prevMacd >= m.prevSig && m.macd < m.sig;
        return crossUp ? 'LONG' : crossDn ? 'SHORT' : null;
      },
    });
  }

  if (list.length !== 52) throw new Error(`Expected 52 strategies, got ${list.length}`);
  return list;
}
