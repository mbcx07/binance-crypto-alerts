import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const KEY = process.env.FUTURES_API_KEY || '';
const SECRET = process.env.FUTURES_API_SECRET || '';

console.log('KEY length:', KEY.length);
console.log('SECRET length:', SECRET.length);

// Test signing
const msg = 'timestamp=1742619360000';
const sig = crypto.createHmac('sha256', SECRET).update(msg).digest('hex');
console.log('HMAC test:', sig.slice(0, 10), '...');

// Direct test
const url = `https://fapi.binance.com/fapi/v2/balance?timestamp=1742619360000&signature=${sig}`;
console.log('Testing:', url.slice(0, 80));

const res = await fetch(url, {
  headers: { 'X-MBX-APIKEY': KEY }
});
const text = await res.text();
console.log('Status:', res.status);
console.log('Response:', text.slice(0, 200));
