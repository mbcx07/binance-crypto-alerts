import axios from 'axios';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// CONFIGURATION
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
    topN: 5,
    timeframe: '15m',
    minVolume: 5000000, // 5M USDT minimum 24h volume
    cooldownMinutes: 60,
    breakoutPeriod: 20,
    atrPeriod: 14,
    volumeSpikeThreshold: 1.5,
  },
};

// ===============================
// ZOD SCHEMAS
// ===============================
const BinanceSymbolSchema = z.object({
  symbol: z.string(),
  quoteVolume: z.number(),
  priceChangePercent: z.number(),
  lastPrice: z.string(),
});

const KlineSchema = z.object({
  openTime: z.number(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
});

// ===============================
// BINARYCE API HELPERS
// ===============================
async function getExchangeInfo() {
  const response = await axios.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.exchangeInfo}`);
  return response.data;
}

async function get24hTicker() {
  const response = await axios.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.ticker24h}`);
  return response.data;
}

async function getKlines(symbol, interval, limit) {
  const response = await axios.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.klines}`, {
    params: { symbol, interval, limit },
  });
  return response.data;
}

// ===============================
// TECHNICAL INDICATORS
// ===============================
function calculateATR(klines, period) {
  let trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i - 1][4]);

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return 0;

  let atr = trueRanges[0];
  for (let i = 1; i < period; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

function calculateVolumeSpike(klines, period, currentVolume) {
  const volumes = klines.slice(-period).map((k) => parseFloat(k[5]));
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  return avgVolume > 0 ? currentVolume / avgVolume : 0;
}

function detectBreakout(klines, period) {
  const recent = klines.slice(-period);
  const highs = recent.map((k) => parseFloat(k[2]));
  const lows = recent.map((k) => parseFloat(k[3]));
  const currentClose = parseFloat(klines[klines.length - 1][4]);
  const currentHigh = parseFloat(klines[klines.length - 1][2]);
  const currentLow = parseFloat(klines[klines.length - 1][3]);

  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);

  return {
    isBuyBreakout: currentClose > highestHigh,
    isSellBreakout: currentClose < lowestLow,
    highestHigh,
    lowestLow,
    currentClose,
  };
}

// ===============================
// SCANNER LOGIC
// ===============================
async function scanSignals() {
  console.log('🔍 Starting Binance scanner...');

  // Get all USDT-M PERPETUAL symbols
  const exchangeInfo = await getExchangeInfo();
  const symbols = exchangeInfo.symbols.filter(
    (s) =>
      s.contractType === 'PERPETUAL' &&
      s.quoteAsset === 'USDT' &&
      s.status === 'TRADING'
  );

  console.log(`📊 Found ${symbols.length} USDT-M PERPETUAL symbols`);

  // Get 24h ticker data for filtering
  const tickerData = await get24hTicker();
  const tickerMap = new Map(tickerData.map((t) => [t.symbol, t]));

  // Filter by volume and liquidity
  const activeSymbols = symbols
    .map((s) => {
      const ticker = tickerMap.get(s.symbol);
      return ticker ? { ...s, ticker } : null;
    })
    .filter((s) => s && s.ticker.quoteVolume >= CONFIG.scanner.minVolume)
    .sort((a, b) => b.ticker.quoteVolume - a.ticker.quoteVolume)
    .slice(0, 200); // Top 200 by volume

  console.log(`🔥 Analyzing ${activeSymbols.length} active symbols...`);

  const signals = [];

  for (const symbol of activeSymbols) {
    try {
      // Get klines
      const klines = await getKlines(symbol.symbol, CONFIG.scanner.timeframe, CONFIG.scanner.breakoutPeriod + CONFIG.scanner.atrPeriod);

      if (klines.length < CONFIG.scanner.breakoutPeriod + CONFIG.scanner.atrPeriod) {
        continue;
      }

      // Calculate indicators
      const currentVolume = parseFloat(klines[klines.length - 1][5]);
      const volumeSpike = calculateVolumeSpike(klines, 20, currentVolume);
      const atr = calculateATR(klines, CONFIG.scanner.atrPeriod);
      const breakout = detectBreakout(klines, CONFIG.scanner.breakoutPeriod);

      // Skip if no significant movement
      if (volumeSpike < CONFIG.scanner.volumeSpikeThreshold && !breakout.isBuyBreakout && !breakout.isSellBreakout) {
        continue;
      }

      // Calculate score
      let score = 0;
      let type = null;
      let reason = [];

      if (breakout.isBuyBreakout) {
        score += 3;
        type = 'BUY';
        reason.push(`breakout(${CONFIG.scanner.breakoutPeriod})`);
      } else if (breakout.isSellBreakout) {
        score += 3;
        type = 'SELL';
        reason.push(`breakout(${CONFIG.scanner.breakoutPeriod})`);
      }

      if (volumeSpike >= CONFIG.scanner.volumeSpikeThreshold) {
        score += 2;
        reason.push(`volSpike(${volumeSpike.toFixed(1)})`);
      }

      if (atr > 0) {
        const price = parseFloat(klines[klines.length - 1][4]);
        const atrPercent = (atr / price) * 100;
        score += Math.min(3, atrPercent);
        reason.push('ATR');
      }

      // Skip low scores
      if (score < 4) continue;

      signals.push({
        id: `${symbol.symbol}-${Date.now()}`,
        pair: symbol.symbol,
        type: type || 'WATCH',
        price: parseFloat(klines[klines.length - 1][4]),
        score: Math.min(10, score),
        reason: reason.join('+'),
        timestamp: Date.now(),
        volume24h: symbol.ticker.quoteVolume,
      });

    } catch (error) {
      console.error(`❌ Error scanning ${symbol.symbol}:`, error.message);
    }
  }

  // Sort by score and get top N
  const topSignals = signals.sort((a, b) => b.score - a.score).slice(0, CONFIG.scanner.topN);

  console.log(`✅ Generated ${topSignals.length} signals`);

  // Save signals to data file
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dataDir, 'signals.json'),
    JSON.stringify(topSignals, null, 2)
  );

  return topSignals;
}

// ===============================
// TELEGRAM NOTIFICATIONS
// ===============================
async function sendTelegramAlert(signal) {
  const message = `[${CONFIG.scanner.timeframe}][USDT-M] ${signal.pair} | ${signal.type} | ${signal.price.toFixed(2)} | score=${signal.score.toFixed(1)} | ${signal.reason} | ${new Date(signal.timestamp).toISOString()}`;

  try {
    await axios.post(CONFIG.telegram.apiUrl, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
      parse_mode: 'HTML',
    });
    console.log(`📤 Sent alert for ${signal.pair}`);
  } catch (error) {
    console.error(`❌ Failed to send alert for ${signal.pair}:`, error.message);
  }
}

async function sendCooldownAlert(symbol, lastSignalTime) {
  const cooldownRemaining = Math.max(0, CONFIG.scanner.cooldownMinutes * 60 * 1000 - (Date.now() - lastSignalTime));
  const cooldownMinutes = Math.ceil(cooldownRemaining / (60 * 1000));
  console.log(`⏸️ ${symbol} in cooldown: ${cooldownMinutes} minutes remaining`);
}

// ===============================
// COOLDOWN MANAGEMENT
// ===============================
let lastSignals = {};

async function loadLastSignals() {
  const dataDir = path.join(__dirname, '..', 'data');
  const file = path.join(dataDir, 'last-signals.json');

  if (fs.existsSync(file)) {
    try {
      const data = fs.readFileSync(file, 'utf-8');
      lastSignals = JSON.parse(data);
    } catch (error) {
      console.error('❌ Failed to load last signals:', error.message);
    }
  }
}

async function saveLastSignals() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dataDir, 'last-signals.json'),
    JSON.stringify(lastSignals, null, 2)
  );
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
// MAIN EXECUTION
// ===============================
async function main() {
  try {
    await loadLastSignals();

    const signals = await scanSignals();

    for (const signal of signals) {
      if (isSymbolInCooldown(signal.pair)) {
        await sendCooldownAlert(signal.pair, lastSignals[signal.pair]);
        continue;
      }

      await sendTelegramAlert(signal);
      markSymbolAlerted(signal.pair);
    }

    await saveLastSignals();

    console.log('🏁 Scanner completed successfully');
  } catch (error) {
    console.error('❌ Scanner failed:', error);
    process.exit(1);
  }
}

main();
