/**
 * PolyWatch — Polymarket Wallet Tracker
 * Features: MongoDB persistence, Smart Money Consensus, Entry Price Alerts, Sharp/Follower tagging
 */

require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');
const MIN_TRADE_SIZE_USD = parseFloat(process.env.MIN_TRADE_SIZE_USD || '50');
const MONGODB_URI = process.env.MONGODB_URI;

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

let state = { wallets: {}, lastSeen: {} };
let walletsCol;
let signalsCol;

let recentMarketTrades = {};
let patternData = {};
const pnlCache = {}; // address -> { data, expiry }
const PNL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Leaderboard + AI agent pipeline ──────────────────────────────────────────
let leaderboardWallets = {};   // address -> { rank, profit, label }
let pendingTrades = [];        // whale trades queued for AI analysis
let signalsCache = [];         // in-memory fallback for signals (last 100)
const WHALE_MIN_SIZE = parseFloat(process.env.WHALE_MIN_SIZE || '500');
const LEADERBOARD_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
const SCANNER_INTERVAL = 60 * 1000; // 1 minute

// ── Co-trader discovery ───────────────────────────────────────────────────────
let discoveredWallets = {};          // address -> { discoveredAt, discoveredVia, winRate, roi, tradeCount, label }
const discoveryCache = {};           // conditionId -> timestamp (24h cooldown per market)
let discoveredWalletsCol;            // MongoDB collection
const DISCOVERY_COOLDOWN = 24 * 60 * 60 * 1000;  // 24h per market
const MAX_DISCOVERED_WALLETS = 100;
const MIN_TRADES_FOR_QUALITY = 10;   // wallet must have at least 10 closed trades
const MIN_WIN_RATE_FOR_QUALITY = 52; // 52%+ win rate

// ── Daily Alpha Picks scanner ─────────────────────────────────────────────────
let dailyPicksCol;
let dailyScanResult = null;
let lastDailyScanTime = 0;
let scanInProgress = false;
const DAILY_SCAN_INTERVAL = 6 * 60 * 60 * 1000; // every 6 hours
const SCAN_MIN_COOLDOWN = 60 * 1000; // minimum 1 min between scans

async function connectDB() {
  if (!MONGODB_URI) { console.warn('⚠️  No MONGODB_URI set'); return; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('polywatch');
    walletsCol = db.collection('wallets');
    signalsCol = db.collection('signals');
    discoveredWalletsCol = db.collection('discovered_wallets');
    dailyPicksCol = db.collection('daily_picks');
    console.log('✅ MongoDB connected');
  } catch (e) { console.error('❌ MongoDB:', e.message); }
}

async function loadDiscoveredWallets() {
  if (!discoveredWalletsCol) return;
  const docs = await discoveredWalletsCol.find({}).toArray();
  docs.forEach(w => { discoveredWallets[w.address] = w; });
  console.log(`✅ Loaded ${docs.length} previously discovered wallet(s)`);
}

async function loadState() {
  if (!walletsCol) { console.log('✅ Loaded state: tracking 0 wallets'); return; }
  const wallets = await walletsCol.find({}).toArray();
  wallets.forEach(w => {
    state.wallets[w.address] = { label: w.label, addedAt: w.addedAt, alerts: w.alerts !== false, threshold: w.threshold, entryPriceAlert: w.entryPriceAlert || null };
    state.lastSeen[w.address] = w.lastSeen || null;
    patternData[w.address] = w.patternData || { earlyEntries: 0, totalTrades: 0, avgEntryPrice: 0 };
  });
  console.log(`✅ Loaded state: tracking ${wallets.length} wallets`);
}

async function saveWallet(address, data) {
  if (!walletsCol) return;
  await walletsCol.updateOne({ address }, { $set: { address, ...data, lastSeen: state.lastSeen[address] || null } }, { upsert: true });
}

async function deleteWallet(address) {
  if (!walletsCol) return;
  await walletsCol.deleteOne({ address });
}

async function updateLastSeen(address, lastSeen) {
  if (!walletsCol) return;
  await walletsCol.updateOne({ address }, { $set: { lastSeen } });
}

async function savePatternData(address) {
  if (!walletsCol) return;
  await walletsCol.updateOne({ address }, { $set: { patternData: patternData[address] } });
}

function recordMarketTrade(address, trade) {
  const marketId = trade.conditionId || trade.market_id || trade.market;
  if (!marketId) return;

  // Trigger co-trader discovery in background (non-blocking)
  setImmediate(() => discoverCoTraders(marketId, address));
  if (!recentMarketTrades[marketId]) recentMarketTrades[marketId] = [];
  const now = Date.now();
  recentMarketTrades[marketId] = recentMarketTrades[marketId].filter(t => now - t.time < 7200000);
  recentMarketTrades[marketId].push({
    wallet: state.wallets[address]?.label || address.slice(0,8),
    address, side: trade.side,
    outcome: trade.outcomeIndex === 0 ? 'YES' : 'NO',
    price: parseFloat(trade.price || 0),
    size: parseFloat(trade.size || trade.usdcSize || 0),
    time: now,
    market: trade.title || trade.market || marketId
  });
  const trades = recentMarketTrades[marketId];
  const uniqueWallets = new Set(trades.map(t => t.address));
  if (uniqueWallets.size >= 2) {
    const yesBuys = trades.filter(t => t.side === 'BUY' && t.outcome === 'YES');
    const noBuys = trades.filter(t => t.side === 'BUY' && t.outcome === 'NO');
    const uniqueYes = new Set(yesBuys.map(t => t.address));
    const uniqueNo = new Set(noBuys.map(t => t.address));
    if (uniqueYes.size >= 2) {
      const totalSize = yesBuys.reduce((s, t) => s + t.size, 0);
      const walletNames = [...new Set(yesBuys.map(t => t.wallet))].join(', ');
      sendSmartMoneyAlert(trades[0].market, 'YES', uniqueYes.size, totalSize, walletNames, yesBuys[yesBuys.length-1].price);
    } else if (uniqueNo.size >= 2) {
      const totalSize = noBuys.reduce((s, t) => s + t.size, 0);
      const walletNames = [...new Set(noBuys.map(t => t.wallet))].join(', ');
      sendSmartMoneyAlert(trades[0].market, 'NO', uniqueNo.size, totalSize, walletNames, noBuys[noBuys.length-1].price);
    }
  }
}

