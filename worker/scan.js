import axios from 'axios';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load environment variables from .env file (local runs). In GitHub Actions, env comes from Secrets.
const envPath = path.join(__dirname, ".env");
dotenv.config({ path: envPath });


// ===============================
// CONFIGURATION (defaults per Max)
// ===============================
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
  scanner: {
    // Universe selection
    topPairs: 100, // Max: top pares=100
    timeframe: '15m', // Max: 15m
    lookback: 300, // Max: 300 velas
    minVolume: 5000000, // 5M USDT minimum 24h volume

    // Output
    topSignals: 10, // señales a mandar por corrida (ajustable)
    cooldownMinutes: 60,

    // Wyckoff PV + Liquidez (setup base: sweep + test)
    swingWindow: 3, // pivotes: N a izquierda y derecha
    volAvgN: 20,
    volRatioBreakMin: 1.8,
    volRatioTestMax: 0.8,
    testMaxBarsAfterSweep: 12, // cuántas velas después del sweep aceptamos un TEST

    // Wyckoff confirmation (reduce false positives)
    // Idea: primero Spring/UTAD (trampa de liquidez), luego confirmar con fuerza/debilidad.
    // Modes:
    // - "sos": require SOS/SOW breakout+follow-through
    // - "soft": require reclaim/hold of sweep level + volume confirmation
    // - "both" (default): accept sos OR soft
    confirmEnabled: (process.env.WYCKOFF_CONFIRM_ENABLED || 'true').toLowerCase() !== 'false',
    confirmMode: (process.env.WYCKOFF_CONFIRM_MODE || 'both').toLowerCase(),
    confirmLookback: parseInt(process.env.WYCKOFF_CONFIRM_LOOKBACK || '80', 10),
    confirmBreakoutPct: parseFloat(process.env.WYCKOFF_CONFIRM_BREAKOUT_PCT || '0.0015'), // 0.15%
    sosVolRatioMin: parseFloat(process.env.WYCKOFF_SOS_VOL_RATIO_MIN || '1.2'),
    followThroughBars: parseInt(process.env.WYCKOFF_FOLLOW_THROUGH_BARS || '2', 10), // require last N closes beyond level
    softReclaimPct: parseFloat(process.env.WYCKOFF_SOFT_RECLAIM_PCT || '0.0000'),
    softVolRatioMin: parseFloat(process.env.WYCKOFF_SOFT_VOL_RATIO_MIN || '1.0'),

    // Helpers
    concurrency: 5,
    requestTimeoutMs: 10000,
  },
  trading: {
    mode: (process.env.TRADING_MODE || 'alerts').toLowerCase(), // alerts | real

    // Guardrails
    killSwitch: process.env.KILL_SWITCH === '1' || process.env.KILL_SWITCH === 'true',
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3', 10),
    maxConsecutiveFailures: parseInt(process.env.MAX_CONSECUTIVE_FAILURES || '3', 10),
    dryRun: process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',

    // Strategy filters (to reduce negative trades)
    trendEmaPeriod: parseInt(process.env.TREND_EMA_PERIOD || '200', 10),
    // ATR% = ATR(14) / price. Trade only within [min,max].
    atrPercentMin: parseFloat(process.env.ATR_PCT_MIN || '0.002'), // 0.20%
    atrPercentMax: parseFloat(process.env.ATR_PCT_MAX || '0.03'),  // 3.00%
    lossCooldownMinutes: parseInt(process.env.LOSS_COOLDOWN_MINUTES || '60', 10),

    // Risk model
    // Margin per trade in USDT (Jefe): 0.5 USDT with leverage 20x => notional ≈ 10 USDT
    baseMarginUSDT: parseFloat(process.env.BASE_MARGIN_USDT || '0.5'),

    // ATR-based R (Max): R = ATR(14)
    atrPeriod: parseInt(process.env.ATR_PERIOD || '14', 10),
    atrMult: parseFloat(process.env.ATR_MULT || '1.0'), // 1R = ATR * atrMult
    takeProfitR: parseFloat(process.env.TAKE_PROFIT_R || '1.5'), // TP distance = stopDistance * takeProfitR

    leverage: parseInt(process.env.LEVERAGE || '20', 10),
    timeStopCandles: parseInt(process.env.TIME_STOP_CANDLES || '12', 10),
  },
};

const BINANCE_CREDS = {
  apiKey: process.env.API_KEY_BINANCE,
  apiSecret: process.env.API_SECRET_BINANCE,
};

// ===============================
// ZOD SCHEMAS
// ===============================
const BinanceSymbolSchema = z.object({
  symbol: z.string(),
  quoteVolume: z.number(),
  priceChangePercent: z.number().optional(),
  lastPrice: z.string().optional(),
});

// Kline array format (Binance):
// [ openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, takerBuyBase, takerBuyQuote, ignore ]

// ===============================
// BINANCE API HELPERS
// ===============================
const api = axios.create({
  timeout: CONFIG.scanner.requestTimeoutMs,
});

const apiSigned = axios.create({
  timeout: CONFIG.scanner.requestTimeoutMs,
  headers: {
    'X-MBX-APIKEY': BINANCE_CREDS.apiKey || '',
  },
});

async function getExchangeInfo() {
  const response = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.exchangeInfo}`);
  return response.data;
}

async function get24hTicker() {
  const response = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker24h}`);
  return response.data;
}

