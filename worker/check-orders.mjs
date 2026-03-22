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
  `https://fapi.binance.com/fapi/v1/openOrders?timestamp=${ts}&recvWindow=60000&signature=${sig}`,
  { headers: { 'X-MBX-APIKEY': API_KEY } }
);

const orders = await r.json();
console.log('Open orders (SL/TP):', orders.length);
orders.forEach(o => {
  console.log(`  ${o.symbol} | ${o.side} | ${o.type} | Qty: ${o.origQty} | Stop: ${o.stopPrice} | Status: ${o.status}`);
});
