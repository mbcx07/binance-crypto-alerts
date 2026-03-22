/**
 * clean-queue.js — Limpia cola de validate-queue.json
 * Elimina entradas stale: TRADE_ACTIVE que ya no existen en Binance
 * y PENDING muy antiguas (>24h)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { readQueue, writeQueue } from './validate-queue.js';
import { getAllPositions } from './trader.js';

async function main() {
  const queue = readQueue();
  const openPositions = await getAllPositions();
  const openSymbols = new Set(openPositions.map(p => p.symbol));

  const before = queue.length;
  const cleaned = queue.filter(entry => {
    // Mantener PENDING solo si son < 24h
    if (entry.status === 'PENDING') {
      const age = Date.now() - (entry.ts || 0);
      if (age > 24 * 3600 * 1000) return false; // >24h → eliminar
      return true;
    }
    // Mantener TRADE_ACTIVE solo si realmente está abierto en Binance
    if (entry.status === 'TRADE_ACTIVE') {
      return openSymbols.has(entry.symbol);
    }
    // Eliminar todo lo demás (CONFIRMED, REJECTED, etc.)
    return false;
  });

  writeQueue(cleaned);
  console.log(`Cola limpia: ${before} → ${cleaned.length} (eliminadas ${before - cleaned.length})`);
  console.log(`PENDING: ${cleaned.filter(s=>s.status==='PENDING').length} | TRADE_ACTIVE: ${cleaned.filter(s=>s.status==='TRADE_ACTIVE').length}`);
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