let sentConsensusAlerts = {};
function sendSmartMoneyAlert(market, outcome, count, totalSize, wallets, price) {
  const key = `${market}_${outcome}`;
  const now = Date.now();
  if (sentConsensusAlerts[key] && now - sentConsensusAlerts[key] < 7200000) return;
  sentConsensusAlerts[key] = now;
  const msg = `🐋 *Smart Money Consensus*\n\n` +
    `${count} wallets buying *${outcome}* on the same market!\n\n` +
    `📊 _${(market || 'Unknown').slice(0, 80)}_\n` +
    `💵 Total: *$${totalSize.toFixed(2)}*\n` +
    `📈 Latest price: *${Math.round(price * 100)}¢*\n` +
    `👛 Wallets: ${wallets}`;
  bot?.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  console.log(`🐋 Smart Money Alert: ${count} wallets on ${outcome}`);
}

function updatePattern(address, trade) {
  if (!patternData[address]) patternData[address] = { earlyEntries: 0, totalTrades: 0, avgEntryPrice: 0, tag: 'unknown' };
  const p = patternData[address];
  const price = parseFloat(trade.price || 0);
  if (!price) return;
  p.totalTrades++;
  p.avgEntryPrice = ((p.avgEntryPrice * (p.totalTrades - 1)) + price) / p.totalTrades;
  const isEarlyBuy = trade.side === 'BUY' && price < 0.35;
  const isEarlySell = trade.side === 'SELL' && price > 0.65;
  if (isEarlyBuy || isEarlySell) p.earlyEntries++;
  if (p.totalTrades >= 5) {
    const earlyRate = p.earlyEntries / p.totalTrades;
    p.tag = earlyRate >= 0.4 ? 'sharp' : earlyRate >= 0.2 ? 'mixed' : 'follower';
  }
  savePatternData(address);
}

function computeGrade(winRate, roi) {
  if (winRate > 65 && roi > 20) return 'S';
  if (winRate > 55 && roi > 10) return 'A';
  if (winRate > 45) return 'B';
  if (winRate > 35) return 'C';
  return 'D';
}

function checkEntryPriceAlert(address, trade) {
  const wallet = state.wallets[address];
  if (!wallet || trade.side !== 'BUY') return;
  const threshold = wallet.entryPriceAlert;
  if (!threshold) return;
  const price = parseFloat(trade.price || 0);
  if (price <= 0 || price > threshold) return;
  const priceCents = Math.round(price * 100);
  const thresholdCents = Math.round(threshold * 100);
  const size = parseFloat(trade.size || trade.usdcSize || 0);
  const outcome = trade.outcomeIndex === 0 ? 'YES' : 'NO';
  const market = trade.title || trade.market || 'Unknown Market';
  const msg = `🎯 *Low Entry Alert — ${wallet.label}*\n\n` +
    `Bought *${outcome}* at only *${priceCents}¢* (your alert: <${thresholdCents}¢)\n\n` +
    `📊 _${market.slice(0, 80)}_\n` +
    `💵 Size: *$${size.toFixed(2)}*\n` +
    `🚀 Potential upside: *${(100 - priceCents)}¢* per share`;
  bot?.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  console.log(`🎯 Entry price alert: ${wallet.label} bought at ${priceCents}¢`);
}

