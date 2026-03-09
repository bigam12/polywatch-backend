/**
 * PolyWatch — Polymarket Wallet Tracker
 * Backend Engine: Polls Data API + sends Telegram alerts
 */

require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');
const MIN_TRADE_SIZE_USD = parseFloat(process.env.MIN_TRADE_SIZE_USD || '50');
const DATA_FILE = './data/state.json';

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

let state = { wallets: {}, lastSeen: {} };

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`✅ Loaded state: tracking ${Object.keys(state.wallets).length} wallets`);
    }
  } catch (e) { console.warn('⚠️  Could not load state, starting fresh'); }
}

function saveState() {
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

let bot;
function initTelegram() {
  if (!TELEGRAM_TOKEN) { console.warn('⚠️  No TELEGRAM_TOKEN set'); return; }
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('✅ Telegram bot connected');

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🔮 *PolyWatch Bot*\n\n*Commands:*\n/track <address> [label]\n/untrack <address>\n/list\n/pnl <address>\n/positions <address>\n/alerts <on|off>\n/threshold <amount>`,
      { parse_mode: 'Markdown' });
  });

  bot.onText(/\/track (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(' ');
    const address = parts[0].toLowerCase();
    const label = parts.slice(1).join(' ') || `Wallet ${Object.keys(state.wallets).length + 1}`;
    if (!address.startsWith('0x') || address.length < 40)
      return bot.sendMessage(msg.chat.id, '❌ Invalid address');
    state.wallets[address] = { label, addedAt: Date.now(), alerts: true, threshold: MIN_TRADE_SIZE_USD };
    state.lastSeen[address] = null;
    saveState();
    bot.sendMessage(msg.chat.id, `✅ Now tracking *${label}*\n\`${address}\``, { parse_mode: 'Markdown' });
    await sendPositions(msg.chat.id, address, label);
  });

  bot.onText(/\/untrack (.+)/, (msg, match) => {
    const address = match[1].trim().toLowerCase();
    if (state.wallets[address]) {
      const label = state.wallets[address].label;
      delete state.wallets[address]; delete state.lastSeen[address]; saveState();
      bot.sendMessage(msg.chat.id, `🔕 Stopped tracking *${label}*`, { parse_mode: 'Markdown' });
    } else { bot.sendMessage(msg.chat.id, '❌ Wallet not found'); }
  });

  bot.onText(/\/list/, (msg) => {
    const wallets = Object.entries(state.wallets);
    if (!wallets.length) return bot.sendMessage(msg.chat.id, '📋 No wallets tracked yet.');
    const list = wallets.map(([addr, w], i) => `${i+1}. *${w.label}*\n   \`${addr.slice(0,6)}...${addr.slice(-4)}\``).join('\n\n');
    bot.sendMessage(msg.chat.id, `👛 *Tracked Wallets (${wallets.length})*\n\n${list}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pnl (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    const label = state.wallets[address]?.label || address.slice(0,8)+'...';
    await sendPnL(msg.chat.id, address, label);
  });

  bot.onText(/\/positions (.+)/, async (msg, match) => {
    const address = match[1].trim().toLowerCase();
    const label = state.wallets[address]?.label || address.slice(0,8)+'...';
    await sendPositions(msg.chat.id, address, label);
  });

  bot.onText(/\/alerts (on|off)/, (msg, match) => {
    const setting = match[1] === 'on';
    Object.keys(state.wallets).forEach(addr => { state.wallets[addr].alerts = setting; });
    saveState();
    bot.sendMessage(msg.chat.id, `🔔 Alerts ${setting ? 'enabled' : 'disabled'} for all wallets`);
  });

  bot.onText(/\/threshold (\d+)/, (msg, match) => {
    const amount = parseInt(match[1]);
    Object.keys(state.wallets).forEach(addr => { state.wallets[addr].threshold = amount; });
    saveState();
    bot.sendMessage(msg.chat.id, `✅ Alert threshold set to $${amount}`);
  });
}

async function fetchActivity(address, limit = 20) {
  try {
    const res = await axios.get(`${DATA_API}/activity`, { params: { user: address, limit, type: 'trade' }, timeout: 10000 });
    return res.data || [];
  } catch (e) { console.error(`❌ fetchActivity(${address}): ${e.message}`); return []; }
}

async function fetchPositions(address) {
  try {
    const res = await axios.get(`${DATA_API}/positions`, { params: { user: address, limit: 50, sizeThreshold: 0.01 }, timeout: 10000 });
    return res.data || [];
  } catch (e) { console.error(`❌ fetchPositions(${address}): ${e.message}`); return []; }
}

async function fetchPnL(address) {
  try {
    const res = await axios.get(`${DATA_API}/portfolio-profit-and-loss`, { params: { user: address }, timeout: 10000 });
    return res.data;
  } catch (e) {
    try { const r2 = await axios.get(`${DATA_API}/profile`, { params: { address }, timeout: 10000 }); return r2.data; }
    catch { return null; }
  }
}

async function fetchMarketQuestion(conditionId) {
  try {
    const res = await axios.get(`${GAMMA_API}/markets`, { params: { condition_ids: conditionId }, timeout: 8000 });
    if (res.data && res.data.length > 0) return res.data[0].question;
  } catch (e) {}
  return 'Unknown Market';
}

function formatTradeAlert(wallet, trade, question) {
  const side = trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const outcome = trade.outcomeIndex === 0 ? 'YES' : 'NO';
  const size = parseFloat(trade.size || trade.usdcSize || 0);
  const price = parseFloat(trade.price || 0);
  return (
    `⚡ *New Trade — ${wallet.label}*\n\n` +
    `${side} *${outcome}*\n` +
    `📊 Market: _${question}_\n\n` +
    `💵 Size: *$${size.toFixed(2)}*\n` +
    `📈 Price: *${Math.round(price * 100)}¢*\n` +
    `🕐 ${new Date(trade.timestamp ? trade.timestamp * 1000 : Date.now()).toLocaleTimeString()}\n\n` +
    `👛 \`${(trade.maker || '').slice(0, 8)}...\``
  );
}

async function sendPositions(chatId, address, label) {
  const positions = await fetchPositions(address);
  if (!positions.length) return bot?.sendMessage(chatId, `📋 *${label}* has no open positions`, { parse_mode: 'Markdown' });
  const lines = positions.slice(0, 10).map(p => {
    const outcome = p.outcome || (p.outcomeIndex === 0 ? 'YES' : 'NO');
    const value = parseFloat(p.currentValue || p.value || 0).toFixed(2);
    return `• *${outcome}* on _${(p.title || p.market || 'Market').slice(0, 50)}_\n  $${value}`;
  }).join('\n\n');
  bot?.sendMessage(chatId, `📋 *${label} — Positions (${positions.length})*\n\n${lines}`, { parse_mode: 'Markdown' });
}

async function sendPnL(chatId, address, label) {
  const pnl = await fetchPnL(address);
  if (!pnl) return bot?.sendMessage(chatId, `❌ Could not fetch PnL for ${label}`);
  const profit = parseFloat(pnl.profit || pnl.totalProfit || 0);
  const volume = parseFloat(pnl.volume || pnl.totalVolume || 0);
  const emoji = profit >= 0 ? '🟢' : '🔴';
  bot?.sendMessage(chatId,
    `📊 *${label} — PnL*\n\n${emoji} P&L: *${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}*\n💰 Volume: *$${volume.toFixed(2)}*`,
    { parse_mode: 'Markdown' });
}

async function pollWallet(address, wallet) {
  const trades = await fetchActivity(address, 10);
  if (!trades.length) return;
  const lastId = state.lastSeen[address];
  const newTrades = lastId ? trades.filter(t => t.id > lastId) : [];
  if (trades[0]?.id) state.lastSeen[address] = trades[0].id;
  for (const trade of newTrades) {
    const size = parseFloat(trade.size || trade.usdcSize || 0);
    const threshold = wallet.threshold || MIN_TRADE_SIZE_USD;
    if (size < threshold || !wallet.alerts || !bot) continue;
    const question = await fetchMarketQuestion(trade.conditionId || trade.market);
    const msg = formatTradeAlert(wallet, trade, question);
    try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); await delay(300); }
    catch (e) { console.error('Telegram send error:', e.message); }
  }
  if (newTrades.length) console.log(`📡 ${wallet.label}: ${newTrades.length} new trade(s)`);
}

