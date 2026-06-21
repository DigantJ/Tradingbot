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

// ── INSTRUMENT LIST ───────────────────────────────────────────
let instruments     = null;
let instrumentsTime = 0;

async function getInstruments() {
  const now = Date.now();
  if (instruments && now - instrumentsTime < 3600000) return instruments;
  try {
    console.log('Downloading instrument list...');
    const res = await axios.get(
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
      { timeout: 30000 }
    );
    instruments     = res.data;
    instrumentsTime = now;
    console.log(`Loaded ${instruments.length} instruments`);
    return instruments;
  } catch (err) {
    console.error('Instrument download error:', err.message);
    return [];
  }
}

// ── FIND NEAREST EXPIRY TOKEN ─────────────────────────────────
function findNearestToken(allInstruments, symbol, strike, optionType) {
  // Angel One stores strike * 100 as a float string e.g. "5770000.000000"
  const strikeVal = (strike * 100).toFixed(6);

  const matches = allInstruments.filter(i =>
    i.exch_seg       === 'NFO'     &&
    i.name           === symbol    &&
    i.instrumenttype === 'OPTIDX'  &&
    i.strike         === strikeVal &&
    i.symbol.endsWith(optionType)
  );

  if (matches.length === 0) {
    // Try with tolerance — sometimes float precision differs
    const strikeNum = strike * 100;
    const loose = allInstruments.filter(i =>
      i.exch_seg       === 'NFO'    &&
      i.name           === symbol   &&
      i.instrumenttype === 'OPTIDX' &&
      Math.abs(parseFloat(i.strike) - strikeNum) < 1 &&
      i.symbol.endsWith(optionType)
    );
    if (loose.length === 0) return null;
    // Sort by nearest expiry
    loose.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
    return loose[0];
  }

  // Sort by nearest expiry date
  matches.sort((a, b) => {
    const da = parseExpiry(a.expiry);
    const db = parseExpiry(b.expiry);
    return da - db;
  });

  return matches[0];
}

function parseExpiry(expStr) {
  // Format: 25JUN2026
  const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const day   = parseInt(expStr.slice(0, 2));
  const mon   = months[expStr.slice(2, 5)];
  const year  = parseInt(expStr.slice(5));
  return new Date(year, mon, day).getTime();
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

  const step       = getStrikeStep(symbol);
  const atmStrike  = Math.round(underlying / step) * step;
  const strikes    = [-2, -1, 0, 1, 2, 3].map(i => atmStrike + i * step);

  // Step 2 — Load instruments
  const allInstruments = await getInstruments();
  const tokenMap       = {}; // token -> { strike, type }
  const nfoTokens      = [];

  strikes.forEach(strike => {
    const ceInstr = findNearestToken(allInstruments, symbol, strike, 'CE');
    const peInstr = findNearestToken(allInstruments, symbol, strike, 'PE');

    if (ceInstr) {
      nfoTokens.push(ceInstr.token);
      tokenMap[ceInstr.token] = { strike, type: 'CE', expiry: ceInstr.expiry };
      console.log(`CE ${strike}: token=${ceInstr.token} expiry=${ceInstr.expiry}`);
    } else {
      console.warn(`No CE token found for ${symbol} ${strike}`);
    }

    if (peInstr) {
      nfoTokens.push(peInstr.token);
      tokenMap[peInstr.token] = { strike, type: 'PE', expiry: peInstr.expiry };
      console.log(`PE ${strike}: token=${peInstr.token} expiry=${peInstr.expiry}`);
    } else {
      console.warn(`No PE token found for ${symbol} ${strike}`);
    }
  });

  // Step 3 — Get live quotes
  const strikeData = {};
  strikes.forEach(s => {
    strikeData[s] = {
      strike: s, isATM: s === atmStrike,
      callVol: 0, callOI: 0, callLTP: 0,
      putVol:  0, putOI:  0, putLTP:  0,
    };
  });

  if (nfoTokens.length > 0) {
    try {
      console.log(`Fetching FULL quotes for ${nfoTokens.length} tokens...`);
      const quoteRes = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { NFO: nfoTokens } },
        { headers: getHeaders() }
      );

      const fetched = quoteRes.data?.data?.fetched || [];
      console.log(`Received ${fetched.length} quotes`);
      if (fetched.length > 0) console.log('Sample quote keys:', Object.keys(fetched[0]));

      fetched.forEach(q => {
        const info = tokenMap[q.symbolToken] || tokenMap[q.token];
        if (!info) return;
        const sd = strikeData[info.strike];
        if (!sd) return;

        // Angel One uses different field names — check all possibilities
        const vol = q.tradeVolume || q.tradedVolume || q.volume || q.totTrdVal || q.tottrdvol || 0;
        const oi  = q.openInterest || q.opnInterest || q.oi || 0;
        const ltp = q.ltp || q.lastPrice || q.close || 0;

        if (info.type === 'CE') {
          sd.callVol = vol;
          sd.callOI  = oi;
          sd.callLTP = ltp;
        } else {
          sd.putVol  = vol;
          sd.putOI   = oi;
          sd.putLTP  = ltp;
        }
      });
    } catch (err) {
      console.error('Quote error:', err.message, err.response?.data);
    }
  }

  const result = {
    symbol, underlying, atmStrike,
    strikes: strikes.map(s => strikeData[s]),
    demo: false, timestamp: now,
  };

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
  const list   = await getInstruments();
  const symbol = (req.query.symbol || 'BANKNIFTY').toUpperCase();
  const strike = req.query.strike ? parseInt(req.query.strike) : null;
  let filtered = list.filter(i => i.name === symbol && i.exch_seg === 'NFO');
  if (strike) {
    const strikeVal = strike * 100;
    filtered = filtered.filter(i => Math.abs(parseFloat(i.strike) - strikeVal) < 1);
  }
  res.json({ count: filtered.length, sample: filtered.slice(0, 20) });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`TradingBot Proxy running on port ${PORT}`);
  await login();
  await getInstruments();
});

setInterval(async () => {
  console.log('Refreshing session...');
  await login();
}, 55 * 60 * 1000);