let bot;
function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.warn('⚠️  No TELEGRAM_TOKEN'); return; }
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('✅ Telegram bot connected');

  bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id,
    `🔮 *PolyWatch Bot*\n\n/track <address> [label]\n/untrack <address>\n/list\n/pnl <address>\n/positions <address>\n/entryprice <address> <cents>\n/pattern <address>`,
    { parse_mode: 'Markdown' }));

  bot.onText(/\/track (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(' ');
    const address = parts[0].toLowerCase();
    const label = parts.slice(1).join(' ') || `Wallet ${Object.keys(state.wallets).length + 1}`;
    if (!address.startsWith('0x') || address.length < 40) return bot.sendMessage(msg.chat.id, '❌ Invalid address');
    const data = { label, addedAt: Date.now(), alerts: true, threshold: MIN_TRADE_SIZE_USD };
    state.wallets[address] = data; state.lastSeen[address] = null;
    patternData[address] = { earlyEntries: 0, totalTrades: 0, avgEntryPrice: 0, tag: 'unknown' };
    await saveWallet(address, data);
    bot.sendMessage(msg.chat.id, `✅ Now tracking *${label}*`, { parse_mode: 'Markdown' });
    await sendPositions(msg.chat.id, address, label);
  });

  bot.onText(/\/untrack (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    if (!state.wallets[address]) return bot.sendMessage(msg.chat.id, '❌ Not found');
    const label = state.wallets[address].label;
    delete state.wallets[address]; delete state.lastSeen[address]; delete patternData[address];
    await deleteWallet(address);
    bot.sendMessage(msg.chat.id, `🔕 Stopped: *${label}*`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/list/, msg => {
    const w = Object.entries(state.wallets);
    if (!w.length) return bot.sendMessage(msg.chat.id, '📋 No wallets tracked');
    const list = w.map(([a, v], i) => {
      const p = patternData[a];
      const tag = p?.tag === 'sharp' ? '🧠 Sharp' : p?.tag === 'follower' ? '📈 Follower' : '❓ Unknown';
      return `${i+1}. *${v.label}* ${tag}\n\`${a.slice(0,8)}...\``;
    }).join('\n\n');
    bot.sendMessage(msg.chat.id, `👛 *Wallets (${w.length})*\n\n${list}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/entryprice (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(' ');
    const address = parts[0].toLowerCase();
    const cents = parseInt(parts[1]);
    if (!state.wallets[address]) return bot.sendMessage(msg.chat.id, '❌ Wallet not found');
    if (!cents || cents < 1 || cents > 99) return bot.sendMessage(msg.chat.id, '❌ Enter cents between 1-99');
    state.wallets[address].entryPriceAlert = cents / 100;
    await saveWallet(address, state.wallets[address]);
    bot.sendMessage(msg.chat.id, `🎯 Alert set! Will notify when *${state.wallets[address].label}* buys below *${cents}¢*`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pattern (.+)/, (msg, match) => {
    const address = match[1].trim().toLowerCase();
    if (!state.wallets[address]) return bot.sendMessage(msg.chat.id, '❌ Wallet not found');
    const p = patternData[address] || {};
    const tag = p.tag === 'sharp' ? '🧠 Sharp Trader' : p.tag === 'follower' ? '📈 Momentum Follower' : '❓ Not enough data';
    const avgCents = Math.round((p.avgEntryPrice || 0) * 100);
    bot.sendMessage(msg.chat.id,
      `📊 *${state.wallets[address].label} — Pattern*\n\nTag: *${tag}*\nTrades analyzed: *${p.totalTrades || 0}*\nEarly entries: *${p.earlyEntries || 0}*\nAvg entry price: *${avgCents}¢*`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pnl (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    await sendPnL(msg.chat.id, address, state.wallets[address]?.label || address.slice(0,8));
  });

  bot.onText(/\/positions (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    await sendPositions(msg.chat.id, address, state.wallets[address]?.label || address.slice(0,8));
  });

  bot.onText(/\/alerts (on|off)/, async (msg, match) => {
    const on = match[1] === 'on';
    for (const a of Object.keys(state.wallets)) { state.wallets[a].alerts = on; await saveWallet(a, state.wallets[a]); }
    bot.sendMessage(msg.chat.id, `🔔 Alerts ${on ? 'on' : 'off'}`);
  });

  bot.onText(/\/threshold (\d+)/, (msg, match) => {
    process.env.MIN_TRADE_SIZE_USD = match[1];
    bot.sendMessage(msg.chat.id, `✅ Threshold $${match[1]}`);
  });
}

async function fetchActivity(address, limit = 20) {
  try { const r = await axios.get(`${DATA_API}/activity`, { params: { user: address, limit, type: 'trade' }, timeout: 10000 }); return r.data || []; }
  catch (e) { return []; }
}

async function fetchPositions(address) {
  try { const r = await axios.get(`${DATA_API}/positions`, { params: { user: address, limit: 50, sizeThreshold: 0.01 }, timeout: 10000 }); return r.data || []; }
  catch (e) { return []; }
}

async function fetchClosedPositions(address) {
  const all = [];
  const limit = 50;
  const maxPages = 20; // cap at 1000 positions
  for (let page = 0; page < maxPages; page++) {
    try {
      const r = await axios.get(`${DATA_API}/closed-positions`, {
        params: { user: address, limit, offset: page * limit, sortBy: 'TIMESTAMP', sortDirection: 'DESC' },
        timeout: 10000
      });
      const data = r.data || [];
      all.push(...data);
      if (data.length < limit) break; // no more pages
    } catch (e) { break; }
  }
  return all;
}

function computeStats(positions) {
  let totalPnl = 0, totalCost = 0, wins = 0, losses = 0;
  let winAmounts = [], lossAmounts = [], bestTrade = 0, worstTrade = 0;
  positions.forEach(p => {
    const pnl = parseFloat(p.realizedPnl || 0);
    const bought = parseFloat(p.totalBought || 0);
    totalPnl += pnl; totalCost += bought;
    if (pnl > 0.01) { wins++; winAmounts.push(pnl); if (pnl > bestTrade) bestTrade = pnl; }
    else if (pnl < -0.01) { losses++; lossAmounts.push(pnl); if (pnl < worstTrade) worstTrade = pnl; }
  });
  const tradeCount = wins + losses;
  const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
  const avgWin = wins > 0 ? winAmounts.reduce((a,b)=>a+b,0) / wins : 0;
  const avgLoss = losses > 0 ? lossAmounts.reduce((a,b)=>a+b,0) / losses : 0;
  const roi = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  return { profit: totalPnl, volume: totalCost, totalProfit: totalPnl, roi, winRate, tradeCount, wins, losses, avgWin, avgLoss, bestTrade, worstTrade };
}

async function fetchPnL(address) {
  // Return cached result if still fresh
  const cached = pnlCache[address];
  if (cached && Date.now() < cached.expiry) return cached.data;

  try {
    const [closedPositions, openPositions] = await Promise.all([
      fetchClosedPositions(address),
      fetchPositions(address)
    ]);

    // Portfolio value from open positions
    let portfolioValue = 0;
    openPositions.forEach(p => { portfolioValue += parseFloat(p.currentValue || p.value || 0); });

    if (!closedPositions.length) {
      const empty = { profit:0, volume:0, totalProfit:0, roi:0, winRate:0, tradeCount:0, wins:0, losses:0, avgWin:0, avgLoss:0, bestTrade:0, worstTrade:0 };
      return { ...empty, portfolioValue, periods: { alltime: { ...empty, portfolioValue }, monthly: { ...empty, portfolioValue }, weekly: { ...empty, portfolioValue }, daily: { ...empty, portfolioValue } } };
    }

    // Compute stats for each time window from the same fetched positions — no extra API calls
    const now = Math.floor(Date.now() / 1000); // Polymarket timestamps are Unix seconds
    const alltime = computeStats(closedPositions);
    const monthly = computeStats(closedPositions.filter(p => p.timestamp >= now - 2592000));
    const weekly  = computeStats(closedPositions.filter(p => p.timestamp >= now - 604800));
    const daily   = computeStats(closedPositions.filter(p => p.timestamp >= now - 86400));

    const result = {
      ...alltime,
      portfolioValue,
      periods: {
        alltime:  { ...alltime,  portfolioValue },
        monthly:  { ...monthly,  portfolioValue },
        weekly:   { ...weekly,   portfolioValue },
        daily:    { ...daily,    portfolioValue }
      }
    };
    pnlCache[address] = { data: result, expiry: Date.now() + PNL_CACHE_TTL };
    return result;
  }
  catch (e) {
    console.log('⚠️  Failed to calculate PnL:', e.message);
    return null;
  }
}

async function fetchMarketQuestion(conditionId) {
  try { const r = await axios.get(`${GAMMA_API}/markets`, { params: { condition_ids: conditionId }, timeout: 8000 }); return r.data?.[0]?.question || 'Unknown Market'; }
  catch { return 'Unknown Market'; }
}

async function sendPositions(chatId, address, label) {
  const pos = await fetchPositions(address);
  if (!pos.length) return bot?.sendMessage(chatId, `📋 *${label}* has no open positions`, { parse_mode: 'Markdown' });
  const lines = pos.slice(0,10).map(p => `• *${p.outcome||(p.outcomeIndex===0?'YES':'NO')}* on _${(p.title||p.market||'Market').slice(0,50)}_\n  $${parseFloat(p.currentValue||p.value||0).toFixed(2)}`).join('\n\n');
  bot?.sendMessage(chatId, `📋 *${label} — Positions (${pos.length})*\n\n${lines}`, { parse_mode: 'Markdown' });
}

async function sendPnL(chatId, address, label) {
  const pnl = await fetchPnL(address);
  if (!pnl) return bot?.sendMessage(chatId, `❌ Could not fetch PnL`);
  const profit = parseFloat(pnl.profit||pnl.totalProfit||0);
  bot?.sendMessage(chatId, `📊 *${label}*\n\n${profit>=0?'🟢':'🔴'} P&L: *${profit>=0?'+':''}$${profit.toFixed(2)}*\n💰 Volume: $${parseFloat(pnl.volume||0).toFixed(2)}`, { parse_mode: 'Markdown' });
}

async function pollWallet(address, wallet) {
  const trades = await fetchActivity(address, 10);
  if (!trades.length) return;
  const lastId = state.lastSeen[address];
  const newTrades = lastId ? trades.filter(t => t.id > lastId) : [];
  if (trades[0]?.id) { state.lastSeen[address] = trades[0].id; await updateLastSeen(address, trades[0].id); }
  for (const trade of newTrades) {
    const size = parseFloat(trade.size||trade.usdcSize||0);
    updatePattern(address, trade);
    recordMarketTrade(address, trade);
    checkEntryPriceAlert(address, trade);
    if (size < MIN_TRADE_SIZE_USD || !wallet.alerts || !bot) continue;
    const q = await fetchMarketQuestion(trade.conditionId||trade.market);
    const side = trade.side==='BUY'?'🟢 BUY':'🔴 SELL';
    const out = trade.outcomeIndex===0?'YES':'NO';
    const p = patternData[address];
    const tag = p?.tag === 'sharp' ? ' 🧠' : p?.tag === 'follower' ? ' 📈' : '';
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID,
        `⚡ *New Trade — ${wallet.label}${tag}*\n\n${side} *${out}*\n📊 _${q}_\n\n💵 $${size.toFixed(2)} at ${Math.round(parseFloat(trade.price||0)*100)}¢`,
        { parse_mode: 'Markdown' });
      await delay(300);
    } catch(e) {}
  }
  if (newTrades.length) console.log(`📡 ${wallet.label}: ${newTrades.length} new trade(s)`);
}

async function pollAll() {
  const wallets = Object.entries(state.wallets);
  if (!wallets.length) return;
  console.log(`🔄 Polling ${wallets.length} wallet(s)...`);
  for (const [address, wallet] of wallets) { await pollWallet(address, wallet); await delay(500); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function readBody(req) {
  return new Promise((resolve, reject) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>resolve(b)); req.on('error',reject); });
}

function startApiServer() {
  const PORT = process.env.PORT || 3001;
  http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    try {
      if (path==='/wallets' && req.method==='GET') return res.end(JSON.stringify(
        Object.entries(state.wallets).map(([a,w])=>({
          address:a, ...w,
          pattern: patternData[a] || { tag:'unknown', totalTrades:0, earlyEntries:0, avgEntryPrice:0 }
        }))
      ));
      if (path==='/wallets' && req.method==='POST') {
        const { address, label, threshold } = JSON.parse(await readBody(req));
        if (!address?.startsWith('0x')) { res.statusCode=400; return res.end(JSON.stringify({error:'Invalid address'})); }
        const addr = address.toLowerCase();
        if (state.wallets[addr]) { res.statusCode=409; return res.end(JSON.stringify({error:'Already tracking'})); }
        const walletLabel = label || `Wallet ${Object.keys(state.wallets).length+1}`;
        const data = { label:walletLabel, addedAt:Date.now(), alerts:true, threshold:parseFloat(threshold)||MIN_TRADE_SIZE_USD };
        try { await saveWallet(addr, data); } catch(e) { res.statusCode=500; return res.end(JSON.stringify({error:'DB unavailable — wallet not saved, try again'})); }
        state.wallets[addr]=data; state.lastSeen[addr]=null;
        patternData[addr] = { earlyEntries:0, totalTrades:0, avgEntryPrice:0, tag:'unknown' };
        console.log(`➕ Tracking: ${walletLabel}`);
        bot?.sendMessage(TELEGRAM_CHAT_ID, `✅ *Now tracking: ${walletLabel}*\n\`${addr}\``, { parse_mode:'Markdown' }).catch(()=>{});
        return res.end(JSON.stringify({success:true,address:addr,label:walletLabel}));
      }
      if (path==='/wallets' && req.method==='DELETE') {
        const addr = url.searchParams.get('address')?.toLowerCase();
        if (!addr||!state.wallets[addr]) { res.statusCode=404; return res.end(JSON.stringify({error:'Not found'})); }
        const label = state.wallets[addr].label;
        delete state.wallets[addr]; delete state.lastSeen[addr]; delete patternData[addr];
        await deleteWallet(addr);
        bot?.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Stopped: ${label}*`, { parse_mode:'Markdown' }).catch(()=>{});
        return res.end(JSON.stringify({success:true}));
      }
      if (path==='/wallets/entryprice' && req.method==='POST') {
        const { address, cents } = JSON.parse(await readBody(req));
        const addr = address?.toLowerCase();
        if (!addr || !state.wallets[addr]) { res.statusCode=404; return res.end(JSON.stringify({error:'Not found'})); }
        state.wallets[addr].entryPriceAlert = cents / 100;
        await saveWallet(addr, state.wallets[addr]);
        return res.end(JSON.stringify({success:true}));
      }
      if (path==='/consensus') return res.end(JSON.stringify(recentMarketTrades));
      if (path==='/activity') { const a=url.searchParams.get('address'); return res.end(JSON.stringify(a?await fetchActivity(a,20):[])); }
      if (path==='/positions') { const a=url.searchParams.get('address'); return res.end(JSON.stringify(a?await fetchPositions(a):[])); }
      if (path==='/pnl') {
        const a=url.searchParams.get('address');
        const pnlData = a ? await fetchPnL(a) : null;
        console.log(`🔗 /pnl endpoint called for ${a}, response:`, pnlData);
        return res.end(JSON.stringify(pnlData||{}));
      }
      if (path==='/health') return res.end(JSON.stringify({status:'ok',tracked:Object.keys(state.wallets).length,discovered:Object.keys(discoveredWallets).length,scanPool:Object.keys(state.wallets).length+Object.keys(discoveredWallets).length,pendingTrades:pendingTrades.filter(t=>!t.analyzed).length,uptime:process.uptime()}));

      // ── AI agent pipeline endpoints ─────────────────────────────────────────
      if (path==='/leaderboard' && req.method==='GET') {
        await syncLeaderboard(); // always fresh
        return res.end(JSON.stringify(
          Object.entries(leaderboardWallets)
            .map(([addr, data]) => ({ address: addr, ...data }))
            .sort((a, b) => a.rank - b.rank)
        ));
      }

      // /pending-trades returns both buffered whale trades AND recent consensus trades
      // so the AI agents have real data even before manual wallets trigger events
      if (path==='/pending-trades' && req.method==='GET') {
        const unanalyzed = pendingTrades.filter(t => !t.analyzed);
        // Also include recentMarketTrades flattened — the existing consensus data
        const recentFlat = Object.entries(recentMarketTrades).flatMap(([marketId, trades]) =>
          trades.map(t => ({ ...t, conditionId: marketId, id: `rmt_${marketId}_${t.address}_${t.time}`, analyzed: false, source: 'consensus' }))
        );
        const combined = [...unanalyzed, ...recentFlat];
        return res.end(JSON.stringify(combined));
      }

      if (path==='/signals' && req.method==='POST') {
        const signal = JSON.parse(await readBody(req));
        signal.createdAt = Date.now();
        // Always store in memory first (survives MongoDB failures)
        signalsCache.unshift(signal);
        if (signalsCache.length > 100) signalsCache = signalsCache.slice(0, 100);
        // Persist to MongoDB
        if (signalsCol) {
          try { await signalsCol.insertOne({ ...signal }); }
          catch(e) { console.warn('⚠️  Signal MongoDB save failed:', e.message); }
        }
        // Mark associated trades as analyzed + capture wallet addresses
        if (Array.isArray(signal.tradeIds)) {
          const walletSet = new Set();
          signal.tradeIds.forEach(id => {
            const t = pendingTrades.find(t => t.id === id);
            if (t) { t.analyzed = true; if (t.address) walletSet.add(t.address); }
          });
          if (walletSet.size) signal.wallets = [...walletSet];
        }
        // Telegram alert for high-confidence signals
        if (bot && TELEGRAM_CHAT_ID && (signal.confidence || 0) >= 70) {
          const strategyEmoji = { whale: '🐋', arbitrage: '⚡', near_certainty: '🎯' }[signal.strategy] || '📡';
          const dirEmoji = signal.direction === 'YES' ? '🟢' : signal.direction === 'NO' ? '🔴' : '🔵';
          const bar = '█'.repeat(Math.round((signal.confidence||0) / 10)) + '░'.repeat(10 - Math.round((signal.confidence||0) / 10));
          const stratLabel = { whale: 'WHALE CONVERGENCE', arbitrage: 'ARBITRAGE', near_certainty: 'CONTRARIAN FADE' }[signal.strategy] || signal.strategy.toUpperCase();
          // Build Polymarket URL
          const slug = signal.slug || '';
          const url = slug
            ? `https://polymarket.com/event/${slug}`
            : `https://polymarket.com/search?q=${encodeURIComponent((signal.market||'').slice(0,50))}`;
          const msg =
            `${strategyEmoji} *${stratLabel}*\n\n` +
            `📊 _${(signal.market||'').slice(0,90)}_\n\n` +
            `${dirEmoji} Trade: *${signal.direction}*\n` +
            `Confidence: *${signal.confidence}%*  ${bar}\n\n` +
            `💡 ${(signal.reasoning||'').slice(0,220)}\n\n` +
            `[👉 Trade on Polymarket](${url})`;
          bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: false }).catch(() => {});
        }
        return res.end(JSON.stringify({ success: true }));
      }

      if (path==='/discovered-wallets' && req.method==='GET') {
        return res.end(JSON.stringify(
          Object.values(discoveredWallets).sort((a, b) => b.winRate - a.winRate)
        ));
      }

      if (path==='/signals' && req.method==='GET') {
        const limit = parseInt(url.searchParams.get('limit') || '20');
        let signals = [];
        if (signalsCol) {
          try {
            const docs = await signalsCol.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
            signals = docs.map(d => { const { _id, ...rest } = d; return rest; });
          } catch(e) { console.warn('⚠️  Signal MongoDB read failed:', e.message); }
        }
        // Fall back to in-memory cache if MongoDB returned nothing
        if (!signals.length) signals = signalsCache.slice(0, limit);
        return res.end(JSON.stringify(signals));
      }

      if (path === '/signal-positions' && req.method === 'GET') {
        const conditionId = url.searchParams.get('conditionId')?.toLowerCase();
        const walletParam = url.searchParams.get('wallets') || '';
        const wallets = walletParam.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        if (!conditionId || !wallets.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'conditionId and wallets required' })); }
        try {
          const results = await Promise.all(wallets.map(async addr => {
            const label = (state.wallets[addr] || leaderboardWallets[addr] || {}).label || addr.slice(0,8);
            const [positions, activity] = await Promise.all([
              fetchPositions(addr),
              fetchActivity(addr, 30)
            ]);
            // Check open positions for this market
            const openPos = positions.find(p => (p.conditionId || p.market || p.condition_id || '').toLowerCase() === conditionId);
            // Check recent sells in this market
            const sells = activity.filter(t =>
              t.side === 'SELL' &&
              (t.conditionId || t.market || t.condition_id || '').toLowerCase() === conditionId
            );
            if (openPos && parseFloat(openPos.size || openPos.currentValue || 0) > 0.01) {
              return { address: addr, label, status: 'holding', size: parseFloat(openPos.size || openPos.currentValue || 0) };
            } else if (sells.length) {
              const avgExit = sells.reduce((s, t) => s + parseFloat(t.price || 0), 0) / sells.length;
              return { address: addr, label, status: 'exited', exitPrice: parseFloat((avgExit * 100).toFixed(1)) };
            } else {
              return { address: addr, label, status: 'unknown' };
            }
          }));
          return res.end(JSON.stringify(results));
        } catch(e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
      }

      if (path === '/wallet-profile' && req.method === 'GET') {
        const addr = url.searchParams.get('address')?.toLowerCase();
        if (!addr) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'address required' })); }
        try {
          const [closedPositions, activity] = await Promise.all([
            fetchClosedPositions(addr),
            fetchActivity(addr, 50)
          ]);
          const conditionIds = [...new Set(closedPositions.map(p => (p.conditionId || p.market || '').toLowerCase()).filter(Boolean))];
          const { questions: marketTitles, tags: marketTags } = await fetchMarketQuestions(conditionIds);
          const breakdown = closedPositions.slice(0, 30).map(p => ({
            conditionId: (p.conditionId || p.market || '').toLowerCase(),
            question: p.question || p.title || marketTitles[(p.conditionId || p.market || '').toLowerCase()] || 'Unknown market',
            side: parseInt(p.outcomeIndex) === 0 ? 'YES' : 'NO',
            invested: parseFloat((parseFloat(p.totalBought) || 0).toFixed(2)),
            pnl: parseFloat((parseFloat(p.realizedPnl) || 0).toFixed(2)),
            roi: parseFloat(p.totalBought) > 0 ? parseFloat(((parseFloat(p.realizedPnl) / parseFloat(p.totalBought)) * 100).toFixed(1)) : 0,
            won: parseFloat(p.realizedPnl || 0) > 0.01,
            resolvedAt: p.timestamp
          }));
          const buys = activity.filter(t => t.side === 'BUY');
          const labels = computeLabels(buys, closedPositions);
          const topCategories = computeTopCategories(breakdown, marketTags);
          return res.end(JSON.stringify({ labels, breakdown, topCategories }));
        } catch(e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
      }

      if (path === '/daily-picks' && req.method === 'GET') {
        // Return cached result if fresh (< 6h)
        if (dailyScanResult && Date.now() - lastDailyScanTime < DAILY_SCAN_INTERVAL) {
          return res.end(JSON.stringify(dailyScanResult));
        }
        // Load latest from MongoDB if available
        if (dailyPicksCol) {
          try {
            const latest = await dailyPicksCol.find({}).sort({ scannedAt: -1 }).limit(1).toArray();
            if (latest.length && Date.now() - latest[0].scannedAt < DAILY_SCAN_INTERVAL) {
              dailyScanResult = latest[0];
              lastDailyScanTime = latest[0].scannedAt;
              const { _id, ...rest } = dailyScanResult;
              return res.end(JSON.stringify(rest));
            }
          } catch (e) { console.warn('⚠️  Daily picks DB read failed:', e.message); }
        }
        // Trigger fresh scan (non-blocking, return current state)
        runDailyScan().catch(e => console.warn('Scan error:', e.message));
        return res.end(JSON.stringify({ scannedAt: null, scanned: 0, passed: 0, picks: [], scanning: true }));
      }

      if (path === '/daily-picks' && req.method === 'POST') {
        if (scanInProgress) return res.end(JSON.stringify({ success: false, message: 'Scan already in progress' }));
        runDailyScan().catch(e => console.warn('Scan error:', e.message));
        return res.end(JSON.stringify({ success: true, message: 'Scan started' }));
      }

      res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
    } catch(e) { res.statusCode=500; res.end(JSON.stringify({error:e.message})); }
  }).listen(PORT, ()=>console.log(`✅ API server running on http://localhost:${PORT}`));
}

