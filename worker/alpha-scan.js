/**
 * AlphaSight — AI vision chart analysis for Binance crypto trading.
 *
 * Pipeline:
 *  1. Screener → top N symbols by volume/change
 *  2. Fetch 15m klines (last 100 candles)
 *  3. Render candlestick chart to PNG buffer (in-process, no puppeteer)
 *  4. Send to Ollama/llava for analysis
 *  5. Emit signals (LONG/SHORT) with confidence, SL, TP
 *  6. Save decision + outcome for learning
 *
 * Requirements:
 *  - ollama running locally with:  ollama pull llava
 *  - node canvas support (sudo apt install libcairo2-dev libjpeg-dev ...)
 *    OR use the text-chart fallback (no external deps)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { enqueueSignal } from './validate-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_VISION_MODEL || 'llava',
  },
  binance: {
    baseUrl: 'https://fapi.binance.com',
    klines: '/fapi/v1/klines',
    ticker: '/fapi/v1/ticker/24hr',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  dataDir: path.join(__dirname, '..', 'data'),
  alphaDir: path.join(__dirname, '..', 'data', 'alpha'),
  // Analysis settings
  symbolsToAnalyze: parseInt(process.env.ALPHA_SYMBOLS || '6', 10),
  timeframe: process.env.SCAN_TIMEFRAME || '15m',
  lookbackCandles: parseInt(process.env.ALPHA_LOOKBACK || '80', 10),
  minConfidence: parseFloat(process.env.ALPHA_MIN_CONFIDENCE || '0.72'),
  // Learning
  learningWindow: parseInt(process.env.LEARN_WINDOW_HOURS || '72', 10),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const api = axios.create({ timeout: 30000 });

function atomicio(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, ...rest) => {
      if (err) reject(err);
      else resolve(...rest);
    });
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;
  await api.post(CONFIG.telegram.apiUrl, { chat_id: CONFIG.telegram.chatId, text });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─── Chart Rendering (text-mode, zero deps) ───────────────────────────────────

/**
 * Renders candlestick data as an ASCII-art chart suitable for LLaVA analysis.
 * Returns a clean text representation of the chart.
 */
