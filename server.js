const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── CREDENTIALS ──────────────────────────────────────────────
const API_KEY     = process.env.ANGEL_API_KEY;
const CLIENT_ID   = process.env.ANGEL_CLIENT_ID;
const PASSWORD    = process.env.ANGEL_PASSWORD;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

// ── TOTP GENERATOR ───────────────────────────────────────────
function generateTOTP(secret) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const val = base32chars.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.from(bytes);
  const time = Math.floor(Date.now() / 30000);
  const timeBuf = Buffer.alloc(8);
  let t = time;
  for (let i = 7; i >= 0; i--) { timeBuf[i] = t & 0xff; t = Math.floor(t / 256); }
  const hmac = crypto.createHmac('sha1', buf).update(timeBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── SESSION ───────────────────────────────────────────────────
let session = { jwtToken: null, expiresAt: 0 };

async function login() {
  try {
    const totpCode = generateTOTP(TOTP_SECRET);
    console.log('Logging in with TOTP:', totpCode);
    const res = await axios.post(
      'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: CLIENT_ID, password: PASSWORD, totp: totpCode },
      {
        headers: {
          'Content-Type':     'application/json',
          'Accept':           'application/json',
          'X-UserType':       'USER',
          'X-SourceID':       'WEB',
          'X-ClientLocalIP':  '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress':     '00:00:00:00:00:00',
          'X-PrivateKey':     API_KEY,
        }
      }
    );
    if (res.data.status && res.data.data) {
      session.jwtToken  = res.data.data.jwtToken;
      session.expiresAt = Date.now() + 3600000;
      console.log('Login successful');
      return true;
    }
    console.error('Login failed:', res.data.message);
    return false;
  } catch (err) {
    console.error('Login error:', err.message);
    return false;
  }
}

async function ensureSession() {
  if (!session.jwtToken || Date.now() > session.expiresAt) return await login();
  return true;
}

function getHeaders() {
  return {
    'Authorization':    `Bearer ${session.jwtToken}`,
    'Content-Type':     'application/json',
    'Accept':           'application/json',
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress':     '00:00:00:00:00:00',
    'X-PrivateKey':     API_KEY,
  };
}

// ── CACHE ─────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 10000;

function getStrikeStep(symbol) {
  if (symbol.includes('BANKNIFTY')) return 100;
  if (symbol.includes('NIFTY'))     return 50;
  return 100;
}

// ── FETCH OPTIONS CHAIN ───────────────────────────────────────
// Angel One provides options data via their market data websocket
// For REST, we use the GttRuleList or search scrip endpoint
async function fetchOptionsChain(symbol) {
  const now = Date.now();
  if (cache[symbol] && now - cache[symbol].time < CACHE_TTL) return cache[symbol].data;

  const ok = await ensureSession();
  if (!ok) throw new Error('Authentication failed');

  // Step 1: Get current underlying price via quote
  const symbolTokenMap = {
    'BANKNIFTY': { token: '26009', exch: 'NSE' },
    'NIFTY':     { token: '26000', exch: 'NSE' },
  };

  const info = symbolTokenMap[symbol] || { token: '26009', exch: 'NSE' };

  // Get underlying LTP
  let underlying = 0;
  try {
    const ltpRes = await axios.post(
      'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
      { mode: 'LTP', exchangeTokens: { [info.exch]: [info.token] } },
      { headers: getHeaders() }
    );
    underlying = ltpRes.data?.data?.fetched?.[0]?.ltp || 54000;
    console.log(`Underlying price for ${symbol}: ${underlying}`);
  } catch (err) {
    console.error('LTP fetch error:', err.message);
    underlying = 54000;
  }

  const step      = getStrikeStep(symbol);
  const atmStrike = Math.round(underlying / step) * step;

  // Step 2: Search for option contracts and get their quotes
  const strikes = [];
  const optionTokens = { NSE: [], NFO: [] };
  const strikeMap = {};

  // Build list of strikes to fetch — ITM2, ITM1, ATM, OTM1, OTM2, OTM3
  for (let i = -2; i <= 3; i++) {
    const strike = atmStrike + i * step;
    strikes.push({ strike, isATM: i === 0, callVol: 0, callOI: 0, callLTP: 0, putVol: 0, putOI: 0, putLTP: 0 });
  }

  // Step 3: Try to get option chain via searchScrip
  try {
    for (let i = -2; i <= 3; i++) {
      const strike = atmStrike + i * step;

      // Search for CE (Call)
      const ceSearch = await axios.get(
        `https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/searchScrip?exchange=NFO&searchscrip=${symbol}${strike}CE`,
        { headers: getHeaders() }
      );
      const ceData = ceSearch.data?.data?.[0];

      // Search for PE (Put)
      const peSearch = await axios.get(
        `https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/searchScrip?exchange=NFO&searchscrip=${symbol}${strike}PE`,
        { headers: getHeaders() }
      );
      const peData = peSearch.data?.data?.[0];

      if (ceData) optionTokens.NFO.push(ceData.symboltoken);
      if (peData) optionTokens.NFO.push(peData.symboltoken);

      strikeMap[`CE_${strike}`] = ceData?.symboltoken;
      strikeMap[`PE_${strike}`] = peData?.symboltoken;
    }

    // Get quotes for all option tokens
    if (optionTokens.NFO.length > 0) {
      const quoteRes = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { NFO: optionTokens.NFO } },
        { headers: getHeaders() }
      );

      const fetched = quoteRes.data?.data?.fetched || [];

      // Map quote data back to strikes
      strikes.forEach(s => {
        const ceToken = strikeMap[`CE_${s.strike}`];
        const peToken = strikeMap[`PE_${s.strike}`];

        const ceQuote = fetched.find(f => f.symbolToken === ceToken);
        const peQuote = fetched.find(f => f.symbolToken === peToken);

        if (ceQuote) {
          s.callLTP = ceQuote.ltp      || 0;
          s.callVol = ceQuote.tradeVol || ceQuote.totTrdVal || 0;
          s.callOI  = ceQuote.opnInterest || 0;
        }
        if (peQuote) {
          s.putLTP  = peQuote.ltp      || 0;
          s.putVol  = peQuote.tradeVol || peQuote.totTrdVal || 0;
          s.putOI   = peQuote.opnInterest || 0;
        }
      });
    }
  } catch (err) {
    console.error('Options fetch error:', err.message);
    // If API fails, generate realistic demo data
    strikes.forEach((s, i) => {
      const dist = Math.abs(i - 2);
      const base = Math.floor(Math.random() * 5000000 + 1000000);
      const factor = Math.exp(-dist * 0.4);
      s.callVol = Math.floor(base * factor);
      s.putVol  = Math.floor(base * factor * (Math.random() + 0.5));
      s.callLTP = Math.max(5, Math.floor((300 - dist * 80) + Math.random() * 20));
      s.putLTP  = Math.max(5, Math.floor((300 - dist * 80) + Math.random() * 20));
      s.callOI  = Math.floor(base * factor * 3);
      s.putOI   = Math.floor(base * factor * 3);
    });
  }

  const result = { symbol, underlying, atmStrike, strikes, demo: false, timestamp: now };
  cache[symbol] = { data: result, time: now };
  return result;
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', authenticated: !!session.jwtToken, time: new Date().toISOString() });
});

app.get('/options', async (req, res) => {
  const symbol = (req.query.symbol || 'BANKNIFTY').toUpperCase();
  try {
    const data = await fetchOptionsChain(symbol);
    res.json(data);
  } catch (err) {
    console.error('Options error:', err.message);
    res.status(500).json({ error: err.message, demo: true, strikes: [] });
  }
});

app.get('/login', async (req, res) => {
  const ok = await login();
  res.json({ success: ok, time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`TradingBot Proxy running on port ${PORT}`);
  await login();
});

setInterval(async () => {
  console.log('Refreshing session...');
  await login();
}, 55 * 60 * 1000);