// ── Co-trader discovery ───────────────────────────────────────────────────────
async function discoverCoTraders(conditionId, sourceAddress) {
  if (!conditionId) return;

  // 24h cooldown per market
  const lastScanned = discoveryCache[conditionId];
  if (lastScanned && Date.now() - lastScanned < DISCOVERY_COOLDOWN) return;
  discoveryCache[conditionId] = Date.now();

  if (Object.keys(discoveredWallets).length >= MAX_DISCOVERED_WALLETS) return;

  try {
    const r = await axios.get(`${DATA_API}/trades`, {
      params: { market: conditionId, limit: 300 },
      timeout: 12000
    });
    const trades = r.data || [];
    if (!trades.length) return;

    const candidates = [...new Set(
      trades
        .map(t => (t.proxyWallet || '').toLowerCase())
        .filter(addr =>
          addr && addr.startsWith('0x') &&
          addr !== sourceAddress &&
          !state.wallets[addr] &&
          !discoveredWallets[addr]
        )
    )].slice(0, 15);

    if (!candidates.length) return;
    console.log(`🔍 Discovery: checking ${candidates.length} co-traders on ${conditionId.slice(0, 10)}...`);

    let added = 0;
    for (const addr of candidates) {
      if (Object.keys(discoveredWallets).length >= MAX_DISCOVERED_WALLETS) break;

      const pnl = await fetchPnL(addr);
      await delay(300);

      if (!pnl || pnl.tradeCount < MIN_TRADES_FOR_QUALITY) continue;
      if (pnl.winRate < MIN_WIN_RATE_FOR_QUALITY) continue;

      const entry = {
        address: addr,
        discoveredAt: Date.now(),
        discoveredVia: conditionId,
        winRate: parseFloat(pnl.winRate.toFixed(1)),
        roi: parseFloat(pnl.roi.toFixed(1)),
        tradeCount: pnl.tradeCount,
        label: `Disc #${Object.keys(discoveredWallets).length + 1}`
      };
      discoveredWallets[addr] = entry;
      if (discoveredWalletsCol) await discoveredWalletsCol.updateOne(
        { address: addr }, { $set: entry }, { upsert: true }
      );
      leaderboardWallets[addr] = { rank: Object.keys(leaderboardWallets).length + 1, profit: pnl.roi, label: entry.label };
      added++;
      console.log(`✅ Discovered: ${addr.slice(0, 10)}... winRate:${pnl.winRate.toFixed(1)}% ROI:${pnl.roi.toFixed(1)}% trades:${pnl.tradeCount}`);
    }
    if (added > 0) console.log(`🌐 +${added} wallet(s) added to pool (${Object.keys(discoveredWallets).length}/${MAX_DISCOVERED_WALLETS})`);
  } catch (e) {
    console.warn('⚠️  Co-trader discovery error:', e.message);
  }
}

