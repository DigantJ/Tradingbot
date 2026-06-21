const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const API_KEY     = process.env.ANGEL_API_KEY;
const CLIENT_ID   = process.env.ANGEL_CLIENT_ID;
const PASSWORD    = process.env.ANGEL_PASSWORD;
const TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

// ── TOTP ─────────────────────────────────────────────────────
function generateTOTP(secret) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
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

// ── DOWNLOAD INSTRUMENT LIST ──────────────────────────────────
// Angel One provides a full instrument dump — we use this to find
// the correct tokens for each option contract
let instruments = null;
let instrumentsTime = 0;

async function getInstruments() {
  const now = Date.now();
  if (instruments && now - instrumentsTime < 3600000) return instruments; // cache 1 hour

  try {
    console.log('Downloading instrument list from Angel One...');
    const res = await axios.get(
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
      { timeout: 30000 }
    );
    instruments = res.data;
    instrumentsTime = now;
    console.log(`Loaded ${instruments.length} instruments`);
    return instruments;
  } catch (err) {
    console.error('Instrument download error:', err.message);
    return [];
  }
}

// Find token for a specific option contract
function findToken(instruments, symbol, strike, optionType, expiry) {
  // Filter by symbol and option type
  const filtered = instruments.filter(i =>
    i.exch_seg === 'NFO' &&
    i.name === symbol &&
    i.instrumenttype === 'OPTIDX' &&
    i.symbol.includes(optionType) &&
    parseInt(i.strike) === strike * 100 // Angel One stores strike * 100
  );

  if (filtered.length === 0) return null;

  // Sort by expiry date — get nearest
  filtered.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
  return filtered[0];
}

// ── FETCH OPTIONS CHAIN ───────────────────────────────────────
async function fetchOptionsChain(symbol) {
  const now = Date.now();
  if (cache[symbol] && now - cache[symbol].time < CACHE_TTL) return cache[symbol].data;

  const ok = await ensureSession();
  if (!ok) throw new Error('Authentication failed');

  // Step 1 — Get underlying price
  const indexTokens = { 'BANKNIFTY': '26009', 'NIFTY': '26000', 'SENSEX': '1' };
  const indexToken  = indexTokens[symbol] || '26009';
  let underlying    = 0;

  try {
    const ltpRes = await axios.post(
      'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
      { mode: 'LTP', exchangeTokens: { NSE: [indexToken] } },
      { headers: getHeaders() }
    );
    underlying = ltpRes.data?.data?.fetched?.[0]?.ltp || 54000;
    console.log(`${symbol} underlying: ${underlying}`);
  } catch (err) {
    console.error('LTP error:', err.message);
    underlying = 54000;
  }

  const step      = getStrikeStep(symbol);
  const atmStrike = Math.round(underlying / step) * step;

  // Step 2 — Load instruments and find option tokens
  const allInstruments = await getInstruments();
  const strikesToFetch = [-2, -1, 0, 1, 2, 3].map(i => atmStrike + i * step);

  const tokenToStrike = {}; // token -> { strike, type }
  const nfoTokens     = [];

  strikesToFetch.forEach(strike => {
    const ceInstr = findToken(allInstruments, symbol, strike, 'CE', null);
    const peInstr = findToken(allInstruments, symbol, strike, 'PE', null);

    if (ceInstr) {
      nfoTokens.push(ceInstr.token);
      tokenToStrike[ceInstr.token] = { strike, type: 'CE' };
      console.log(`Found CE token for ${symbol} ${strike}: ${ceInstr.token} exp:${ceInstr.expiry}`);
    }
    if (peInstr) {
      nfoTokens.push(peInstr.token);
      tokenToStrike[peInstr.token] = { strike, type: 'PE' };
      console.log(`Found PE token for ${symbol} ${strike}: ${peInstr.token} exp:${peInstr.expiry}`);
    }
  });

  // Step 3 — Get quotes for all option tokens
  const strikeData = {};
  strikesToFetch.forEach(s => {
    strikeData[s] = { strike: s, isATM: s === atmStrike, callVol: 0, callOI: 0, callLTP: 0, putVol: 0, putOI: 0, putLTP: 0 };
  });

  if (nfoTokens.length > 0) {
    try {
      console.log(`Fetching quotes for ${nfoTokens.length} option tokens...`);
      const quoteRes = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { NFO: nfoTokens } },
        { headers: getHeaders() }
      );

      const fetched = quoteRes.data?.data?.fetched || [];
      console.log(`Got ${fetched.length} quotes back`);

      fetched.forEach(q => {
        const info = tokenToStrike[q.symbolToken];
        if (!info) return;
        const sd = strikeData[info.strike];
        if (!sd) return;

        if (info.type === 'CE') {
          sd.callLTP = q.ltp            || 0;
          sd.callVol = q.tradeVolume    || q.totTrdVal || q.volume || 0;
          sd.callOI  = q.openInterest   || q.opnInterest || 0;
        } else {
          sd.putLTP  = q.ltp            || 0;
          sd.putVol  = q.tradeVolume    || q.totTrdVal || q.volume || 0;
          sd.putOI   = q.openInterest   || q.opnInterest || 0;
        }
      });
    } catch (err) {
      console.error('Quote fetch error:', err.message);
    }
  } else {
    console.warn('No tokens found — check instrument list or symbol name');
  }

  const strikes = strikesToFetch.map(s => strikeData[s]);
  const result  = { symbol, underlying, atmStrike, strikes, demo: false, timestamp: now };
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

app.get('/instruments', async (req, res) => {
  const list = await getInstruments();
  const symbol = (req.query.symbol || 'BANKNIFTY').toUpperCase();
  const filtered = list.filter(i => i.name === symbol && i.exch_seg === 'NFO').slice(0, 20);
  res.json({ count: filtered.length, sample: filtered });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`TradingBot Proxy running on port ${PORT}`);
  await login();
  // Pre-load instruments on startup
  await getInstruments();
});

setInterval(async () => {
  console.log('Refreshing session...');
  await login();
}, 55 * 60 * 1000);
