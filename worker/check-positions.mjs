import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const API_KEY = process.env.FUTURES_API_KEY;
const API_SECRET = process.env.FUTURES_API_SECRET;

const ts = Date.now();
const sig = crypto.createHmac('sha256', API_SECRET)
  .update(`timestamp=${ts}&recvWindow=60000`)
  .digest('hex');

const r = await fetch(
  `https://fapi.binance.com/fapi/v2/positionRisk?timestamp=${ts}&recvWindow=60000&signature=${sig}`,
  { headers: { 'X-MBX-APIKEY': API_KEY } }
);

const data = await r.json();
const open = data.filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
console.log('Open positions:', open.length);
open.forEach(p => {
  console.log(`  ${p.symbol} | ${p.positionAmt} | entry: ${p.entryPrice} | pnl: ${p.unrealizedProfit} | ${p.symbol}`);
});