// ── Leaderboard: tracked + discovered wallets ─────────────────────────────────
async function syncLeaderboard() {
  leaderboardWallets = {};
  // Seed from manually tracked wallets
  Object.entries(state.wallets).forEach(([addr, w], i) => {
    leaderboardWallets[addr] = { rank: i + 1, profit: 0, label: w.label };
  });
  // Include previously discovered wallets
  Object.entries(discoveredWallets).forEach(([addr, w]) => {
    if (!leaderboardWallets[addr]) {
      leaderboardWallets[addr] = { rank: Object.keys(leaderboardWallets).length + 1, profit: w.roi || 0, label: w.label };
    }
  });
  // Include top wallets from the latest daily scan (top 500 leaderboard picks)
  if (dailyScanResult?.picks) {
    dailyScanResult.picks.forEach(w => {
      if (!leaderboardWallets[w.address]) {
        leaderboardWallets[w.address] = { rank: Object.keys(leaderboardWallets).length + 1, profit: w.roi || 0, label: w.label, fromDailyScan: true };
      }
    });
  }
  const picksCount = (dailyScanResult?.picks || []).filter(w => !state.wallets[w.address] && !discoveredWallets[w.address]).length;
  console.log(`📊 Scanner pool: ${Object.keys(leaderboardWallets).length} wallets (${Object.keys(state.wallets).length} tracked + ${Object.keys(discoveredWallets).length} discovered + ${picksCount} daily picks)`);
}