async function pollAll() {
  const wallets = Object.entries(state.wallets);
  if (!wallets.length) return;
  console.log(`🔄 Polling ${wallets.length} wallet(s)...`);
  for (const [address, wallet] of wallets) { await pollWallet(address, wallet); await delay(500); }
  saveState();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function startApiServer() {
  const PORT = process.env.PORT || 3001;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      if (path === '/wallets' && req.method === 'GET') {
        return res.end(JSON.stringify(Object.entries(state.wallets).map(([addr, w]) => ({ address: addr, ...w }))));
      }

      if (path === '/wallets' && req.method === 'POST') {
        const body = await readBody(req);
        const { address, label, threshold } = JSON.parse(body);
        if (!address || !address.startsWith('0x')) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid address' })); }
        const addr = address.toLowerCase();
        if (state.wallets[addr]) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'Already tracking this wallet' })); }
        const walletLabel = label || `Wallet ${Object.keys(state.wallets).length + 1}`;
        state.wallets[addr] = { label: walletLabel, addedAt: Date.now(), alerts: true, threshold: parseFloat(threshold) || MIN_TRADE_SIZE_USD };
        state.lastSeen[addr] = null;
        saveState();
        console.log(`➕ Now tracking: ${walletLabel} (${addr})`);
        if (bot) bot.sendMessage(TELEGRAM_CHAT_ID, `✅ *Now tracking: ${walletLabel}*\n\`${addr}\``, { parse_mode: 'Markdown' }).catch(() => {});
        return res.end(JSON.stringify({ success: true, address: addr, label: walletLabel }));
      }

      if (path === '/wallets' && req.method === 'DELETE') {
        const address = url.searchParams.get('address')?.toLowerCase();
        if (!address || !state.wallets[address]) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Wallet not found' })); }
        const label = state.wallets[address].label;
        delete state.wallets[address]; delete state.lastSeen[address]; saveState();
        console.log(`➖ Stopped tracking: ${label}`);
        if (bot) bot.sendMessage(TELEGRAM_CHAT_ID, `🔕 *Stopped tracking: ${label}*`, { parse_mode: 'Markdown' }).catch(() => {});
        return res.end(JSON.stringify({ success: true }));
      }

      if (path === '/activity') {
        const address = url.searchParams.get('address');
        if (!address) return res.end(JSON.stringify({ error: 'address required' }));
        return res.end(JSON.stringify(await fetchActivity(address, 20)));
      }

      if (path === '/positions') {
        const address = url.searchParams.get('address');
        if (!address) return res.end(JSON.stringify({ error: 'address required' }));
        return res.end(JSON.stringify(await fetchPositions(address)));
      }

      if (path === '/pnl') {
        const address = url.searchParams.get('address');
        if (!address) return res.end(JSON.stringify({ error: 'address required' }));
        return res.end(JSON.stringify(await fetchPnL(address) || {}));
      }

      if (path === '/health') {
        return res.end(JSON.stringify({ status: 'ok', tracked: Object.keys(state.wallets).length, uptime: process.uptime() }));
      }

      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  });
  server.listen(PORT, () => console.log(`✅ API server running on http://localhost:${PORT}`));
}

async function main() {
  console.log('🔮 PolyWatch starting...\n');
  loadState(); initTelegram(); startApiServer();
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`\n✅ Polling every ${POLL_INTERVAL_MS / 1000}s. Waiting for trades...\n`);
}

main().catch(console.error);
