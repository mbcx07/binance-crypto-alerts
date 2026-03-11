import axios from 'axios';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

// ===============================
// CONFIGURATION
// ===============================
const CONFIG = {
  binance: {
    baseUrl: 'https://fapi.binance.com',
    exchangeInfo: '/fapi/v1/exchangeInfo',
    ticker24h: '/fapi/v1/ticker/24hr',
    tickerPrice: '/fapi/v1/ticker/price',
    klines: '/fapi/v1/klines',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
  },
  scanner: {
    maxPositions: 10,
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

function determineTrendDirection(klines, period = 10) {
  const recent = klines.slice(-period);
  const closes = recent.map((k) => parseFloat(k[4]));
  
  // Simple Moving Average
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const currentClose = closes[closes.length - 1];
  
  // Determine direction based on price relative to SMA and recent momentum
  const recentChange = (currentClose - closes[0]) / closes[0];
  
  if (currentClose > sma && recentChange > 0) {
    return 'BUY';
  } else if (currentClose < sma && recentChange < 0) {
    return 'SELL';
  } else if (recentChange > 0) {
    return 'BUY';
  } else if (recentChange < 0) {
    return 'SELL';
  }
  
  return 'BUY'; // Default to BUY if neutral
}

// ===============================
// POSITION MANAGEMENT
// ===============================
const DATA_DIR = path.join(__dirname, '..', 'data');

function loadActivePositions() {
  const file = path.join(DATA_DIR, 'active-positions.json');
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    console.error('❌ Failed to load active positions:', error.message);
    return [];
  }
}

function saveActivePositions(positions) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(DATA_DIR, 'active-positions.json'),
    JSON.stringify(positions, null, 2)
  );
}

async function getCurrentPrice(symbol) {
  const response = await axios.get(`${CONFIG.binance.baseUrl}${CONFIG.binance.tickerPrice}`, {
    params: { symbol },
  });
  return parseFloat(response.data.price);
}

async function checkPositionClosures() {
  const positions = loadActivePositions();
  if (positions.length === 0) return [];

  const closedPositions = [];

  for (const position of positions) {
    try {
      const currentPrice = await getCurrentPrice(position.pair);
      
      if (position.type === 'BUY') {
        if (currentPrice <= position.stopLoss) {
          position.closedAt = Date.now();
          position.closedBy = 'STOP_LOSS';
          position.closePrice = currentPrice;
          position.pnl = currentPrice - position.entry;
          closedPositions.push(position);
        } else if (currentPrice >= position.takeProfit) {
          position.closedAt = Date.now();
          position.closedBy = 'TAKE_PROFIT';
          position.closePrice = currentPrice;
          position.pnl = currentPrice - position.entry;
          closedPositions.push(position);
        }
      } else {
        // SELL
        if (currentPrice >= position.stopLoss) {
          position.closedAt = Date.now();
          position.closedBy = 'STOP_LOSS';
          position.closePrice = currentPrice;
          position.pnl = position.entry - currentPrice;
          closedPositions.push(position);
        } else if (currentPrice <= position.takeProfit) {
          position.closedAt = Date.now();
          position.closedBy = 'TAKE_PROFIT';
          position.closePrice = currentPrice;
          position.pnl = position.entry - currentPrice;
          closedPositions.push(position);
        }
      }
    } catch (error) {
      console.error(`❌ Error checking position ${position.pair}:`, error.message);
    }
  }

  if (closedPositions.length > 0) {
    // Remove closed positions
    const activePositions = positions.filter(p => 
      !closedPositions.some(cp => cp.id === p.id)
    );
    saveActivePositions(activePositions);

    // Send alerts for closed positions
    for (const closed of closedPositions) {
      await sendPositionClosedAlert(closed);
    }
  }

  return closedPositions;
}