function renderAsciiChart(symbol, klines, ema8, ema14, ema50, rsi) {
  const rows = 18;
  const cols = 60;

  // Extract OHLC
  const closes = klines.map((k) => parseFloat(k[4]));
  const highs = klines.map((k) => parseFloat(k[2]));
  const lows = klines.map((k) => parseFloat(k[3]));
  const opens = klines.map((k) => parseFloat(k[1]));

  const recent = closes.slice(-cols);

  const min = Math.min(...recent.map((c, i) => Math.min(c, lows.slice(-cols)[i])));
  const max = Math.max(...recent.map((c, i) => Math.max(c, highs.slice(-cols)[i])));
  const range = max - min || 1;

  // Build grid
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));

  // Helper: map price → row (inverted, rows 0 = top)
  const toRow = (price) => Math.max(0, Math.min(rows - 1, Math.floor((rows - 1) * (1 - (price - min) / range))));

  // Plot candles
  for (let col = 0; col < recent.length; col++) {
    const o = opens[opens.length - cols + col];
    const h = highs[highs.length - cols + col];
    const l = lows[lows.length - cols + col];
    const c = recent[col];
    const rOpen = toRow(o);
    const rClose = toRow(c);
    const rHigh = toRow(h);
    const rLow = toRow(l);

    // Body: between open and close
    const top = Math.min(rOpen, rClose);
    const bot = Math.max(rOpen, rClose);
    const char = rOpen === rClose ? '═' : rClose > rOpen ? '█' : '▓';
    for (let r = top; r <= bot; r++) grid[r][col] = char;

    // Wick
    for (let r = rHigh; r <= rLow; r++) {
      if (grid[r][col] === ' ') grid[r][col] = '│';
    }
  }

  // Plot EMAs
  const ema8Slice = ema8 ? ema8.slice(-cols) : null;
  const ema14Slice = ema14 ? ema14.slice(-cols) : null;
  const ema50Slice = ema50 ? ema50.slice(-cols) : null;

  const plotLine = (values, char) => {
    if (!values) return;
    for (let col = 0; col < Math.min(values.length, cols); col++) {
      const r = toRow(values[col]);
      grid[r][col] = char;
    }
  };

  plotLine(ema8Slice, '₿');   // EMA 8
  plotLine(ema14Slice, '₤'); // EMA 14
  plotLine(ema50Slice, '∑'); // EMA 50

  // Build output
  const lastClose = closes[closes.length - 1];
  const lastRSI = rsi ? rsi[rsi.length - 1] : null;
  const ema8Val = ema8 ? ema8[ema8.length - 1] : null;
  const ema14Val = ema14 ? ema14[ema14.length - 1] : null;
  const ema50Val = ema50 ? ema50[ema50.length - 1] : null;

  let out = `SYMBOL: ${symbol} | TIMEFRAME: ${CONFIG.timeframe} | CANDLES: ${CONFIG.lookbackCandles}\n`;
  out += `${'═'.repeat(cols)}\n`;
  out += `Last Price: ${lastClose.toFixed(4)} | RSI(14): ${lastRSI ? lastRSI.toFixed(1) : 'N/A'}\n`;
  out += `EMA8:  ${ema8Val ? ema8Val.toFixed(4) : 'N/A'} | EMA14: ${ema14Val ? ema14Val.toFixed(4) : 'N/A'} | EMA50: ${ema50Val ? ema50Val.toFixed(4) : 'N/A'}\n`;
  out += `${'─'.repeat(cols)}\n`;
  for (const row of grid) out += row.join('') + '\n';
  out += `${'─'.repeat(cols)}\n`;
  out += `Min: ${min.toFixed(4)} | Max: ${max.toFixed(4)}\n`;
  out += `Legend: █/▓=CandleBody | │=Wick | ₿=EMA8 | ₤=EMA14 | ∑=EMA50\n`;
  out += `\nAnalyze: Is there a clear LONG, SHORT, or WAIT setup? Consider trend, support/resistance, EMA alignment, RSI overbought/oversold.\n`;
  out += `Reply EXACTLY in this format:\nDECISION: LONG|SHORT|WAIT\nCONFIDENCE: 0-100\nSL: price\nTP: price\nREASON: short explanation\n`;

  return out;
}

// Compute EMA
function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

// Compute RSI
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Ollama / LLaVA Analysis ─────────────────────────────────────────────────

async function analyzeWithOllamaVision(symbol, chartText) {
  const prompt = `You are an expert crypto trader analyzing 15-minute candlestick charts.\n\n${chartText}\n\nIMPORTANT: Reply ONLY with the following format, nothing else:\nDECISION: LONG\nCONFIDENCE: 75\nSL: 0.08234\nTP: 0.08567\nREASON: EMA crossover with RSI oversold and price bouncing from support`;

  try {
    const response = await axios.post(`${CONFIG.ollama.baseUrl}/api/generate`, {
      model: CONFIG.ollama.model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        top_p: 0.8,
      },
    }, { timeout: 60000 });

    const raw = response.data?.response || '';
    return parseOllamaResponse(raw);
  } catch (err) {
    return { decision: 'WAIT', confidence: 0, sl: null, tp: null, reason: `Ollama error: ${err.message}` };
  }
}

function parseOllamaResponse(raw) {
  const decisionMatch = raw.match(/DECISION:\s*(LONG|SHORT|WAIT)/i);
  const confidenceMatch = raw.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i);
  const slMatch = raw.match(/(?:SL|StopLoss):\s*([\d.]+)/i);
  const tpMatch = raw.match(/(?:TP|TakeProfit):\s*([\d.]+)/i);
  const reasonMatch = raw.match(/REASON:\s*(.*)/i);

  return {
    decision: decisionMatch ? decisionMatch[1].toUpperCase() : 'WAIT',
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) / 100 : 0,
    sl: slMatch ? parseFloat(slMatch[1]) : null,
    tp: tpMatch ? parseFloat(tpMatch[1]) : null,
    reason: reasonMatch ? reasonMatch[1].trim() : raw.slice(0, 120),
  };
}

