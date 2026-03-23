import crypto from 'crypto';

const API_KEY = 'p1K7TN11KrSsr4Vfr1C0Bs6LK3mcjkG2wEiIb9xaRQSKtbdJrSc7DlzwLu8IFMBE';
const API_SECRET = 'Xf6fSVpPAAp6nn3o84Vjmz953Gx3ex3kvorbWCkvGc1KBkrpCUpGoPwfkhOcAR0r';
const recvWindow = 15000;

async function main() {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');

  const url = `https://fapi.binance.com/fapi/v2/balance?${queryString}&signature=${signature}`;
  const resp = await fetch(url, {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const data = await resp.json();
  if (Array.isArray(data)) {
    const usdt = data.find(b => b.asset === 'USDT');
    console.log('USDT:', JSON.stringify(usdt));
  } else {
    console.log('Response:', JSON.stringify(data));
  }
}

main().catch(console.error);
