/**
 * AlphaSight — AI-powered symbol analysis using text-based indicators + Ollama reasoning.
 *
 * Pipeline:
 *  1. Screener → top N symbols by volume
 *  2. Fetch 15m klines (last 80 candles)
 *  3. Compute indicators: EMA8/14/50, RSI, ATR
 *  4. Send structured data to Ollama for reasoning
 *  5. Enqueue signals (LONG/SHORT) with confidence, SL, TP
 *  6. Pia validates via web search before sending to user
 *
 * Ollama endpoint: http://localhost:11434
 * Model: llava (loaded and ready)
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

// ─── Config ───────────────────────────────────────────────────────────────────

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
  symbolsToAnalyze: parseInt(process.env.ALPHA_SYMBOLS || '8', 10),
  timeframe: process.env.SCAN_TIMEFRAME || '15m',
  lookbackCandles: parseInt(process.env.ALPHA_LOOKBACK || '80', 10),
  minConfidence: parseFloat(process.env.ALPHA_MIN_CONFIDENCE || '0.70'),
  topAlerts: 20, // mantener 20 señales en cola para cuando abran nuevas

const api = axios.create({ timeout: 30000 });

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Indicators ───────────────────────────────────────────────────────────────

function computeATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const out = new Array(period).fill(null);
  const sma = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(sma);
  for (let i = period; i < trs.length; i++) {
    out.push((out[out.length - 1] * (period - 1) + trs[i]) / period);
  }
  return out;
}

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
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── Binance Data ──────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval = '15m', limit = 100) {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.klines}`, {
    params: { symbol, interval, limit },
  });
  return data;
}

// ─── Top symbols (from backtest) ──────────────────────────────────────────────

const TOP10_LIST = (CONFIG.alphaTopSymbols || '').split(',').filter(Boolean);

async function fetchTopSymbols(limit = 20) {
  const { data } = await axios.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker}`);
  return data
    .filter((t) => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map((t) => t.symbol);
}

// Analyze a single symbol and return result or null
async function analyzeOne(symbol) {
  const result = await analyzeSymbol(symbol);
  if (!result) return null;
  if (
    (result.decision === 'LONG' || result.decision === 'SHORT') &&
    result.confidence >= CONFIG.minConfidence
  ) {
    return {
      id: `alpha_${symbol}_${result.ts}`,
      symbol,
      side: result.decision,
      sl: result.sl,
      tp: result.tp,
      confidence: result.confidence,
      source: 'AlphaSight',
      ts: result.ts,
      reason: result.reason,
    };
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(CONFIG.alphaDir);

  // Part 1: Top 10 from backtest
  const top10Signals = [];
  if (TOP10_LIST.length) {
    console.log(`[AlphaSight] Scanning TOP 10 (backtest winners)...`);
    for (const symbol of TOP10_LIST) {
      const sig = await analyzeOne(symbol);
      if (sig) {
        top10Signals.push(sig);
        console.log(`[AlphaSight] TOP10 ${sig.side} ${symbol} (conf ${(sig.confidence*100).toFixed(0)}%)`);
      } else {
        console.log(`[AlphaSight] TOP10 ${symbol}: no signal`);
      }
    }
  }

  // Part 2: Full universe scan (top symbols by volume)
  const universeSignals = [];
  try {
    const universe = await fetchTopSymbols(CONFIG.symbolsToAnalyze);
    console.log(`[AlphaSight] Scanning universe: ${universe.length} symbols...`);
    for (const symbol of universe) {
      if (TOP10_LIST.includes(symbol)) continue; // skip duplicates
      const sig = await analyzeOne(symbol);
      if (sig) {
        universeSignals.push(sig);
        console.log(`[AlphaSight] UNIV ${sig.side} ${symbol} (conf ${(sig.confidence*100).toFixed(0)}%)`);
      }
    }
  } catch (err) {
    console.error('Screener failed:', err.message);
  }

  // Combine and rank by confidence
  const allSignals = [...top10Signals, ...universeSignals];
  allSignals.sort((a, b) => b.confidence - a.confidence);
  const finalTop = allSignals.slice(0, CONFIG.topAlerts);

  // Enqueue and send Telegram
  let enqueued = 0;
  for (const sig of finalTop) {
    enqueueSignal(sig);
    enqueued++;
    console.log(`[AlphaSight] ✅ ${sig.side} ${sig.symbol} (conf ${(sig.confidence*100).toFixed(0)}%) → queued`);
  }

  console.log(`[AlphaSight] Done: ${enqueued} signals enqueued for validation (${top10Signals.length} from TOP10, ${universeSignals.length} from universe)`);
}

async function fetch24hTicker(symbol) {
  const { data } = await api.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker}`, {
    params: { symbol },
  });
  return data;
}

// ─── Ollama Analysis ──────────────────────────────────────────────────────────

async function analyzeWithOllama(symbol, last, prev, rsiVal, ema8V, ema14V, ema50V, atrVal, closes, highs, lows) {
  const trend = (ema8V && ema14V && ema50V)
    ? (ema8V > ema14V && ema14V > ema50V ? 'BULLISH (ema8>ema14>ema50)' : ema8V < ema14V && ema14V < ema50V ? 'BEARISH (ema8<ema14<ema50)' : 'NEUTRAL')
    : 'UNKNOWN';

  const momentum = rsiVal > 70 ? 'OVERBOUGHT' : rsiVal < 30 ? 'OVERSOLD' : 'NEUTRAL';
  const changePct = ((last - prev) / prev * 100).toFixed(2);
  const volatility = atrVal ? ((atrVal / last) * 100).toFixed(3) : 'N/A';

  const prompt = `You are a professional crypto trader on Binance Futures, 15-minute timeframe.

Provide your trading analysis for ${symbol} based on this data:

Price: ${last?.toFixed(4)} | Change: ${changePct}%
RSI(14): ${rsiVal?.toFixed(1)} (${momentum})
EMA8: ${ema8V?.toFixed(4)} | EMA14: ${ema14V?.toFixed(4)} | EMA50: ${ema50V?.toFixed(4)}
ATR(14): ${atrVal?.toFixed(4)} (${volatility}% of price)
Trend: ${trend}

Last 10 closes: ${closes.slice(-10).map((c) => c.toFixed(2)).join(', ')}

What is your trading decision? Consider RSI overbought (>70) / oversold (<30), EMA alignment, momentum, and volatility.
The current candle is: ${closes[closes.length - 1] > closes[closes.length - 2] ? 'GREEN (bullish)' : 'RED (bearish)'}

Reply ONLY with this exact format, nothing else:
DECISION: LONG
CONFIDENCE: 0-100
SL: price (use ${last?.toFixed(4)} as reference, SL should be below entry for LONG)
TP: price (TP should be above entry for LONG)
REASON: 1-sentence explanation`;

  try {
    const response = await axios.post(`${CONFIG.ollama.baseUrl}/api/generate`, {
      model: CONFIG.ollama.model,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        top_p: 0.8,
        num_predict: 250,
      },
    }, { timeout: 90000 });

    const raw = response.data?.response || '';
    return parseOllamaResponse(raw, last);
  } catch (err) {
    return { decision: 'WAIT', confidence: 0, sl: null, tp: null, reason: `Error: ${err.message}` };
  }
}

function parseOllamaResponse(raw, lastPrice) {
  const decisionMatch = raw.match(/DECISION:\s*(LONG|SHORT|WAIT)/i);
  const confidenceMatch = raw.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i);
  const slMatch = raw.match(/(?:SL|StopLoss):\s*([\d.]+)/i);
  const tpMatch = raw.match(/(?:TP|TakeProfit):\s*([\d.]+)/i);
  const reasonMatch = raw.match(/REASON:\s*(.*)/i);

  let sl = slMatch ? parseFloat(slMatch[1]) : null;
  let tp = tpMatch ? parseFloat(tpMatch[1]) : null;

  // Sanitize: ensure SL/TP are numeric and reasonable
  if (sl && (isNaN(sl) || sl === 0)) sl = null;
  if (tp && (isNaN(tp) || tp === 0)) tp = null;

  return {
    decision: decisionMatch ? decisionMatch[1].toUpperCase() : 'WAIT',
    confidence: confidenceMatch ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1]) / 100)) : 0,
    sl,
    tp,
    reason: reasonMatch ? reasonMatch[1].trim().slice(0, 200) : raw.slice(0, 120),
  };
}

// ─── Symbol Analysis ──────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  try {
    const klines = await fetchKlines(symbol, CONFIG.timeframe, CONFIG.lookbackCandles);
    if (!klines || klines.length < 20) return null;

    const closes = klines.map((k) => parseFloat(k[4]));
    const highs = klines.map((k) => parseFloat(k[2]));
    const lows = klines.map((k) => parseFloat(k[3]));

    const ema8 = computeEMA(closes, 8);
    const ema14 = computeEMA(closes, 14);
    const ema50 = computeEMA(closes, 50);
    const rsi = computeRSI(closes, 14);
    const atr = computeATR(highs, lows, closes, 14);

    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const rsiVal = rsi?.[rsi.length - 1];
    const ema8V = ema8?.[ema8.length - 1];
    const ema14V = ema14?.[ema14.length - 1];
    const ema50V = ema50?.[ema50.length - 1];
    const atrVal = atr?.[atr.length - 1];

    let analysis = indicatorDecision(symbol, last, prev, rsiVal, ema8V, ema14V, ema50V, atrVal);

    // Try Ollama in parallel — if it responds within 15s, use its answer instead
    const ollamaPromise = analyzeWithOllama(symbol, last, prev, rsiVal, ema8V, ema14V, ema50V, atrVal, closes, highs, lows);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 15000));

    const ollamaResult = await Promise.race([ollamaPromise, timeoutPromise]);
    if (ollamaResult && ollamaResult.decision !== 'WAIT' && ollamaResult.confidence >= CONFIG.minConfidence) {
      analysis = ollamaResult;
      console.log(`[AlphaSight] ${symbol}: Ollama override: ${analysis.decision}`);
    } else if (analysis) {
      console.log(`[AlphaSight] ${symbol}: using indicator fallback: ${analysis.decision}`);
    }

    return { symbol, ...analysis, ts: Date.now() };
  } catch (err) {
    console.error(`Error analyzing ${symbol}:`, err.message);
    return null;
  }
}

// Indicator-based fallback (no AI needed)
function indicatorDecision(symbol, last, prev, rsiVal, ema8V, ema14V, ema50V, atrVal) {
  if (!ema8V || !ema14V || !ema50V || !atrVal) return null;

  const emaBull = ema8V > ema14V && ema14V > ema50V;
  const emaBear = ema8V < ema14V && ema14V < ema50V;
  const rsiOB = rsiVal > 70;
  const rsiOS = rsiVal < 30;

  let decision = null;
  let confidence = 0;
  let reason = '';

  if (emaBull && rsiOS) {
    decision = 'LONG';
    confidence = 0.78;
    reason = 'EMA bullish alignment + RSI oversold — bounce setup';
  } else if (emaBull && !rsiOB) {
    decision = 'LONG';
    confidence = 0.72;
    reason = 'EMA bullish alignment — trend continuation';
  } else if (emaBear && rsiOB) {
    decision = 'SHORT';
    confidence = 0.78;
    reason = 'EMA bearish alignment + RSI overbought — drop setup';
  } else if (emaBear && !rsiOS) {
    decision = 'SHORT';
    confidence = 0.72;
    reason = 'EMA bearish alignment — trend continuation';
  }

  if (!decision) return null;

  // SL = ATR × 1.8 — TP = SL × 2.0 (RR = 1:2)
  const slDist = atrVal * 1.8;
  const tpDist  = slDist * 2.0;   // ganancia doble del riesgo
  const sl = decision === 'LONG' ? last - slDist : last + slDist;
  const tp = decision === 'LONG' ? last + tpDist : last - tpDist;

  return { decision, confidence, sl, tp, reason };
}



main().catch((e) => {
  console.error('[AlphaSight] Fatal:', e.message);
  process.exitCode = 1;
});
