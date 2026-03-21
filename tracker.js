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

let recentMarketTrades = {};
let patternData = {};

async function connectDB() {
  if (!MONGODB_URI) { console.warn('⚠️  No MONGODB_URI set'); return; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('polywatch');
    walletsCol = db.collection('wallets');
    console.log('✅ MongoDB connected');
  } catch (e) { console.error('❌ MongoDB:', e.message); }
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

async function fetchPnL(address) {
  try {
    const positions = await fetchPositions(address);
    if (!positions.length) return { profit: 0, volume: 0, totalProfit: 0, roi: 0, winRate: 0, tradeCount: 0, wins: 0, losses: 0, avgWin: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0, portfolioValue: 0 };

    // Log first position to show actual API field names
    console.log('📋 Sample position fields:', JSON.stringify(positions[0]));

    let totalCost = 0;
    let totalPortfolioValue = 0;
    let wins = 0;
    let losses = 0;
    let winAmounts = [];
    let lossAmounts = [];
    let bestTrade = 0;
    let worstTrade = 0;

    positions.forEach(p => {
      const size = parseFloat(p.size || 0);
      const avgPrice = parseFloat(p.avgPrice || p.initialOdds || p.purchasePrice || 0);
      const currentVal = parseFloat(p.currentValue || p.value || 0);
      // Cost = totalBought if available, else size * avgPrice
      const cost = parseFloat(p.totalBought || 0) || (size * avgPrice);

      totalPortfolioValue += currentVal;
      totalCost += cost;

      // Win/loss = is this position currently in profit vs what was paid
      const positionPnl = currentVal - cost;
      if (positionPnl > 0.01) {
        wins++;
        winAmounts.push(positionPnl);
        if (positionPnl > bestTrade) bestTrade = positionPnl;
      } else if (positionPnl < -0.01) {
        losses++;
        lossAmounts.push(positionPnl);
        if (positionPnl < worstTrade) worstTrade = positionPnl;
      }
    });

    const totalProfit = totalPortfolioValue - totalCost;
    const tradeCount = positions.length;
    const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
    const avgWin = wins > 0 ? winAmounts.reduce((a,b)=>a+b,0) / wins : 0;
    const avgLoss = losses > 0 ? lossAmounts.reduce((a,b)=>a+b,0) / losses : 0;
    const roi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

    console.log('📊 PnL calculated from positions:', { totalPortfolioValue, totalCost, totalProfit, roi, winRate, tradeCount, wins, losses });
    return {
      profit: totalProfit,
      volume: totalCost,
      totalProfit: totalProfit,
      roi: roi,
      winRate: winRate,
      tradeCount: tradeCount,
      wins: wins,
      losses: losses,
      avgWin: avgWin,
      avgLoss: avgLoss,
      bestTrade: bestTrade,
      worstTrade: worstTrade,
      portfolioValue: totalPortfolioValue
    };
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
        state.wallets[addr]=data; state.lastSeen[addr]=null;
        patternData[addr] = { earlyEntries:0, totalTrades:0, avgEntryPrice:0, tag:'unknown' };
        await saveWallet(addr, data);
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
      if (path==='/health') return res.end(JSON.stringify({status:'ok',tracked:Object.keys(state.wallets).length,uptime:process.uptime()}));
      res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
    } catch(e) { res.statusCode=500; res.end(JSON.stringify({error:e.message})); }
  }).listen(PORT, ()=>console.log(`✅ API server running on http://localhost:${PORT}`));
}

async function main() {
  console.log('🔮 PolyWatch starting...\n');
  await connectDB();
  await loadState();
  initTelegram();
  startApiServer();
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`\n✅ Polling every ${POLL_INTERVAL_MS/1000}s. Waiting for trades...\n`);
}

main().catch(console.error);