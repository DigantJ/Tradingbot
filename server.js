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

function parseExpiry(expStr) {
  const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const day   = parseInt(expStr.slice(0, 2));
  const mon   = months[expStr.slice(2, 5)];
  const year  = parseInt(expStr.slice(5));
  return new Date(year, mon, day).getTime();
}

// ── GET NEAREST EXPIRY FOR SYMBOL ─────────────────────────────
function getNearestExpiry(allInstruments, symbol) {
  const now = Date.now();
  const expiries = [...new Set(
    allInstruments
      .filter(i => i.exch_seg === 'NFO' && i.name === symbol && i.instrumenttype === 'OPTIDX')
      .map(i => i.expiry)
  )].filter(e => parseExpiry(e) >= now);
  expiries.sort((a, b) => parseExpiry(a) - parseExpiry(b));
  return expiries[0] || null;
}

// ── GET ALL STRIKES FOR EXPIRY ────────────────────────────────
// Returns full options chain for a given symbol and expiry
function getAllStrikeTokens(allInstruments, symbol, expiry) {
  const opts = allInstruments.filter(i =>
    i.exch_seg       === 'NFO'   &&
    i.name           === symbol  &&
    i.instrumenttype === 'OPTIDX' &&
    i.expiry         === expiry
  );

  const strikeMap = {};
  opts.forEach(i => {
    const strike = Math.round(parseFloat(i.strike) / 100);
    if (!strikeMap[strike]) strikeMap[strike] = { strike, ceToken: null, peToken: null };
    if (i.symbol.endsWith('CE')) strikeMap[strike].ceToken = i.token;
    if (i.symbol.endsWith('PE')) strikeMap[strike].peToken = i.token;
  });

  return Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
}

// ── MAX PAIN CALCULATION ──────────────────────────────────────
// Uses full chain OI — much more accurate than 6-strike version
function calcMaxPain(fullChain) {
  if (!fullChain || fullChain.length === 0) return 0;
  let minPain = Infinity;
  let maxPainStrike = 0;

  fullChain.forEach(candidate => {
    let totalPain = 0;
    fullChain.forEach(s => {
      totalPain += (s.callOI || 0) * Math.max(0, candidate.strike - s.strike);
      totalPain += (s.putOI  || 0) * Math.max(0, s.strike - candidate.strike);
    });
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidate.strike;
    }
  });

  return maxPainStrike;
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

  // Step 2 — Get nearest expiry + ALL strikes for that expiry
  const allInstruments = await getInstruments();
  const nearestExpiry  = getNearestExpiry(allInstruments, symbol);
  console.log(`${symbol} nearest expiry: ${nearestExpiry}`);

  const allStrikeTokens = getAllStrikeTokens(allInstruments, symbol, nearestExpiry);
  console.log(`${symbol} total strikes for max pain: ${allStrikeTokens.length}`);

  // Step 3 — Fetch OI for ALL strikes (for accurate max pain)
  // Also fetch full quotes for the 6 display strikes
  const displayStrikes = [-2, -1, 0, 1, 2, 3].map(i => atmStrike + i * step);
  const displayTokenMap = {};
  const displayNFOTokens = [];

  displayStrikes.forEach(strike => {
    const found = allStrikeTokens.find(s => s.strike === strike);
    if (found) {
      if (found.ceToken) { displayNFOTokens.push(found.ceToken); displayTokenMap[found.ceToken] = { strike, type: 'CE' }; }
      if (found.peToken) { displayNFOTokens.push(found.peToken); displayTokenMap[found.peToken] = { strike, type: 'PE' }; }
    }
  });

  // For max pain — get OI for ALL strikes (batch in groups of 50)
  const allTokens = [];
  const allTokenMap = {};
  allStrikeTokens.forEach(s => {
    if (s.ceToken) { allTokens.push(s.ceToken); allTokenMap[s.ceToken] = { strike: s.strike, type: 'CE' }; }
    if (s.peToken) { allTokens.push(s.peToken); allTokenMap[s.peToken] = { strike: s.strike, type: 'PE' }; }
  });

  // Batch fetch — Angel One allows max 50 tokens per request
  const fullChainOI = {};
  const batchSize = 50;
  for (let i = 0; i < allTokens.length; i += batchSize) {
    const batch = allTokens.slice(i, i + batchSize);
    try {
      const res = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'LTP', exchangeTokens: { NFO: batch } },
        { headers: getHeaders() }
      );
      const fetched = res.data?.data?.fetched || [];
      fetched.forEach(q => {
        const info = allTokenMap[q.symbolToken];
        if (!info) return;
        if (!fullChainOI[info.strike]) fullChainOI[info.strike] = { strike: info.strike, callOI: 0, putOI: 0 };
        const oi = q.openInterest || q.opnInterest || 0;
        if (info.type === 'CE') fullChainOI[info.strike].callOI = oi;
        else                    fullChainOI[info.strike].putOI  = oi;
      });
    } catch (err) {
      console.error(`Batch OI fetch error (batch ${i}):`, err.message);
    }
  }

  const fullChainArray = Object.values(fullChainOI);
  console.log(`Got OI for ${fullChainArray.length} strikes`);

  // Calculate Max Pain from full chain
  const maxPain = calcMaxPain(fullChainArray);
  console.log(`${symbol} Max Pain: ${maxPain}`);

  // Step 4 — Get FULL quotes for the 6 display strikes
  const strikeData = {};
  displayStrikes.forEach(s => {
    strikeData[s] = {
      strike: s, isATM: s === atmStrike,
      callVol: 0, callOI: 0, callLTP: 0,
      putVol:  0, putOI:  0, putLTP:  0,
    };
  });

  if (displayNFOTokens.length > 0) {
    try {
      const quoteRes = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { NFO: displayNFOTokens } },
        { headers: getHeaders() }
      );
      const fetched = quoteRes.data?.data?.fetched || [];
      fetched.forEach(q => {
        const info = displayTokenMap[q.symbolToken] || displayTokenMap[q.token];
        if (!info) return;
        const sd = strikeData[info.strike];
        if (!sd) return;
        const vol = q.tradeVolume || q.tradedVolume || q.volume || q.totTrdVal || q.tottrdvol || 0;
        const oi  = q.openInterest || q.opnInterest || q.oi || 0;
        const ltp = q.ltp || q.lastPrice || q.close || 0;
        if (info.type === 'CE') { sd.callVol = vol; sd.callOI = oi; sd.callLTP = ltp; }
        else                     { sd.putVol  = vol; sd.putOI  = oi; sd.putLTP  = ltp; }
      });
    } catch (err) {
      console.error('Display quote error:', err.message);
    }
  }

  const result = {
    symbol, underlying, atmStrike, maxPain,
    expiry: nearestExpiry,
    totalStrikesUsed: fullChainArray.length,
    strikes: displayStrikes.map(s => strikeData[s]),
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
  console.log(`TradingBot Proxy v2 running on port ${PORT}`);
  await login();
  await getInstruments();
});

setInterval(async () => {
  console.log('Refreshing session...');
  await login();
}, 55 * 60 * 1000);