async function sendPositionClosedAlert(position) {
  const pnlPercent = (position.pnl / position.entry) * 100;
  const emoji = position.closedBy === 'TAKE_PROFIT' ? '✅' : '❌';
  
  const message = `${emoji} Posición CERRADA\n\n` +
    `[${position.pair}] ${position.type}\n` +
    `📊 Entrada: ${position.entry.toFixed(4)}\n` +
    `🔚 Cierre: ${position.closePrice.toFixed(4)}\n` +
    `💰 PnL: ${position.pnl >= 0 ? '+' : ''}${position.pnl.toFixed(4)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
    `📌 ${position.closedBy === 'TAKE_PROFIT' ? 'Take Profit alcanzado' : 'Stop Loss alcanzado'}`;

  try {
    await axios.post(CONFIG.telegram.apiUrl, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
    });
    console.log(`📤 Sent closed position alert for ${position.pair}`);
  } catch (error) {
    console.error(`❌ Failed to send closed position alert for ${position.pair}:`, error.message);
  }
}

async function addPositionToActive(signal) {
  const positions = loadActivePositions();
  
  const newPosition = {
    id: signal.id,
    pair: signal.pair,
    type: signal.type,
    entry: signal.price,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    score: signal.score,
    reason: signal.reason,
    timestamp: signal.timestamp,
    volume24h: signal.volume24h,
  };
  
  positions.push(newPosition);
  saveActivePositions(positions);
  
  console.log(`✅ Added ${signal.pair} to active positions (${positions.length}/${CONFIG.scanner.maxPositions})`);
}

function manualClosePosition(pair) {
  const positions = loadActivePositions();
  const index = positions.findIndex(p => p.pair === pair);
  
  if (index === -1) {
    console.log(`⚠️ Position ${pair} not found in active positions`);
    return false;
  }
  
  const position = positions[index];
  
  try {
    getCurrentPrice(position.pair).then(currentPrice => {
      position.closedAt = Date.now();
      position.closedBy = 'MANUAL';
      position.closePrice = currentPrice;
      position.pnl = position.type === 'BUY' 
        ? currentPrice - position.entry 
        : position.entry - currentPrice;
      
      sendPositionClosedAlert(position);
      
      const activePositions = positions.filter(p => p.id !== position.id);
      saveActivePositions(activePositions);
      
      console.log(`✅ Manually closed position ${pair}`);
    });
    
    return true;
  } catch (error) {
    console.error(`❌ Error manually closing position ${pair}:`, error.message);
    return false;
  }
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

      const currentPrice = parseFloat(klines[klines.length - 1][4]);
      
      // If no breakout detected, determine direction based on trend
      if (type === null) {
        type = determineTrendDirection(klines, 10);
        reason.push('trend');
      }
      
      // Calculate Stop Loss and Take Profit based on ATR
      const stopLossMultiplier = 1.5;
      const takeProfitMultiplier = 2.5;
      let stopLoss, takeProfit;

      if (type === 'BUY') {
        stopLoss = currentPrice - (atr * stopLossMultiplier);
        takeProfit = currentPrice + (atr * takeProfitMultiplier);
      } else {
        // SELL
        stopLoss = currentPrice + (atr * stopLossMultiplier);
        takeProfit = currentPrice - (atr * takeProfitMultiplier);
      }

      signals.push({
        id: `${symbol.symbol}-${Date.now()}`,
        pair: symbol.symbol,
        type: type || 'WATCH',
        price: currentPrice,
        stopLoss: stopLoss,
        takeProfit: takeProfit,
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
  let message = `[${CONFIG.scanner.timeframe}][USDT-M] ${signal.pair} | ${signal.type}\n`;
  message += `💰 Entry: ${signal.price.toFixed(4)}\n`;
  
  if (signal.stopLoss !== null && signal.takeProfit !== null) {
    message += `🛑 Stop Loss: ${signal.stopLoss.toFixed(4)}\n`;
    message += `🎯 Take Profit: ${signal.takeProfit.toFixed(4)}\n`;
    message += `📊 R:R = ${Math.abs((signal.takeProfit - signal.price) / (signal.price - signal.stopLoss)).toFixed(2)}\n`;
  }
  
  message += `⭐ Score: ${signal.score.toFixed(1)} | ${signal.reason}`;

  try {
    await axios.post(CONFIG.telegram.apiUrl, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
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
    console.log('🔄 Starting position check...');
    
    // Check for SL/TP closures
    const closedPositions = await checkPositionClosures();
    
    if (closedPositions.length > 0) {
      console.log(`📊 Closed ${closedPositions.length} position(s)`);
    }

    // Load active positions
    const activePositions = loadActivePositions();
    console.log(`📈 Active positions: ${activePositions.length}/${CONFIG.scanner.maxPositions}`);

    // Only scan if we have space for new positions
    if (activePositions.length >= CONFIG.scanner.maxPositions) {
      console.log(`⏸️ Maximum positions (${CONFIG.scanner.maxPositions}) reached. Skipping scan.`);
      console.log('🏁 Scanner completed (max positions reached)');
      return;
    }

    // Scan for new signals
    const signals = await scanSignals();

    // Filter signals: exclude pairs already in active positions
    const availableSlots = CONFIG.scanner.maxPositions - activePositions.length;
    const uniqueSignals = signals.filter(signal => 
      !activePositions.some(pos => pos.pair === signal.pair)
    ).slice(0, availableSlots);

    console.log(`📊 Generated ${signals.length} signals, ${uniqueSignals.length} eligible for entry`);

    // Send alerts and add to active positions
    for (const signal of uniqueSignals) {
      await sendTelegramAlert(signal);
      await addPositionToActive(signal);
    }

    console.log('🏁 Scanner completed successfully');
  } catch (error) {
    console.error('❌ Scanner failed:', error);
    process.exit(1);
  }
}

main();