// ── Wallet profiling helpers ──────────────────────────────────────────────────
async function fetchMarketQuestions(conditionIds) {
  if (!conditionIds.length) return { questions: {}, tags: {} };
  const normalised = conditionIds.map(id => id.toLowerCase());
  try {
    const r = await axios.get(`${GAMMA_API}/markets`, {
      params: { condition_ids: normalised.slice(0, 50).join(',') },
      timeout: 10000
    });
    const questions = {}, tags = {};
    (r.data || []).forEach(m => {
      const key = (m.conditionId || m.condition_id || '').toLowerCase();
      if (!key) return;
      questions[key] = m.question;
      const rawTags = m.tags && m.tags.length ? m.tags : (m.category ? [m.category] : []);
      tags[key] = rawTags.map(t => {
        const s = (typeof t === 'string' ? t : t.label || t.name || '').trim();
        return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }).filter(Boolean);
    });
    return { questions, tags };
  } catch(e) { return { questions: {}, tags: {} }; }
}

function computeTopCategories(breakdown, marketTags) {
  const stats = {}; // normalizedName -> { display, wins, total }
  breakdown.forEach(p => {
    const key = (p.conditionId || '').toLowerCase();
    const tagList = marketTags[key] || [];
    tagList.forEach(rawTag => {
      const norm = rawTag.toLowerCase();
      if (!stats[norm]) stats[norm] = { display: rawTag, wins: 0, total: 0 };
      stats[norm].total++;
      if (p.won) stats[norm].wins++;
    });
  });
  return Object.values(stats)
    .filter(s => s.total >= 2)
    .map(s => ({ name: s.display, wins: s.wins, total: s.total, winRate: Math.round((s.wins / s.total) * 100) }))
    .sort((a, b) => b.winRate - a.winRate || b.total - a.total)
    .slice(0, 3);
}

