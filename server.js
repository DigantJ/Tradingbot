const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

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
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    const val = base32chars.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const buf = Buffer.from(bytes);
  const time = Math.floor(Date.now() / 30000);
  const timeBuf = Buffer.alloc(8);
  let t = time;
  for (let i = 7; i >= 0; i--) { timeBuf[i] = t & 0xff; t >>= 8; }
  const crypto = require('crypto');
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
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': API_KEY,
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
    'Authorization': `Bearer ${session.jwtToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': API_KEY,
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
async function fetchOptionsChain(symbol) {
  const now = Date.now();
  if (cache[symbol] && now - cache[symbol].time < CACHE_TTL) return cache[symbol].data;

  const ok = await ensureSession();
  if (!ok) throw new Error('Authentication failed');

  const res = await axios.post(
    'https://apiconnect.angelbroking.com/rest/secure/angelbroking/marketData/v1/optionChain',
    { name: symbol, expirydate: '' },
    { headers: getHeaders() }
  );

  if (!res.data.status || !res.data.data) throw new Error(res.data.message || 'Failed to fetch');

  const raw        = res.data.data;
  const underlying = raw.underlyingValue || 0;
  const step       = getStrikeStep(symbol);
  const atmStrike  = Math.round(underlying / step) * step;

  const strikes = [];
  for (let i = -2; i <= 3; i++) {
    const strike = atmStrike + i * step;
    const callData = (raw.optionChainData || []).find(d => d.strikePrice === strike && d.optionType === 'CE');
    const putData  = (raw.optionChainData || []).find(d => d.strikePrice === strike && d.optionType === 'PE');
    strikes.push({
      strike, isATM: i === 0,
      callVol: callData?.tradeVolume  || 0,
      callOI:  callData?.openInterest || 0,
      callLTP: callData?.ltp          || 0,
      putVol:  putData?.tradeVolume   || 0,
      putOI:   putData?.openInterest  || 0,
      putLTP:  putData?.ltp           || 0,
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
