/**
 * PolyWatch — Polymarket Wallet Tracker
 * Uses MongoDB for persistent wallet storage
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
    state.wallets[w.address] = { label: w.label, addedAt: w.addedAt, alerts: w.alerts !== false, threshold: w.threshold };
    state.lastSeen[w.address] = w.lastSeen || null;
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

let bot;
function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.warn('⚠️  No TELEGRAM_TOKEN'); return; }
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('✅ Telegram bot connected');

  bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, `🔮 *PolyWatch Bot*\n\n/track <address> [label]\n/untrack <address>\n/list\n/pnl <address>\n/positions <address>`, { parse_mode: 'Markdown' }));

  bot.onText(/\/track (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(' ');
    const address = parts[0].toLowerCase();
    const label = parts.slice(1).join(' ') || `Wallet ${Object.keys(state.wallets).length + 1}`;
    if (!address.startsWith('0x') || address.length < 40) return bot.sendMessage(msg.chat.id, '❌ Invalid address');
    const data = { label, addedAt: Date.now(), alerts: true, threshold: MIN_TRADE_SIZE_USD };
    state.wallets[address] = data; state.lastSeen[address] = null;
    await saveWallet(address, data);
    bot.sendMessage(msg.chat.id, `✅ Now tracking *${label}*`, { parse_mode: 'Markdown' });
    await sendPositions(msg.chat.id, address, label);
  });

  bot.onText(/\/untrack (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    if (!state.wallets[address]) return bot.sendMessage(msg.chat.id, '❌ Not found');
    const label = state.wallets[address].label;
    delete state.wallets[address]; delete state.lastSeen[address];
    await deleteWallet(address);
    bot.sendMessage(msg.chat.id, `🔕 Stopped: *${label}*`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/list/, msg => {
    const w = Object.entries(state.wallets);
    if (!w.length) return bot.sendMessage(msg.chat.id, '📋 No wallets tracked');
    bot.sendMessage(msg.chat.id, `👛 *Wallets (${w.length})*\n\n` + w.map(([a, v], i) => `${i+1}. *${v.label}*\n\`${a.slice(0,8)}...\``).join('\n\n'), { parse_mode: 'Markdown' });
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
  try { const r = await axios.get(`${DATA_API}/portfolio-profit-and-loss`, { params: { user: address }, timeout: 10000 }); return r.data; }
  catch (e) { try { const r2 = await axios.get(`${DATA_API}/profile`, { params: { address }, timeout: 10000 }); return r2.data; } catch { return null; } }
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
    if (size < MIN_TRADE_SIZE_USD || !wallet.alerts || !bot) continue;
    const q = await fetchMarketQuestion(trade.conditionId||trade.market);
    const side = trade.side==='BUY'?'🟢 BUY':'🔴 SELL';
    const out = trade.outcomeIndex===0?'YES':'NO';
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID,
        `⚡ *New Trade — ${wallet.label}*\n\n${side} *${out}*\n📊 _${q}_\n\n💵 $${size.toFixed(2)} at ${Math.round(parseFloat(trade.price||0)*100)}¢`,
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
      if (path==='/wallets' && req.method==='GET') return res.end(JSON.stringify(Object.entries(state.wallets).map(([a,w])=>({address:a,...w}))));

      if (path==='/wallets' && req.method==='POST') {
        const { address, label, threshold } = JSON.parse(await readBody(req));
        if (!address?.startsWith('0x')) { res.statusCode=400; return res.end(JSON.stringify({error:'Invalid address'})); }
        const addr = address.toLowerCase();
        if (state.wallets[addr]) { res.statusCode=409; return res.end(JSON.stringify({error:'Already tracking'})); }
        const walletLabel = label || `Wallet ${Object.keys(state.wallets).length+1}`;
        const data = { label:walletLabel, addedAt:Date.now(), alerts:true, threshold:parseFloat(threshold)||MIN_TRADE_SIZE_USD };
        state.wallets[addr]=data; state.lastSeen[addr]=null;
        await saveWallet(addr, data);
        console.log(`➕ Tracking: ${walletLabel}`);
        bot?.sendMessage(TELEGRAM_CHAT_ID, `✅ *Now tracking: ${walletLabel}*\n\`${addr}\``, { parse_mode:'Markdown' }).catch(()=>{});
        return res.end(JSON.stringify({success:true,address:addr,label:walletLabel}));
      }

      if (path==='/wallets' && req.method==='DELETE') {
        const addr = url.searchParams.get('address')?.toLowerCase();
        if (!addr||!state.wallets[addr]) { res.statusCode=404; return res.end(JSON.stringify({error:'Not found'})); }
        const label = state.wallets[addr].label;
        delete state.wallets[addr]; delete state.lastSeen[addr];
        await deleteWallet(addr);
        bot?.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Stopped: ${label}*`, { parse_mode:'Markdown' }).catch(()=>{});
        return res.end(JSON.stringify({success:true}));
      }

      if (path==='/activity') { const a=url.searchParams.get('address'); return res.end(JSON.stringify(a?await fetchActivity(a,20):[])); }
      if (path==='/positions') { const a=url.searchParams.get('address'); return res.end(JSON.stringify(a?await fetchPositions(a):[])); }
      if (path==='/pnl') { const a=url.searchParams.get('address'); return res.end(JSON.stringify(a?await fetchPnL(a)||{}:{})); }
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