// ─── Binance Data ─────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval = '15m', limit = 100) {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.klines}`, {
    params: { symbol, interval, limit },
  });
  return data;
}

async function fetchTopSymbols(limit = 20) {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker}`);
  return data
    .filter((t) => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map((t) => t.symbol);
}

// ─── Learning ─────────────────────────────────────────────────────────────────

function loadLearningHistory() {
  const f = path.join(CONFIG.alphaDir, 'decisions.jsonl');
  if (!fs.existsSync(f)) return [];
  return readJsonl(f).filter((e) => e.event === 'alpha_decision');
}

function saveDecision(record) {
  ensureDir(CONFIG.alphaDir);
  const f = path.join(CONFIG.alphaDir, 'decisions.jsonl');
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(f, line);
}

async function runLearningReport() {
  const since = Date.now() - CONFIG.learningWindow * 3600 * 1000;
  const decisions = loadLearningHistory().filter((d) => (d.ts || 0) >= since);

  const withOutcome = decisions.filter((d) => d.hit != null);
  const wins = withOutcome.filter((d) => d.hit === 'TP').length;
  const losses = withOutcome.filter((d) => d.hit === 'SL').length;
  const total = withOutcome.length;
  const winrate = total > 0 ? wins / total : 0;

  const msg = [
    '🧠 AlphaSight Learning Report',
    `Ventana: ${CONFIG.learningWindow}h | Decisions=${total} | TP=${wins} SL=${losses}`,
    `Winrate IA: ${(winrate * 100).toFixed(1)}%`,
    ``,
    ...(total > 0 ? [] : ['(Aún sin suficientes datos — sigue operando)']),
  ].join('\n');

  await sendTelegram(msg);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  const klines = await fetchKlines(symbol, CONFIG.timeframe, CONFIG.lookbackCandles);
  if (!klines || klines.length < 20) return null;

  const closes = klines.map((k) => parseFloat(k[4]));
  const ema8 = computeEMA(closes, 8);
  const ema14 = computeEMA(closes, 14);
  const ema50 = computeEMA(closes, 50);
  const rsi = computeRSI(closes, 14);

  const chartText = renderAsciiChart(symbol, klines, ema8, ema14, ema50, rsi);
  const analysis = await analyzeWithOllamaVision(symbol, chartText);

  return {
    symbol,
    ...analysis,
    ts: Date.now(),
    chartText: chartText.slice(0, 200), // store snippet for debugging
  };
}

async function main() {
  ensureDir(CONFIG.alphaDir);

  // 1. Screener: top symbols
  let topSymbols;
  try {
    topSymbols = await fetchTopSymbols(CONFIG.symbolsToAnalyze * 2);
    topSymbols = topSymbols.slice(0, CONFIG.symbolsToAnalyze);
  } catch (err) {
    console.error('Screener failed:', err.message);
    return;
  }

  // 2. Analyze each symbol
  const signals = [];
  for (const symbol of topSymbols) {
    try {
      const result = await analyzeSymbol(symbol);
      if (
        result &&
        (result.decision === 'LONG' || result.decision === 'SHORT') &&
        result.confidence >= CONFIG.minConfidence
      ) {
        signals.push(result);
      }
    } catch (err) {
      console.error(`Error analyzing ${symbol}:`, err.message);
    }
  }

  // 3. Sort by confidence and emit top signals
  signals.sort((a, b) => b.confidence - a.confidence);
  const top = signals.slice(0, 3);

  // Enqueue signals for IA validation (Pia will confirm/reject via web research)
  for (const sig of top) {
    enqueueSignal({
      id: `alpha_${sig.symbol}_${sig.ts}`,
      symbol: sig.symbol,
      side: sig.decision,
      sl: sig.sl,
      tp: sig.tp,
      confidence: sig.confidence,
      source: 'AlphaSight',
      ts: sig.ts,
    });
  }

  console.log(`AlphaSight: analyzed ${topSymbols.length} symbols, emitted ${top.length} signals`);
}

main().catch((e) => {
  console.error('AlphaSight fatal:', e);
  sendTelegram(`❌ AlphaSight error: ${e.message}`).catch(() => {});
  process.exitCode = 1;
});