function computeLabels(buys, closedPositions) {
  const labels = [];
  if (buys.length < 5) return labels;

  // YES vs NO bias
  const noBuys = buys.filter(t => parseInt(t.outcomeIndex) === 1).length;
  const noRatio = noBuys / buys.length;
  if (noRatio >= 0.60) labels.push('NO Fader');
  else if (noRatio <= 0.35) labels.push('YES Buyer');

  // Avg entry price
  const prices = buys.map(t => parseFloat(t.price || 0)).filter(p => p > 0 && p < 1);
  if (prices.length >= 5) {
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    if (avg >= 0.68) labels.push('Late Entry');
    else if (avg <= 0.38) labels.push('Early Bird');
  }

  // Contrarian: bets NO against heavy favorites (NO price < 30¢ = YES > 70¢)
  if (buys.length >= 10) {
    const contr = buys.filter(t => parseInt(t.outcomeIndex) === 1 && parseFloat(t.price || 0) < 0.30);
    if (contr.length / buys.length >= 0.35) labels.push('Contrarian');
  }

  // Volume / selectivity
  const total = closedPositions.length;
  if (total >= 150) {
    labels.push('High Volume');
  } else if (total >= 8 && total <= 35) {
    const wins = closedPositions.filter(p => parseFloat(p.realizedPnl || 0) > 0.01).length;
    if (wins / total >= 0.62) labels.push('Selective');
  }

  return labels;
}