async function getKlines(symbol, interval, limit) {
  const response = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.klines}`, {
    params: { symbol, interval, limit },
  });
  return response.data;
}

async function getLastPrice(symbol) {
  const response = await api.get(`${CONFIG.binance.baseUrl}/fapi/v1/ticker/price`, {
    params: { symbol },
  });
  return parseFloat(response.data?.price);
}

async function getServerTime() {
  const response = await api.get(`${CONFIG.binance.baseUrl}/fapi/v1/time`);
  return response.data;
}

function signQuery(params, secret) {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  return { qs, sig };
}

async function signedRequest(method, endpoint, params = {}) {
  if (!BINANCE_CREDS.apiKey || !BINANCE_CREDS.apiSecret) {
    throw new Error('Missing Binance API credentials (API_KEY_BINANCE/API_SECRET_BINANCE)');
  }

  // Timestamp handling
  const { serverTime } = await getServerTime();
  const base = {
    ...params,
    timestamp: serverTime,
    recvWindow: 5000,
  };

  const { qs, sig } = signQuery(base, BINANCE_CREDS.apiSecret);
  const url = `${CONFIG.binance.baseUrl}${endpoint}?${qs}&signature=${sig}`;

  return apiSigned.request({
    method,
    url,
  });
}

// ===============================
// UTILS
// ===============================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function candleRange(k) {
  const high = parseFloat(k[2]);
  const low = parseFloat(k[3]);
  return high - low;
}

function timeframeToMinutes(tf) {
  // supports: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1w
  const m = String(tf).trim().match(/^([0-9]+)([mhdw])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : unit === 'w' ? 10080 : null;
  return mult ? n * mult : null;
}

function computeATR(klines, period = 14) {
  // Simple ATR: SMA(TR, period) over last `period` closed candles.
  // TR = max(high-low, abs(high-prevClose), abs(low-prevClose))
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
  return mean(trs);
}

function computeEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  // seed with SMA
  let ema = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function getLastClosedClose(klines) {
  const k = klines?.[klines.length - 2];
  return k ? parseFloat(k[4]) : null;
}

function computeATRPercent(klines, atrPeriod) {
  const atr = computeATR(klines, atrPeriod);
  const price = getLastClosedClose(klines);
  if (!atr || !price) return null;
  return atr / price;
}

// ===============================
// WYCKOFF PV + LIQUIDITY (alerts)
// ===============================
function detectSwings(klines, windowN) {
  // returns arrays of { index, price }
  const swingHighs = [];
  const swingLows = [];

  for (let i = windowN; i < klines.length - windowN; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);

    let isHigh = true;
    let isLow = true;

    for (let j = i - windowN; j <= i + windowN; j++) {
      if (j === i) continue;
      const hj = parseFloat(klines[j][2]);
      const lj = parseFloat(klines[j][3]);
      if (hj >= high) isHigh = false;
      if (lj <= low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) swingHighs.push({ index: i, price: high });
    if (isLow) swingLows.push({ index: i, price: low });
  }

  return { swingHighs, swingLows };
}

function computeVolRatio(klines, volAvgN, idx) {
  const end = idx;
  const start = Math.max(0, end - volAvgN);
  const vols = klines.slice(start, end).map((k) => parseFloat(k[5]));
  const avg = mean(vols);
  const cur = parseFloat(klines[idx][5]);
  return {
    avgVol: avg,
    curVol: cur,
    volRatio: avg > 0 ? cur / avg : 0,
  };
}

function lastNClosesBeyondLevel(klines, lastClosedIdx, n, level, direction) {
  // direction: 'LONG' => closes must be > level
  // direction: 'SHORT' => closes must be < level
  const start = Math.max(0, lastClosedIdx - (n - 1));
  let ok = true;
  for (let i = start; i <= lastClosedIdx; i++) {
    const close = parseFloat(klines[i][4]);
    if (direction === 'LONG' && close <= level) ok = false;
    if (direction === 'SHORT' && close >= level) ok = false;
    if (!ok) break;
  }
  return ok;
}

function detectWyckoffConfirmSOSorSOW(klines, setupDirection, cfg, setupMeta = {}) {
  // Confirmation to reduce false positives.
  // Modes:
  // - sos: breakout+follow-through vs recent range extreme
  // - soft: reclaim/hold sweepLevel (from setup) + volume confirmation
  // - both: accept sos OR soft
  if (!cfg?.confirmEnabled) return { ok: true, reason: 'confirm_disabled' };

  const mode = (cfg.confirmMode || 'both').toLowerCase();
  const lastClosedIdx = klines.length - 2;
  const { volRatio } = computeVolRatio(klines, cfg.volAvgN || 20, lastClosedIdx);

  const trySoft = () => {
    const sweepLevel = setupMeta?.sweepLevel;
    if (typeof sweepLevel !== 'number') return { ok: false, reason: 'soft:no_sweepLevel' };
    const reclaimPct = cfg.softReclaimPct ?? 0;
    const level = setupDirection === 'LONG'
      ? sweepLevel * (1 + reclaimPct)
      : sweepLevel * (1 - reclaimPct);
    const lastClose = parseFloat(klines[lastClosedIdx][4]);
    const holdOk = setupDirection === 'LONG' ? lastClose > level : lastClose < level;
    const volOk = volRatio >= (cfg.softVolRatioMin || 1.0);
    return { ok: holdOk && volOk, reason: `soft(hold=${holdOk} volRatio=${volRatio.toFixed(2)})`, level, volRatio };
  };

  const trySOS = () => {
    const lookback = Math.min(cfg.confirmLookback || 80, lastClosedIdx - 1);
    if (lookback < 30) return { ok: false, reason: 'sos:insufficient_lookback' };

    const start = Math.max(0, lastClosedIdx - lookback);
    const window = klines.slice(start, lastClosedIdx); // exclude lastClosed candle
    const highs = window.map((k) => parseFloat(k[2]));
    const lows = window.map((k) => parseFloat(k[3]));
    const rangeHigh = Math.max(...highs);
    const rangeLow = Math.min(...lows);

    const breakoutPct = cfg.confirmBreakoutPct ?? 0.0015;
    const ft = Math.max(1, cfg.followThroughBars || 2);

    if (setupDirection === 'LONG') {
      const level = rangeHigh * (1 + breakoutPct);
      const ftOk = lastNClosesBeyondLevel(klines, lastClosedIdx, ft, level, 'LONG');
      const volOk = volRatio >= (cfg.sosVolRatioMin || 1.2);
      return { ok: ftOk && volOk, reason: `SOS(ft=${ftOk} volRatio=${volRatio.toFixed(2)})`, level, volRatio };
    }

    const level = rangeLow * (1 - breakoutPct);
    const ftOk = lastNClosesBeyondLevel(klines, lastClosedIdx, ft, level, 'SHORT');
    const volOk = volRatio >= (cfg.sosVolRatioMin || 1.2);
    return { ok: ftOk && volOk, reason: `SOW(ft=${ftOk} volRatio=${volRatio.toFixed(2)})`, level, volRatio };
  };

  const soft = (mode === 'soft' || mode === 'both') ? trySoft() : { ok: false, reason: 'soft:disabled' };
  const sos = (mode === 'sos' || mode === 'both') ? trySOS() : { ok: false, reason: 'sos:disabled' };

  if (mode === 'soft') return soft;
  if (mode === 'sos') return sos;
  // both
  return soft.ok ? { ...soft, reason: `soft_ok ${soft.reason}` } : sos.ok ? { ...sos, reason: `sos_ok ${sos.reason}` } : { ok: false, reason: `confirm_fail(${soft.reason}; ${sos.reason})` };
}

function detectSetupWyckoffPV(klines, cfg) {
  // Minimal viable detection:
  // - Sweep of prior swing high/low + close re-enters
  // - Then a TEST within X bars:
  //   - small range vs recent ranges
  //   - low vol_ratio
  // Returns { setup, direction, reason, meta } or null

  const { swingWindow, volAvgN, volRatioBreakMin, volRatioTestMax, testMaxBarsAfterSweep } = cfg;

  if (klines.length < Math.max(50, volAvgN + swingWindow * 4)) return null;

  // Use last *closed* candle to avoid mismatches with the still-forming candle
  const lastIdx = klines.length - 2;
  const { swingHighs, swingLows } = detectSwings(klines, swingWindow);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  // Use the most recent completed candle as decision candle.
  const k = klines[lastIdx];
  const close = parseFloat(k[4]);

  // Recent range context
  const recentRanges = klines.slice(-20).map(candleRange);
  const avgRange = mean(recentRanges);
  const kRange = candleRange(k);

  // --- Find a sweep event in last N bars ---
  // We look back for a candle that swept a prior swing and re-entered.
  const sweepLookback = Math.min(60, klines.length - 1);
  let sweep = null;

  const prevSwingHigh = swingHighs[swingHighs.length - 2];
  const prevSwingLow = swingLows[swingLows.length - 2];

  // Candidate levels (simple): previous swing high/low (not the current one)
  const sweepHighLevel = prevSwingHigh.price;
  const sweepLowLevel = prevSwingLow.price;

  for (let i = lastIdx - 1; i >= Math.max(0, lastIdx - sweepLookback); i--) {
    const ci = klines[i];
    const hi = parseFloat(ci[2]);
    const li = parseFloat(ci[3]);
    const cli = parseFloat(ci[4]);

    const { volRatio } = computeVolRatio(klines, volAvgN, i);

    // Spring (sweep low then re-enter upwards):
    // low pierces below sweepLowLevel, close back above sweepLowLevel
    const spring = li < sweepLowLevel && cli > sweepLowLevel;

    // Upthrust (sweep high then re-enter downwards):
    const upthrust = hi > sweepHighLevel && cli < sweepHighLevel;

    // Ice break (break below support with strength): treat as breakdown with high vol
    // We'll treat sweepLowLevel as 'ice' and require close below + vol high + big range.
    const iceBreak = cli < sweepLowLevel && kRange > avgRange * 1.2 && volRatio >= volRatioBreakMin;

    if (spring) {
      sweep = { type: 'SPRING', index: i, level: sweepLowLevel, volRatio, direction: 'LONG' };
      break;
    }
    if (upthrust) {
      sweep = { type: 'UPTHRUST', index: i, level: sweepHighLevel, volRatio, direction: 'SHORT' };
      break;
    }
    if (iceBreak) {
      sweep = { type: 'ICE_BREAK', index: i, level: sweepLowLevel, volRatio, direction: 'SHORT' };
      break;
    }
  }

  if (!sweep) return null;

  // Must have enough bars after sweep to see a TEST
  const barsAfter = lastIdx - sweep.index;
  if (barsAfter < 2 || barsAfter > testMaxBarsAfterSweep) return null;

  // TEST candle is current candle
  const { volRatio: volRatioNow } = computeVolRatio(klines, volAvgN, lastIdx);

  const isNarrow = avgRange > 0 ? kRange <= avgRange * 0.75 : false;
  const isLowVol = volRatioNow <= volRatioTestMax;

  if (!isNarrow || !isLowVol) return null;

  // Re-entry validation for test:
  // For spring long, we want price to be above swept level (holding)
  // For upthrust short, we want price below swept level
  // For ice break short, we want a back-to-ice (retest from below): close near/under level

  if (sweep.type === 'SPRING') {
    if (close <= sweep.level) return null;
    return {
      setup: 'SPRING_TEST',
      direction: 'LONG',
      reason: `spring+sweep(${sweep.level.toFixed(4)}) + test(narrow&lowVol)`,
      meta: {
        sweepIndex: sweep.index,
        sweepLevel: sweep.level,
        sweepVolRatio: sweep.volRatio,
        testVolRatio: volRatioNow,
        kRange,
        avgRange,
      },
    };
  }

  if (sweep.type === 'UPTHRUST') {
    if (close >= sweep.level) return null;
    return {
      setup: 'UT_TEST',
      direction: 'SHORT',
      reason: `upthrust+sweep(${sweep.level.toFixed(4)}) + test(narrow&lowVol)`,
      meta: {
        sweepIndex: sweep.index,
        sweepLevel: sweep.level,
        sweepVolRatio: sweep.volRatio,
        testVolRatio: volRatioNow,
        kRange,
        avgRange,
      },
    };
  }

  if (sweep.type === 'ICE_BREAK') {
    // Back-to-ice: price retests level from below with low vol
    if (close > sweep.level) return null;
    return {
      setup: 'ICE_BACK',
      direction: 'SHORT',
      reason: `iceBreak(level=${sweep.level.toFixed(4)}) + backToIce(test lowVol)`,
      meta: {
        sweepIndex: sweep.index,
        sweepLevel: sweep.level,
        sweepVolRatio: sweep.volRatio,
        testVolRatio: volRatioNow,
        kRange,
        avgRange,
      },
    };
  }

  return null;
}

// ===============================
// SCANNER LOGIC
// ===============================
async function mapLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: limit }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      try {
        results[current] = await fn(items[current], current);
      } catch (e) {
        results[current] = { __error: e };
      }
      // small pacing to reduce burst
      await sleep(30);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanSignals() {
  console.log('🔍 Starting Binance scanner (Wyckoff PV + Liquidity alerts)...');

  // Get all USDT-M PERPETUAL symbols
  const exchangeInfo = await getExchangeInfo();
  const symbols = exchangeInfo.symbols.filter(
    (s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING'
  );

  console.log(`📊 Found ${symbols.length} USDT-M PERPETUAL symbols`);

  // Get 24h ticker data for filtering
  const tickerData = await get24hTicker();
  const tickerMap = new Map(tickerData.map((t) => [t.symbol, t]));

  // Filter by volume and liquidity
  const activeSymbols = symbols
    .map((s) => {
      const ticker = tickerMap.get(s.symbol);
      if (!ticker) return null;

      const parsed = {
        symbol: s.symbol,
        quoteVolume: parseFloat(ticker.quoteVolume),
        lastPrice: ticker.lastPrice,
        priceChangePercent: parseFloat(ticker.priceChangePercent),
      };

      const safe = BinanceSymbolSchema.safeParse(parsed);
      if (!safe.success) return null;

      return {
        ...s,
        ticker: safe.data,
      };
    })
    .filter((s) => s && s.ticker.quoteVolume >= CONFIG.scanner.minVolume)
    .sort((a, b) => b.ticker.quoteVolume - a.ticker.quoteVolume)
    .slice(0, CONFIG.scanner.topPairs);

  console.log(
    `🔥 Analyzing ${activeSymbols.length} active symbols (topPairs=${CONFIG.scanner.topPairs})...`
  );

  const signals = [];

  const stats = {
    totalSymbols: activeSymbols.length,
    checked: 0,
    setupFound: 0,
    skipped: {
      insufficientKlines: 0,
      noSetup: 0,
      confirmFail: 0,
      trendFail: 0,
      atrFail: 0,
      lossCooldown: 0,
    },
    produced: 0,
  };

  const analyzed = await mapLimit(activeSymbols, CONFIG.scanner.concurrency, async (symbolObj) => {
    const symbol = symbolObj.symbol;

    stats.checked++;

    // Get klines
    const klines = await getKlines(symbol, CONFIG.scanner.timeframe, CONFIG.scanner.lookback);

    if (!Array.isArray(klines) || klines.length < CONFIG.scanner.lookback * 0.8) {
      stats.skipped.insufficientKlines++;
      return null;
    }

    const setup = detectSetupWyckoffPV(klines, CONFIG.scanner);
    if (!setup) {
      stats.skipped.noSetup++;
      return null;
    }
    stats.setupFound++;

    // Wyckoff confirm step: require SOS/SOW follow-through after Spring/UT/ICE setups.
    // Priority (per Jefe): Spring/UTAD first, then confirm strength/weakness.
    const confirm = detectWyckoffConfirmSOSorSOW(klines, setup.direction, CONFIG.scanner, setup.meta);
    if (!confirm.ok) {
      stats.skipped.confirmFail++;
      return null;
    }

    const last = klines[klines.length - 2]; // last closed candle
    const price = parseFloat(last[4]);

    // ===== Filters to reduce negative trades =====
    // 1) Trend filter: only LONG above EMA(200), only SHORT below EMA(200)
    const closes = klines.slice(0, klines.length - 1).map((k) => parseFloat(k[4]));
    const emaTrend = computeEMA(closes, CONFIG.trading.trendEmaPeriod);
    const wantsLong = setup.direction === 'LONG';
    if (emaTrend) {
      if (wantsLong && price <= emaTrend) {
        stats.skipped.trendFail++;
        return null;
      }
      if (!wantsLong && price >= emaTrend) {
        stats.skipped.trendFail++;
        return null;
      }
    }

    // 2) Volatility filter by ATR%
    const atrPct = computeATRPercent(klines, CONFIG.trading.atrPeriod);
    if (atrPct != null) {
      if (atrPct < CONFIG.trading.atrPercentMin) {
        stats.skipped.atrFail++;
        return null;
      }
      if (atrPct > CONFIG.trading.atrPercentMax) {
        stats.skipped.atrFail++;
        return null;
      }
    }

    // 3) Loss cooldown per symbol
    if (isSymbolInLossCooldown(symbol)) {
      stats.skipped.lossCooldown++;
      return null;
    }

    // Score: simple heuristic
    const score = Math.min(
      10,
      4 + Math.min(3, setup.meta.sweepVolRatio || 0) + Math.max(0, 2 - (setup.meta.testVolRatio || 0))
    );

    // SL/TP (ATR-based) for manual execution + monitoring
    const atr = computeATR(klines, CONFIG.trading.atrPeriod);
    if (!atr || atr <= 0) {
      // We require SL/TP for manual execution; skip if ATR unavailable.
      return null;
    }
    const stopDist = atr * CONFIG.trading.atrMult;
    const tpDist = stopDist * CONFIG.trading.takeProfitR;

    const stopLoss = wantsLong ? price - stopDist : price + stopDist;
    const takeProfit = wantsLong ? price + tpDist : price - tpDist;

    const ts = Date.now();

    stats.produced++;
    return {
      id: `${symbol}-${ts}`,
      pair: symbol,
      type: wantsLong ? 'BUY' : 'SELL',
      setup: setup.setup,
      timeframe: CONFIG.scanner.timeframe,
      price,
      stopLoss,
      takeProfit,
      rr: CONFIG.trading.takeProfitR,
      score,
      reason: `${setup.reason} + ${confirm.reason}`,
      timestamp: ts,
      volume24h: symbolObj.ticker.quoteVolume,
      tickerLastPrice: parseFloat(symbolObj.ticker.lastPrice || '0') || null,
      meta: { ...(setup.meta || {}), emaTrend, atrPct, atr, wyckoffConfirm: confirm },
    };
  });

  for (const s of analyzed) {
    if (s && !s.__error) signals.push(s);
  }

  // Sort by score and get top N
  const topSignals = signals.sort((a, b) => b.score - a.score).slice(0, CONFIG.scanner.topSignals);

  console.log(`✅ Generated ${topSignals.length} signals`);

  // Save signals + scan report to data files
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'signals.json'), JSON.stringify(topSignals, null, 2));

  const report = {
    ts: Date.now(),
    timeframe: CONFIG.scanner.timeframe,
    topPairs: CONFIG.scanner.topPairs,
    lookback: CONFIG.scanner.lookback,
    filters: {
      trendEmaPeriod: CONFIG.trading.trendEmaPeriod,
      atrPctMin: CONFIG.trading.atrPercentMin,
      atrPctMax: CONFIG.trading.atrPercentMax,
      lossCooldownMinutes: CONFIG.trading.lossCooldownMinutes,
      wyckoffConfirm: {
        enabled: CONFIG.scanner.confirmEnabled,
        lookback: CONFIG.scanner.confirmLookback,
        breakoutPct: CONFIG.scanner.confirmBreakoutPct,
        sosVolRatioMin: CONFIG.scanner.sosVolRatioMin,
        followThroughBars: CONFIG.scanner.followThroughBars,
      },
    },
    stats,
    producedSignals: topSignals.length,
  };
  fs.writeFileSync(path.join(dataDir, 'scan-report.json'), JSON.stringify(report, null, 2));

  return topSignals;
}

// ===============================
// TELEGRAM NOTIFICATIONS
// ===============================
function formatTelegramMessage(signal) {
  // Belastrader-style message (Entry/SL/TP/RR)
  const lines = [];
  lines.push(`[${signal.timeframe}][USDT-M] ${signal.pair} | ${signal.type}`);
  lines.push(`💰 Entry: ${signal.price.toFixed(6)}`);

  if (typeof signal.stopLoss === 'number' && typeof signal.takeProfit === 'number') {
    lines.push(`🛑 Stop Loss: ${signal.stopLoss.toFixed(6)}`);
    lines.push(`🎯 Take Profit: ${signal.takeProfit.toFixed(6)}`);
  }
  if (typeof signal.rr === 'number') {
    lines.push(`📊 R:R = ${signal.rr.toFixed(2)}`);
  }

  const tags = [];
  if (typeof signal.meta?.sweepVolRatio === 'number') tags.push(`volSpike(${signal.meta.sweepVolRatio.toFixed(1)})`);
  if (signal.meta?.emaTrend) tags.push('trend');
  if (typeof signal.meta?.atrPct === 'number') tags.push('ATR');

  lines.push(`⭐ Score: ${signal.score.toFixed(1)} | ${tags.join('+') || signal.reason}`);
  return lines.join('\n');
}

async function sendTelegramAlert(signal) {
  const message = formatTelegramMessage(signal);

  // Safe mode: if missing credentials, just print (helps dev/testing)
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log('⚠️ Telegram credentials missing; printing alert instead:', message);
    return;
  }

  try {
    await api.post(CONFIG.telegram.apiUrl, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
    });

    // Record as OPEN virtual trade to monitor closures (real price only)
    if (typeof signal.stopLoss === 'number' && typeof signal.takeProfit === 'number') {
      const state = loadOpenTrades();
      const side = signal.type === 'BUY' ? 'LONG' : 'SHORT';
      const entryTs = signal.timestamp;
      const tradeId = makeTradeId({ symbol: signal.pair, side, entryTs });

      // avoid duplicates
      const exists = (state.trades || []).some((t) => t.id === tradeId && t.status === 'OPEN');
      if (!exists) {
        const trade = {
          id: tradeId,
          symbol: signal.pair,
          side,
          entry: signal.price,
          sl: signal.stopLoss,
          tp: signal.takeProfit,
          qty: null,
          status: 'OPEN',
          createdAt: entryTs,
          meta: {
            timeframe: signal.timeframe,
            setup: signal.setup,
            score: signal.score,
            reason: signal.reason,
          },
        };
        state.trades = [...(state.trades || []), trade];
        saveOpenTrades(state);
        appendTradeEvent({ event: 'entry_alert', id: tradeId, symbol: trade.symbol, side: trade.side, entryPrice: trade.entry, sl: trade.sl, tp: trade.tp });
      }
    }

    console.log(`📤 Sent alert for ${signal.pair}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Failed to send alert for ${signal.pair}:`, msg);
  }
}

async function sendTelegramLog(text) {
  const msg = `[TRADING:${CONFIG.trading.mode.toUpperCase()}] ${text}`;
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.log('ℹ️', msg);
    return;
  }
  try {
    await api.post(CONFIG.telegram.apiUrl, {
      chat_id: CONFIG.telegram.chatId,
      text: msg,
      disable_web_page_preview: true,
    });
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    console.error('❌ Telegram log failed:', em);
  }
}

async function sendCooldownAlert(symbol, lastSignalTime) {
  const cooldownRemaining = Math.max(
    0,
    CONFIG.scanner.cooldownMinutes * 60 * 1000 - (Date.now() - lastSignalTime)
  );
  const cooldownMinutes = Math.ceil(cooldownRemaining / (60 * 1000));
  console.log(`⏸️ ${symbol} in cooldown: ${cooldownMinutes} minutes remaining`);
}

// ===============================
// COOLDOWN MANAGEMENT
// ===============================
let lastSignals = {};
let lastLosses = {};

function lossesFile() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'last-losses.json');
}

function loadLastLosses() {
  const file = lossesFile();
  if (!fs.existsSync(file)) return;
  try {
    lastLosses = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    lastLosses = {};
  }
}

function saveLastLosses() {
  fs.writeFileSync(lossesFile(), JSON.stringify(lastLosses, null, 2));
}

function isSymbolInLossCooldown(symbol) {
  const t = lastLosses[symbol];
  if (!t) return false;
  const expired = Date.now() - t > CONFIG.trading.lossCooldownMinutes * 60 * 1000;
  return !expired;
}

function markSymbolLoss(symbol) {
  lastLosses[symbol] = Date.now();
  saveLastLosses();
}

async function loadLastSignals() {
  const dataDir = path.join(__dirname, '..', 'data');
  const file = path.join(dataDir, 'last-signals.json');

  if (fs.existsSync(file)) {
    try {
      const data = fs.readFileSync(file, 'utf-8');
      lastSignals = JSON.parse(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Failed to load last signals:', msg);
    }
  }

  // loss cooldown state
  loadLastLosses();
}

async function saveLastSignals() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'last-signals.json'), JSON.stringify(lastSignals, null, 2));
}

function isSymbolInCooldown(symbol) {
  const lastSignal = lastSignals[symbol];
  if (!lastSignal) return false;

  const cooldownExpired = Date.now() - lastSignal > CONFIG.scanner.cooldownMinutes * 60 * 1000;
  return !cooldownExpired;
}

function markSymbolAlerted(symbol) {
  lastSignals[symbol] = Date.now();
}

// ===============================
// REAL TRADING (USDT-M Futures)
// ===============================
function roundToStep(qty, step) {
  const s = parseFloat(step);
  if (!s || s <= 0) return qty;
  const inv = 1 / s;
  return Math.floor(qty * inv) / inv;
}

function getSymbolFilters(exchangeInfo, symbol) {
  const s = exchangeInfo?.symbols?.find((x) => x.symbol === symbol);
  if (!s) return null;
  const filters = new Map((s.filters || []).map((f) => [f.filterType, f]));
  const lot = filters.get('LOT_SIZE') || filters.get('MARKET_LOT_SIZE');
  const minQty = lot ? parseFloat(lot.minQty) : 0;
  const stepSize = lot ? parseFloat(lot.stepSize) : 0;
  return {
    minQty,
    stepSize,
    pricePrecision: s.pricePrecision ?? 8,
    quantityPrecision: s.quantityPrecision ?? 8,
  };
}

function positionsFile() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'positions.json');
}

function loadPositionsState() {
  const file = positionsFile();
  if (!fs.existsSync(file)) return { positions: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { positions: {} };
  }
}

function savePositionsState(state) {
  fs.writeFileSync(positionsFile(), JSON.stringify(state, null, 2));
}

function tradesFile() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'trades.jsonl');
}

function appendTrade(event) {
  const payload = { ts: Date.now(), ...event };
  fs.appendFileSync(tradesFile(), JSON.stringify(payload) + '\n');
}

async function withBackoff(fn, { maxRetries = 4 } = {}) {
  let attempt = 0;
  let waitMs = 400;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      const code = e?.response?.data?.code;
      const retryAfter = e?.response?.headers?.['retry-after'];
      const shouldRetry =
        attempt < maxRetries &&
        (status === 429 ||
          status === 418 ||
          code === -1021 ||
          e?.code === 'ECONNRESET' ||
          e?.code === 'ETIMEDOUT');

      if (!shouldRetry) throw e;
      const raMs = retryAfter ? parseFloat(retryAfter) * 1000 : null;
      const sleepMs = raMs || waitMs;
      await sleep(sleepMs);
      attempt++;
      waitMs = Math.min(8000, waitMs * 2);
    }
  }
}

async function getOpenPositions() {
  const res = await withBackoff(() => signedRequest('GET', '/fapi/v2/positionRisk'));
  return res.data;
}

async function cancelAllOrders(symbol) {
  return withBackoff(() => signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }));
}

async function setLeverage(symbol, leverage) {
  return withBackoff(() => signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage }));
}

async function placeOrder(params) {
  return withBackoff(() => signedRequest('POST', '/fapi/v1/order', params));
}

async function reconcileState() {
  const state = loadPositionsState();
  const pos = await getOpenPositions();
  const open = pos.filter((p) => Math.abs(parseFloat(p.positionAmt)) > 0);

  // Drop positions that are no longer open (log close + estimate PnL)
  for (const sym of Object.keys(state.positions || {})) {
    const still = open.find((p) => p.symbol === sym);
    if (!still) {
      const prev = state.positions[sym];
      try {
        const exitPrice = await getLastPrice(sym);
        const qty = Math.abs(parseFloat(prev?.qty || prev?.positionAmt || '0'));
        const entry = parseFloat(prev?.entryPrice || '0');
        const side = prev?.side;
        const pnl = !qty || !entry || !exitPrice
          ? null
          : side === 'LONG'
            ? (exitPrice - entry) * qty
            : (entry - exitPrice) * qty;

        appendTrade({
          event: 'close_detected',
          symbol: sym,
          side,
          qty: qty || null,
          entryPrice: entry || null,
          exitPrice: exitPrice || null,
          pnl: pnl,
          reason: prev?.closeReason || 'position_not_open',
        });

        if (typeof pnl === 'number' && pnl < 0) {
          markSymbolLoss(sym);
        }
      } catch {
        // ignore logging failure
      }

      delete state.positions[sym];
    }
  }

  // Ensure state has entries for open positions
  for (const p of open) {
    if (!state.positions[p.symbol]) {
      state.positions[p.symbol] = {
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        entryPrice: parseFloat(p.entryPrice),
        qty: Math.abs(parseFloat(p.positionAmt)),
        openedAt: Date.now(),
        reconciled: true,
      };
    }
  }

  savePositionsState(state);
  return { state, openCount: open.length };
}

async function enforceTimeStops() {
  const state = loadPositionsState();
  const tfMin = timeframeToMinutes(CONFIG.scanner.timeframe) || 15;
  const expiryMs = CONFIG.trading.timeStopCandles * tfMin * 60 * 1000;

  const open = await getOpenPositions();
  const openMap = new Map(open.map((p) => [p.symbol, p]));

  for (const [symbol, pState] of Object.entries(state.positions || {})) {
    const p = openMap.get(symbol);
    if (!p) continue;
    const amt = parseFloat(p.positionAmt);
    if (Math.abs(amt) <= 0) continue;
    if (!pState.openedAt) continue;

    const age = Date.now() - pState.openedAt;
    if (age < expiryMs) continue;

    if (CONFIG.trading.dryRun) {
      await sendTelegramLog(
        `DRY_RUN time-stop would close ${symbol} (age ${(age / 60000).toFixed(1)}m)`
      );
      continue;
    }

    await sendTelegramLog(
      `⏱️ Time-stop closing ${symbol} (${pState.side}) after ${CONFIG.trading.timeStopCandles} candles`
    );
    await cancelAllOrders(symbol);
    await placeOrder({
      symbol,
      side: amt > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      reduceOnly: 'true',
      quantity: Math.abs(amt),
    });

    // mark reason; reconcile() will log close with estimated PnL
    if (state.positions?.[symbol]) {
      state.positions[symbol].closeReason = 'time_stop';
    }
    delete state.positions[symbol];
  }

  savePositionsState(state);
}

async function tryExecuteSignal(signal, exchangeInfo, failureState) {
  if (CONFIG.trading.killSwitch) {
    await sendTelegramLog('🛑 Kill-switch enabled; skipping execution');
    return;
  }
  if (failureState.consecutive >= CONFIG.trading.maxConsecutiveFailures) {
    await sendTelegramLog(
      `🚫 Circuit breaker: ${failureState.consecutive} consecutive failures; skipping execution`
    );
    return;
  }

  const { openCount } = await reconcileState();
  if (openCount >= CONFIG.trading.maxOpenPositions) {
    await sendTelegramLog(
      `⛔ Max open positions reached (${openCount}/${CONFIG.trading.maxOpenPositions}); skipping ${signal.pair}`
    );
    return;
  }

  const state = loadPositionsState();
  if (state.positions?.[signal.pair]) {
    await sendTelegramLog(`ℹ️ Position already tracked for ${signal.pair}; skipping`);
    return;
  }

  const filters = getSymbolFilters(exchangeInfo, signal.pair);
  if (!filters) {
    await sendTelegramLog(`❌ Missing symbol filters for ${signal.pair}; skipping`);
    return;
  }

  // Compute ATR-based sizing
  const klines = await getKlines(signal.pair, CONFIG.scanner.timeframe, Math.max(CONFIG.scanner.lookback, 50));
  const atr = computeATR(klines, CONFIG.trading.atrPeriod);
  if (!atr || atr <= 0) {
    await sendTelegramLog(`❌ ATR unavailable for ${signal.pair}; skipping`);
    return;
  }

  const entry = signal.price;
  const stopDist = atr * CONFIG.trading.atrMult;

  // Quantity by target margin (USDT) * leverage => target notional
  const targetNotionalUSDT = CONFIG.trading.baseMarginUSDT * CONFIG.trading.leverage;
  const qtyRaw = targetNotionalUSDT / entry;
  let qty = roundToStep(qtyRaw, filters.stepSize);
  if (filters.minQty && qty < filters.minQty) qty = filters.minQty;

  const isLong = signal.type === 'BUY';
  const stopPrice = isLong ? entry - stopDist : entry + stopDist;
  const tpPrice = isLong ? entry + stopDist * CONFIG.trading.takeProfitR : entry - stopDist * CONFIG.trading.takeProfitR;

  const side = isLong ? 'BUY' : 'SELL';

  await sendTelegramLog(
    `${signal.pair} exec candidate: side=${side} qty≈${qty} entry≈${entry.toFixed(4)} ATR=${atr.toFixed(4)} stop≈${stopPrice.toFixed(4)} tp≈${tpPrice.toFixed(4)}`
  );

  if (CONFIG.trading.dryRun) {
    await sendTelegramLog(`DRY_RUN would place MARKET + SL/TP (MARK_PRICE) for ${signal.pair}`);
    state.positions[signal.pair] = {
      symbol: signal.pair,
      side: isLong ? 'LONG' : 'SHORT',
      entryPrice: entry,
      qty,
      atr,
      stopPrice,
      tpPrice,
      openedAt: Date.now(),
      dryRun: true,
    };
    savePositionsState(state);
    return;
  }

  // Ensure leverage
  await setLeverage(signal.pair, CONFIG.trading.leverage);

  // Place entry market
  const entryRes = await placeOrder({
    symbol: signal.pair,
    side,
    type: 'MARKET',
    quantity: qty,
    newOrderRespType: 'RESULT',
  });

  // Place SL/TP using MARK_PRICE
  // NOTE: closePosition=true ignores quantity and closes full position.
  const slSide = isLong ? 'SELL' : 'BUY';
  const tpSide = isLong ? 'SELL' : 'BUY';

  const slRes = await placeOrder({
    symbol: signal.pair,
    side: slSide,
    type: 'STOP_MARKET',
    stopPrice: stopPrice.toFixed(filters.pricePrecision),
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  });

  const tpRes = await placeOrder({
    symbol: signal.pair,
    side: tpSide,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: tpPrice.toFixed(filters.pricePrecision),
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  });

  state.positions[signal.pair] = {
    symbol: signal.pair,
    side: isLong ? 'LONG' : 'SHORT',
    qty,
    entryPrice: parseFloat(entryRes.data?.avgPrice || String(entry)),
    atr,
    stopPrice,
    tpPrice,
    openedAt: Date.now(),
    orders: {
      entryOrderId: entryRes.data?.orderId,
      stopOrderId: slRes.data?.orderId,
      tpOrderId: tpRes.data?.orderId,
    },
  };
  savePositionsState(state);

  appendTrade({
    event: 'entry',
    symbol: signal.pair,
    side: isLong ? 'LONG' : 'SHORT',
    qty,
    entryPrice: state.positions[signal.pair].entryPrice,
    stopPrice,
    tpPrice,
    atr,
    atrPct: (atr / entry) || null,
    timeframe: CONFIG.scanner.timeframe,
    reason: signal.reason,
  });

  await sendTelegramLog(
    `✅ Executed ${signal.pair}: entry=${state.positions[signal.pair].entryPrice} qty=${qty} SL/TP placed (MARK_PRICE)`
  );
  failureState.consecutive = 0;
}

// ===============================
// MAIN EXECUTION
// ===============================
async function main() {
  try {
    await loadLastSignals();

    if (!['alerts', 'real'].includes(CONFIG.trading.mode)) {
      console.warn(`⚠️ Unknown TRADING_MODE='${CONFIG.trading.mode}', falling back to alerts`);
      CONFIG.trading.mode = 'alerts';
    }

    // Trading guardrails: reconcile once and enforce time-stops each run.
    if (CONFIG.trading.mode === 'real') {
      if (CONFIG.trading.killSwitch) {
        await sendTelegramLog('🛑 Kill-switch enabled');
      }
      if (CONFIG.trading.dryRun) {
        await sendTelegramLog('🧪 DRY_RUN enabled (no Binance write calls)');
      }
      try {
        await reconcileState();
        await enforceTimeStops();
      } catch (e) {
        const msg = e?.response?.data
          ? JSON.stringify(e.response.data)
          : e instanceof Error
            ? e.message
            : String(e);
        await sendTelegramLog(`⚠️ Reconcile/time-stop error: ${msg}`);
      }
    }

    const signals = await scanSignals();

    // In real mode we need exchangeInfo for filters
    const exchangeInfo = CONFIG.trading.mode === 'real' ? await getExchangeInfo() : null;
    const failureState = { consecutive: 0 };

    for (const signal of signals) {
      if (isSymbolInCooldown(signal.pair)) {
        await sendCooldownAlert(signal.pair, lastSignals[signal.pair]);
        continue;
      }

      await sendTelegramAlert(signal);
      markSymbolAlerted(signal.pair);

      if (CONFIG.trading.mode === 'real') {
        try {
          await tryExecuteSignal(signal, exchangeInfo, failureState);
        } catch (e) {
          failureState.consecutive++;
          const msg = e?.response?.data
            ? JSON.stringify(e.response.data)
            : e instanceof Error
              ? e.message
              : String(e);
          await sendTelegramLog(`❌ Execution error for ${signal.pair}: ${msg}`);
        }
      }
    }

    await saveLastSignals();

    // print examples (Max requested 5 examples)
    console.log('\n🧾 Example alerts (up to 5):');
    signals.slice(0, 5).forEach((s, idx) => {
      console.log(`${idx + 1}) ${formatTelegramMessage(s)}`);
    });

    console.log('🏁 Scanner completed successfully');
  } catch (error) {
    console.error('❌ Scanner failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { scanSignals, computeATR, timeframeToMinutes };
