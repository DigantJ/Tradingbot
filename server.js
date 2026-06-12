// TradingBot Pro — NSE Proxy Server
// Deploy free on Render.com

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// NSE headers to avoid blocking
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Connection': 'keep-alive',
};

// Cache to avoid hammering NSE
let cache = {};
const CACHE_TTL = 10000; // 10 seconds

async function getNSECookies() {
  try {
    const res = await axios.get('https://www.nseindia.com/', {
      headers: NSE_HEADERS, timeout: 8000
    });
    return res.headers['set-cookie']?.join('; ') || '';
  } catch { return ''; }
}

let cookies = '';
let cookieTime = 0;

async function fetchOptionsChain(symbol) {
  const now = Date.now();

  // Return cache if fresh
  if (cache[symbol] && now - cache[symbol].time < CACHE_TTL) {
    return cache[symbol].data;
  }

  // Refresh cookies every 5 minutes
  if (now - cookieTime > 300000) {
    cookies = await getNSECookies();
    cookieTime = now;
  }

  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
  const res = await axios.get(url, {
    headers: { ...NSE_HEADERS, 'Cookie': cookies },
    timeout: 8000,
  });

  const raw = res.data;
  const underlying = raw.records?.underlyingValue || 0;
  const atmStrike  = raw.records?.strikePrices
    ? raw.records.strikePrices.reduce((prev, curr) =>
        Math.abs(curr - underlying) < Math.abs(prev - underlying) ? curr : prev
      )
    : Math.round(underlying / 100) * 100;

  const strikes = [];
  const expiryDate = raw.records?.expiryDates?.[0];

  if (raw.records?.data) {
    // Get current + nearby strikes
    const step = symbol === 'BANKNIFTY' ? 100 : 50;
    const range = [-2, -1, 0, 1, 2, 3];
    const targetStrikes = range.map(i => atmStrike + i * step);

    targetStrikes.forEach(strike => {
      const rows = raw.records.data.filter(
        d => d.strikePrice === strike && (!expiryDate || d.expiryDate === expiryDate)
      );

      let callVol = 0, putVol = 0, callOI = 0, putOI = 0, callLTP = 0, putLTP = 0;
      rows.forEach(row => {
        if (row.CE) {
          callVol += row.CE.totalTradedVolume || 0;
          callOI  += row.CE.openInterest      || 0;
          callLTP  = row.CE.lastPrice          || 0;
        }
        if (row.PE) {
          putVol += row.PE.totalTradedVolume || 0;
          putOI  += row.PE.openInterest      || 0;
          putLTP  = row.PE.lastPrice          || 0;
        }
      });

      strikes.push({
        strike, isATM: strike === atmStrike,
        callVol, putVol, callOI, putOI, callLTP, putLTP
      });
    });
  }

  const result = { symbol, underlying, atmStrike, strikes, demo: false, timestamp: now };
  cache[symbol] = { data: result, time: now };
  return result;
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/options', async (req, res) => {
  const symbol = (req.query.symbol || 'BANKNIFTY').toUpperCase();
  try {
    const data = await fetchOptionsChain(symbol);
    res.json(data);
  } catch (err) {
    console.error('NSE fetch error:', err.message);
    res.status(500).json({ error: err.message, demo: true });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`TradingBot Proxy running on port ${PORT}`));
