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

// ── SYMBOL CONFIG ────────────────────────────────────────────
// Scope narrowed to NIFTY + SENSEX only (BankNifty dropped per client).
// BUG FIX (root cause of "CE/PE doesn't match Kite" for SENSEX): Sensex
// is a BSE instrument, not NSE. Its options trade on BFO (BSE F&O), not
// NFO. The old code hardcoded 'NFO' and 'NSE' for every symbol, so for
// SENSEX it was fetching the underlying price from the wrong exchange
// (with a placeholder token, '1') and searching for option contracts on
// the wrong segment entirely. That wrong underlying price throws off the
// ATM-strike calculation, which then centers the whole displayed chain
// on the wrong strikes — that mismatch is what looked like "CE/PE prices
// don't match Kite," even though each individual quote call was live.
const SYMBOL_CONFIG = {
  NIFTY:  { optionExch: 'NFO', indexExch: 'NSE', strikeStep: 50,  fallbackIndexToken: '26000' },
  SENSEX: { optionExch: 'BFO', indexExch: 'BSE', strikeStep: 100, fallbackIndexToken: null },
};
const ALLOWED_SYMBOLS = Object.keys(SYMBOL_CONFIG);

function getSymbolConfig(symbol) {
  return SYMBOL_CONFIG[symbol] || SYMBOL_CONFIG.NIFTY;
}

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

// BUG FIX: resolve the spot index token from the instrument master itself
// instead of trusting a hardcoded number. A wrong hardcoded token (like
// SENSEX's old '1') fails silently — it just returns whatever that token
// happens to be, with no error. Looking it up by exchange + name means a
// bad guess is no longer possible; the hardcoded values in SYMBOL_CONFIG
// are now only a last-resort fallback if the lookup can't find anything.
function getIndexToken(allInstruments, symbol, cfg) {
  const candidates = allInstruments.filter(i =>
    i.exch_seg === cfg.indexExch &&
    (i.symbol === symbol || i.name === symbol || i.symbol === symbol + '-EQ')
  );
  // Prefer an entry with no options-specific fields (the spot index line),
  // not a derivative contract that happens to share the name.
  const spot = candidates.find(i => !i.expiry && !i.strike) || candidates[0];
  if (spot) return spot.token;
  console.error(`Could not resolve index token for ${symbol} on ${cfg.indexExch} — falling back`);
  return cfg.fallbackIndexToken;
}

// ── GET NEAREST EXPIRY FOR SYMBOL ─────────────────────────────
function getNearestExpiry(allInstruments, symbol, cfg) {
  const now = Date.now();
  const expiries = [...new Set(
    allInstruments
      .filter(i => i.exch_seg === cfg.optionExch && i.name === symbol && i.instrumenttype === 'OPTIDX')
      .map(i => i.expiry)
  )].filter(e => parseExpiry(e) >= now);
  expiries.sort((a, b) => parseExpiry(a) - parseExpiry(b));
  return expiries[0] || null;
}

// ── GET ALL STRIKES FOR EXPIRY ────────────────────────────────
// Returns full options chain for a given symbol and expiry
function getAllStrikeTokens(allInstruments, symbol, expiry, cfg) {
  const opts = allInstruments.filter(i =>
    i.exch_seg       === cfg.optionExch &&
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

  const cfg  = getSymbolConfig(symbol);
  const allInstruments = await getInstruments();

  // Step 1 — Get underlying price (correct exchange + resolved token)
  const indexToken = getIndexToken(allInstruments, symbol, cfg);
  let underlying    = 0;
  let underlyingOk   = false;

  if (indexToken) {
    try {
      const ltpRes = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'LTP', exchangeTokens: { [cfg.indexExch]: [indexToken] } },
        { headers: getHeaders() }
      );
      const ltp = ltpRes.data?.data?.fetched?.[0]?.ltp;
      if (ltp && ltp > 0) { underlying = ltp; underlyingOk = true; }
      console.log(`${symbol} underlying (${cfg.indexExch}:${indexToken}): ${underlying}`);
    } catch (err) {
      console.error('LTP error:', err.message);
    }
  }
  // BUG FIX: no more silent hardcoded fallback (old code used 54000 for
  // every symbol, which isn't even close to NIFTY's or SENSEX's scale).
  // If the underlying can't be fetched, fail loudly instead of quietly
  // returning a chain built around a nonsense strike.
  if (!underlyingOk) throw new Error(`Could not fetch live underlying price for ${symbol}`);

  const step      = cfg.strikeStep;
  const atmStrike = Math.round(underlying / step) * step;

  // Step 2 — Get nearest expiry + ALL strikes for that expiry
  const nearestExpiry  = getNearestExpiry(allInstruments, symbol, cfg);
  console.log(`${symbol} nearest expiry: ${nearestExpiry}`);

  const allStrikeTokens = getAllStrikeTokens(allInstruments, symbol, nearestExpiry, cfg);
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

  // BUG FIX: Angel One's 'LTP' quote mode does NOT return openInterest —
  // only 'FULL' (or 'OHLC') does. The old code requested 'LTP' here and
  // then read q.openInterest anyway, so oi was always 0 and Max Pain was
  // being computed off an empty chain the whole time. Switched to 'FULL'.
  const fullChainOI = {};
  const batchSize = 50;
  for (let i = 0; i < allTokens.length; i += batchSize) {
    const batch = allTokens.slice(i, i + batchSize);
    try {
      const res = await axios.post(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { [cfg.optionExch]: batch } },
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
        { mode: 'FULL', exchangeTokens: { [cfg.optionExch]: displayNFOTokens } },
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
  let symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  if (!ALLOWED_SYMBOLS.includes(symbol)) symbol = 'NIFTY'; // scope: NIFTY + SENSEX only
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
  let symbol   = (req.query.symbol || 'NIFTY').toUpperCase();
  if (!ALLOWED_SYMBOLS.includes(symbol)) symbol = 'NIFTY';
  const cfg    = getSymbolConfig(symbol);
  const strike = req.query.strike ? parseInt(req.query.strike) : null;
  let filtered = list.filter(i => i.name === symbol && i.exch_seg === cfg.optionExch);
  if (strike) {
    const strikeVal = strike * 100;
    filtered = filtered.filter(i => Math.abs(parseFloat(i.strike) - strikeVal) < 1);
  }
  res.json({ count: filtered.length, sample: filtered.slice(0, 20) });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`TradingBot Proxy v3 running on port ${PORT}`);
  await login();
  await getInstruments();
});

setInterval(async () => {
  console.log('Refreshing session...');
  await login();
}, 55 * 60 * 1000);