// ── Daily Alpha Picks scanner ─────────────────────────────────────────────────
async function runDailyScan() {
  if (scanInProgress) { console.log('⏭️  Scan already in progress, skipping'); return dailyScanResult; }
  if (Date.now() - lastDailyScanTime < SCAN_MIN_COOLDOWN) { console.log('⏭️  Scan too recent, skipping'); return dailyScanResult; }
  scanInProgress = true;
  console.log('🎯 Daily scan starting...');
  try {

  // Build wallet pool: start with tracked + discovered wallets
  const pool = new Set([
    ...Object.keys(state.wallets),
    ...Object.keys(discoveredWallets)
  ]);
  const leaderboardNames = {}; // addr -> userName from leaderboard

  // Fetch top 500 from Polymarket leaderboard (paginate 10 × 50)
  try {
    for (let offset = 0; offset < 500; offset += 50) {
      const r = await axios.get(`${DATA_API}/v1/leaderboard`, {
        params: { limit: 50, offset, timePeriod: 'ALL', orderBy: 'PNL' },
        timeout: 10000
      });
      const entries = Array.isArray(r.data) ? r.data : [];
      entries.forEach(e => {
        const addr = (e.proxyWallet || '').toLowerCase();
        if (addr.startsWith('0x')) {
          pool.add(addr);
          if (e.userName) leaderboardNames[addr] = e.userName;
        }
      });
      if (entries.length < 50) break; // no more pages
      await delay(200);
    }
    console.log(`📊 Leaderboard fetched, pool size: ${pool.size}`);
  } catch (e) {
    console.log(`⚠️  Leaderboard API failed (${e.message}), using local pool (${pool.size} wallets)`);
  }

  const poolArr = [...pool];
  const scanned = poolArr.length;
  const results = [];
  const SCAN_TIMEOUT_MS = 12 * 60 * 1000; // 12-minute wall-clock limit
  const scanStart = Date.now();

  for (const addr of poolArr) {
    if (Date.now() - scanStart > SCAN_TIMEOUT_MS) {
      console.warn(`⏱️ Scan timeout after 12m — processed ${results.length} qualifying wallets from ${poolArr.indexOf(addr)}/${scanned}`);
      break;
    }
    try {
      const pnl = await fetchPnL(addr);
      await delay(150);
      if (!pnl || pnl.tradeCount < 10) continue;
      if (pnl.winRate < 52) continue;

      // Score: win rate (45%) + capped ROI (35%) + activity (20%)
      const winScore = pnl.winRate;
      const roiScore = Math.min(Math.max(pnl.roi, 0), 300) / 300 * 100;
      const actScore = Math.min(pnl.tradeCount / 50, 1) * 100;
      const score = Math.round(winScore * 0.45 + roiScore * 0.35 + actScore * 0.20);

      const label = state.wallets[addr]?.label || discoveredWallets[addr]?.label || leaderboardNames[addr] || addr.slice(0, 8) + '...';
      results.push({
        address: addr,
        label,
        score,
        winRate: parseFloat(pnl.winRate.toFixed(1)),
        roi: parseFloat(pnl.roi.toFixed(1)),
        profit: parseFloat((pnl.profit || 0).toFixed(2)),
        tradeCount: pnl.tradeCount,
        wins: pnl.wins,
        losses: pnl.losses,
        grade: computeGrade(pnl.winRate, pnl.roi)
      });
    } catch (e) { /* skip bad wallets */ }
  }

  results.sort((a, b) => b.score - a.score);
  const passed = results.length;
  const picks = results.slice(0, 10);
  const avgROI = picks.length ? parseFloat((picks.reduce((s, p) => s + p.roi, 0) / picks.length).toFixed(1)) : 0;
  const bestROI = picks.length ? Math.max(...picks.map(p => p.roi)) : 0;

  const scanResult = {
    scannedAt: Date.now(),
    scanned,
    passed,
    avgROI,
    bestROI: parseFloat(bestROI.toFixed(1)),
    picks
  };

  dailyScanResult = scanResult;
  lastDailyScanTime = Date.now();

  if (dailyPicksCol) {
    try { await dailyPicksCol.insertOne({ ...scanResult }); }
    catch (e) { console.warn('⚠️  Daily scan save failed:', e.message); }
  }

  console.log(`✅ Daily scan: ${scanned} scanned, ${passed} passed filters, top score: ${picks[0]?.score || 0}`);
  return scanResult;
  } catch (e) {
    console.error('❌ Daily scan failed:', e);
    return dailyScanResult;
  } finally {
    scanInProgress = false;
  }
}

// ── Global whale scanner ──────────────────────────────────────────────────────
async function scanLeaderboardActivity() {
  const addresses = Object.keys(leaderboardWallets);
  if (!addresses.length) return;

  let newCount = 0;
  const seenIds = new Set(pendingTrades.map(t => t.id));

  // Prioritise: daily picks first (highest-quality wallets from 500-wallet scan),
  // then tracked/discovered — cap at 50 total to stay within rate limits
  const picksSet = new Set((dailyScanResult?.picks || []).map(p => p.address));
  const prioritized = [
    ...addresses.filter(a => picksSet.has(a)),
    ...addresses.filter(a => !picksSet.has(a))
  ].slice(0, 50);

  for (const address of prioritized) {
    const trades = await fetchActivity(address, 5);
    for (const trade of trades) {
      const size = parseFloat(trade.size || trade.usdcSize || 0);
      if (size < WHALE_MIN_SIZE) continue;

      const tradeId = `${address}_${trade.id || trade.timestamp}`;
      if (seenIds.has(tradeId)) continue;

      seenIds.add(tradeId);
      pendingTrades.push({
        id: tradeId,
        address,
        rank: leaderboardWallets[address]?.rank,
        walletLabel: leaderboardWallets[address]?.label,
        side: trade.side,
        outcome: trade.outcomeIndex === 0 ? 'YES' : 'NO',
        price: parseFloat(trade.price || 0),
        size,
        conditionId: trade.conditionId,
        market: trade.title || trade.market || trade.conditionId || 'Unknown',
        timestamp: trade.timestamp || Date.now(),
        analyzed: false
      });
      newCount++;
    }
    await delay(200);
  }

  // Cap buffer at 500
  if (pendingTrades.length > 500) pendingTrades = pendingTrades.slice(-500);
  if (newCount > 0) console.log(`🔍 Scanner: ${newCount} new whale trade(s) queued (${pendingTrades.filter(t => !t.analyzed).length} pending analysis)`);
}

async function main() {
  console.log('🔮 PolyWatch starting...\n');
  await connectDB();
  await loadState();
  await loadDiscoveredWallets();
  initTelegram();
  startApiServer();
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);

  // Leaderboard sync + whale scanner
  await syncLeaderboard();
  setInterval(syncLeaderboard, LEADERBOARD_SYNC_INTERVAL);
  await scanLeaderboardActivity();
  setInterval(scanLeaderboardActivity, SCANNER_INTERVAL);

  // Daily alpha picks scanner (runs every 6h)
  setTimeout(async () => {
    await runDailyScan();
    setInterval(runDailyScan, DAILY_SCAN_INTERVAL);
  }, 5000); // delay 5s after startup to not overload

  console.log(`\n✅ Polling every ${POLL_INTERVAL_MS/1000}s | Scanner every ${SCANNER_INTERVAL/1000}s | Leaderboard syncs hourly\n`);
}

main().catch(console.error);