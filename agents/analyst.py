"""
PolyWatch AI Agent Swarm
Runs 3 Claude agents in parallel to analyze Polymarket opportunities:
  1. whale_agent      — finds top-wallet convergence on the same market
  2. arbitrage_agent  — detects multi-outcome YES price gaps (sum < $1.00)
  3. near_certainty_agent — spots 88-97% markets that may be mispriced

Usage:
  python analyst.py            # run once
  python analyst.py --loop     # run every 5 minutes continuously
"""

import asyncio
import aiohttp
import json
import os
import re
import sys
import time
from datetime import datetime

# Force UTF-8 output on Windows so emojis don't crash the console
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

load_dotenv()

BACKEND_URL      = os.getenv('BACKEND_URL', 'http://localhost:3001')
ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
TELEGRAM_TOKEN   = os.getenv('TELEGRAM_TOKEN', '')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', '')
LOOP_INTERVAL    = int(os.getenv('LOOP_INTERVAL', '300'))   # seconds between runs
MIN_CONFIDENCE   = int(os.getenv('MIN_CONFIDENCE', '50'))   # only post signals above this
MAX_RUNS_PER_DAY = int(os.getenv('MAX_RUNS_PER_DAY', '48'))  # default: every 30min max

_runs_today = 0
_runs_reset_date = None

GAMMA_API = 'https://gamma-api.polymarket.com'

client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_json_from_text(text: str) -> dict | None:
    """Extract the first JSON object from a Claude response."""
    try:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            return json.loads(m.group())
    except Exception:
        pass
    return None


def fmt_trades(markets_dict: dict) -> str:
    lines = []
    for market, trades in markets_dict.items():
        lines.append(f"\nMarket: {str(market)[:80]}")
        for t in trades:
            lines.append(
                f"  Rank #{t.get('rank','?')} ({t.get('walletLabel','?')}): "
                f"{t['side']} {t['outcome']} at {round(t['price']*100)}¢  (${t['size']:,.0f})"
            )
    return '\n'.join(lines)


# ── Backend wake-up ───────────────────────────────────────────────────────────

async def wake_backend(session: aiohttp.ClientSession) -> bool:
    """Ping /health with retries to wake Render from sleep (cold start takes ~30-50s)."""
    print("⏰ Waking backend (Render free tier sleeps after 15 min)...")
    for attempt in range(3):
        try:
            async with session.get(
                f'{BACKEND_URL}/health',
                timeout=aiohttp.ClientTimeout(total=60)
            ) as r:
                if r.status == 200:
                    data = await r.json()
                    print(f"✅ Backend alive (wallets: {data.get('wallets', '?')}, pending: {data.get('pendingTrades', '?')})")
                    return True
        except Exception as e:
            if attempt < 2:
                print(f"  Retry {attempt + 1}/3... ({e})")
                await asyncio.sleep(3)
            else:
                print(f"❌ Backend unreachable after 3 attempts: {e}")
    return False


# ── Agent 1: Whale Convergence ────────────────────────────────────────────────

async def whale_agent(trades: list) -> dict | None:
    """Finds markets where 2+ tracked wallets are buying the same outcome."""
    if not trades:
        return None

    # Group trades by market (support both buffered and consensus trade formats)
    markets: dict[str, list] = {}
    for t in trades:
        key = t.get('market') or t.get('conditionId') or 'unknown'
        if key == 'unknown':
            continue
        # Normalise field names — consensus trades use 'wallet'/'address', buffered use 'address'
        if 'address' not in t and 'wallet' in t:
            t = {**t, 'address': t['wallet']}
        markets.setdefault(key, []).append(t)

    # Keep only markets with 2+ different wallets on the same side/outcome
    convergent = {}
    for market, ts in markets.items():
        yes_wallets = set(t.get('address','') for t in ts if t.get('outcome') == 'YES' and t.get('side') == 'BUY')
        no_wallets  = set(t.get('address','') for t in ts if t.get('outcome') == 'NO'  and t.get('side') == 'BUY')
        if len(yes_wallets) >= 2 or len(no_wallets) >= 2:
            convergent[market] = ts

    if not convergent:
        print("  [whale_agent] No convergent activity found — need 2+ wallets on same market.")
        return None

    prompt = f"""You are a Polymarket trading analyst. Multiple top-ranked traders have converged on the same market.

Recent whale trades (wallets are ranked by weekly profit on Polymarket leaderboard):
{fmt_trades(convergent)}

Today: {datetime.now().strftime('%Y-%m-%d %H:%M UTC')}

Identify the SINGLE best trading opportunity from this data. Return ONLY a JSON object:
{{
  "market": "full market question",
  "direction": "YES" or "NO",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentences explaining the signal>",
  "trade_ids": {json.dumps([t['id'] for ts in convergent.values() for t in ts])}
}}"""

    msg = await client.messages.create(
        model='claude-haiku-4-5-20251001',
        max_tokens=400,
        messages=[{'role': 'user', 'content': prompt}]
    )
    result = parse_json_from_text(msg.content[0].text)
    if result:
        result['strategy'] = 'whale'
        # Find conditionId for the market Claude picked
        picked = result.get('market', '')
        for market_key, ts in convergent.items():
            if market_key[:60] in picked or picked[:60] in market_key:
                cid = ts[0].get('conditionId', '')
                if cid:
                    result['conditionId'] = cid
                break
    return result


# ── Agent 2: Multi-Outcome Arbitrage ─────────────────────────────────────────

async def arbitrage_agent(session: aiohttp.ClientSession) -> dict | None:
    """Scans multi-outcome markets for YES prices summing < $1.00 (risk-free profit)."""
    try:
        async with session.get(
            f'{GAMMA_API}/markets',
            params={'limit': 100, 'active': 'true', 'order': 'volume24hr', 'ascending': 'false'},
            timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            markets = await r.json()
    except Exception as e:
        print(f"  [arbitrage_agent] Failed to fetch markets: {e}")
        return None

    opportunities = []
    for m in markets:
        outcomes = m.get('outcomes', [])
        if len(outcomes) < 3:
            continue
        try:
            raw = m.get('outcomePrices', '[]')
            prices = [float(p) for p in raw.strip('[]').split(',')]
            total = sum(prices)
            if total < 0.97:  # Arbitrage gap exists
                opportunities.append({
                    'market':   m.get('question', 'Unknown'),
                    'slug':     m.get('slug', ''),
                    'total':    round(total, 4),
                    'gap':      round(1 - total, 4),
                    'outcomes': list(zip(outcomes, [round(p, 3) for p in prices])),
                    'volume':   float(m.get('volume24hr', 0))
                })
        except Exception:
            continue

    if not opportunities:
        print("  [arbitrage_agent] No arbitrage gaps found.")
        return None

    best = sorted(opportunities, key=lambda x: x['gap'], reverse=True)[0]
    pct_return = round(best['gap'] / best['total'] * 100, 2)
    outcome_str = ', '.join(f"{o[0]}={o[1]}" for o in best['outcomes'])

    return {
        'strategy':  'arbitrage',
        'market':    best['market'],
        'slug':      best.get('slug', ''),
        'direction': 'ALL_YES',
        'confidence': min(95, int(best['gap'] * 600)),
        'reasoning': (
            f"YES prices sum to {best['total']} (gap: {best['gap']}). "
            f"Buying all YES outcomes costs ${best['total']:.3f} and guarantees $1.00 payout = "
            f"{pct_return}% risk-free return. Prices: {outcome_str}"
        ),
        'trade_ids': []
    }


# ── Agent 3: Near-Certainty Fading ───────────────────────────────────────────

async def near_certainty_agent(session: aiohttp.ClientSession) -> dict | None:
    """Finds markets at 88-97% YES that may be overpriced — the NO side is cheap."""
    try:
        async with session.get(
            f'{GAMMA_API}/markets',
            params={'limit': 200, 'active': 'true'},
            timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            markets = await r.json()
    except Exception as e:
        print(f"  [near_certainty_agent] Failed to fetch markets: {e}")
        return None

    candidates = []
    for m in markets:
        try:
            prices = [float(p) for p in m.get('outcomePrices', '[]').strip('[]').split(',')]
            max_p = max(prices)
            if 0.88 <= max_p <= 0.97:
                candidates.append({
                    'market':    m.get('question', 'Unknown'),
                    'slug':      m.get('slug', ''),
                    'yes_price': max_p,
                    'no_price':  round(1 - max_p, 3),
                    'volume':    float(m.get('volume24hr', m.get('volume', 0))),
                    'end_date':  m.get('endDate', '')
                })
        except Exception:
            continue

    if not candidates:
        print("  [near_certainty_agent] No near-certainty markets found.")
        return None

    # Sort by volume: liquid markets have better signal quality
    candidates = sorted(candidates, key=lambda x: x['volume'], reverse=True)[:10]

    market_list = '\n'.join(
        f"- {c['market'][:80]}: YES={round(c['yes_price']*100)}¢  NO={round(c['no_price']*100)}¢  "
        f"Vol=${c['volume']:,.0f}  Closes:{c['end_date'][:10]}"
        for c in candidates
    )

    prompt = f"""You are a Polymarket analyst. These markets are priced 88-97% YES — nearly certain but not resolved yet.
Your job: find the ONE market where the NO side is most undervalued (i.e. dominant outcome is overpriced).

Markets:
{market_list}

Today: {datetime.now().strftime('%Y-%m-%d')}

Consider: upcoming events, market close dates, news risk, volume trends.
Return ONLY a JSON object:
{{
  "market": "full market question",
  "direction": "NO",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentences on why the dominant outcome might be overpriced>",
  "trade_ids": []
}}"""

    msg = await client.messages.create(
        model='claude-haiku-4-5-20251001',
        max_tokens=400,
        messages=[{'role': 'user', 'content': prompt}]
    )
    result = parse_json_from_text(msg.content[0].text)
    if result:
        result['strategy'] = 'near_certainty'
        # Match the market Claude picked back to a slug
        picked = result.get('market', '')
        match = next((c for c in candidates if c['market'][:60] in picked or picked[:60] in c['market']), None)
        if match:
            result['slug'] = match.get('slug', '')
    return result


# ── Agent 4: Signal Auditor (daily, 9am UTC) ─────────────────────────────────

async def auditor_agent(session: aiohttp.ClientSession) -> None:
    """
    Fetches the last 100 signals, checks how many resolved markets played out
    correctly, then sends a per-strategy win-rate report to Telegram.
    Runs once per day (caller checks hour == 9 UTC).
    """
    print("  [auditor_agent] Fetching signals for audit...")

    try:
        async with session.get(
            f'{BACKEND_URL}/signals?limit=100',
            timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            signals = await r.json()
    except Exception as e:
        print(f"  [auditor_agent] Could not fetch signals: {e}")
        return

    if not signals:
        print("  [auditor_agent] No signals to audit yet.")
        return

    stats: dict[str, dict] = {
        'whale':          {'w': 0, 'l': 0},
        'near_certainty': {'w': 0, 'l': 0},
        'arbitrage':      {'w': 0, 'l': 0},
    }
    total_checked = 0

    for sig in signals:
        slug      = sig.get('slug', '')
        cid       = sig.get('conditionId', '')
        direction = sig.get('direction', '')
        strategy  = sig.get('strategy', '')

        # Arbitrage is multi-outcome — resolution logic is complex, skip for now
        if direction == 'ALL_YES' or strategy not in stats or not (slug or cid):
            continue

        try:
            params = {'slug': slug} if slug else {'condition_ids': cid}
            async with session.get(
                f'{GAMMA_API}/markets',
                params=params,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as r:
                data = await r.json()

            market = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
            if not market:
                continue

            # Only grade resolved markets
            if market.get('active', True) or not market.get('closed', False):
                continue

            raw      = market.get('outcomePrices', '[]')
            prices   = [float(p) for p in raw.strip('[]').split(',')]
            outcomes = market.get('outcomes', ['Yes', 'No'])

            if len(prices) < 2:
                continue

            yes_idx   = next((i for i, o in enumerate(outcomes) if str(o).lower() in ('yes', 'true')), 0)
            yes_price = prices[yes_idx]

            if direction == 'YES':
                won = yes_price >= 0.95
            elif direction == 'NO':
                won = yes_price <= 0.05
            else:
                continue

            stats[strategy]['w' if won else 'l'] += 1
            total_checked += 1

        except Exception:
            continue

    if total_checked == 0:
        print("  [auditor_agent] No resolved signals yet — markets still open.")
        return

    # Build report
    overall_w = sum(v['w'] for v in stats.values())
    overall_l = sum(v['l'] for v in stats.values())
    overall_pct = round(overall_w / (overall_w + overall_l) * 100) if (overall_w + overall_l) else 0

    lines = [
        f"📊 *PolyWatch Daily Audit — {datetime.utcnow().strftime('%b %d, %Y')}*\n",
        f"Resolved signals: *{total_checked}*  |  Overall: *{overall_w}W/{overall_l}L* ({overall_pct}%)\n",
    ]
    labels = {'whale': '🐋 Whale', 'near_certainty': '🎯 Contrarian', 'arbitrage': '⚡ Arbitrage'}
    for strat, r in stats.items():
        total = r['w'] + r['l']
        if total == 0:
            continue
        pct   = round(r['w'] / total * 100)
        bar   = '█' * round(pct / 10) + '░' * (10 - round(pct / 10))
        flag  = '  ⚠️ underperforming' if pct < 45 else ''
        lines.append(f"{labels[strat]}: {r['w']}W/{r['l']}L ({pct}%) {bar}{flag}")

    report = '\n'.join(lines)
    print(f"  [auditor_agent]\n{report}")

    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("  [auditor_agent] ⚠️  TELEGRAM_TOKEN/CHAT_ID not set — add to .env and GitHub Secrets")
        return

    try:
        async with session.post(
            f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage',
            json={'chat_id': TELEGRAM_CHAT_ID, 'text': report, 'parse_mode': 'Markdown'},
            timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            resp = await r.json()
            if resp.get('ok'):
                print("  [auditor_agent] ✅ Audit report sent to Telegram")
            else:
                print(f"  [auditor_agent] ❌ Telegram error: {resp.get('description', resp)}")
    except Exception as e:
        print(f"  [auditor_agent] ❌ Failed to send: {e}")


# ── Swarm Orchestrator ────────────────────────────────────────────────────────

async def run_swarm():
    print(f"\n{'='*60}")
    print(f"🤖 PolyWatch Swarm — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}")

    async with aiohttp.ClientSession() as session:
        # Wake up Render (free tier sleeps after 15 min; cold start takes ~30-50s)
        if not await wake_backend(session):
            return

        # Fetch pending whale trades from backend
        try:
            async with session.get(
                f'{BACKEND_URL}/pending-trades',
                timeout=aiohttp.ClientTimeout(total=15)
            ) as r:
                pending_trades = await r.json()
        except Exception as e:
            print(f"❌ Could not fetch pending trades: {e}")
            return

        print(f"📥 {len(pending_trades)} pending whale trades to analyze")
        print("🚀 Launching 3 agents in parallel...\n")

        # Run all 3 agents simultaneously
        results = await asyncio.gather(
            whale_agent(pending_trades),
            arbitrage_agent(session),
            near_certainty_agent(session),
            return_exceptions=True
        )

        agent_names = ['whale', 'arbitrage', 'near_certainty']
        signals_posted = 0

        for name, result in zip(agent_names, results):
            if isinstance(result, Exception):
                print(f"  [{name}_agent] ⚠️  Error: {result}")
                continue
            if result is None:
                print(f"  [{name}_agent] — No signal this run")
                continue

            conf = result.get('confidence', 0)
            print(f"  [{name}_agent] Signal: {result.get('market','?')[:55]}...")
            print(f"               Direction: {result.get('direction')}  Confidence: {conf}%")

            if conf < MIN_CONFIDENCE:
                print(f"               Skipped (below {MIN_CONFIDENCE}% threshold)")
                continue

            try:
                async with session.post(
                    f'{BACKEND_URL}/signals',
                    json=result,
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as r:
                    if r.status == 200:
                        signals_posted += 1
                        print(f"               ✅ Posted to backend")
                    else:
                        print(f"               ❌ Backend returned {r.status}")
            except Exception as e:
                print(f"               ❌ Failed to post: {e}")

        print(f"\n🏁 Done — {signals_posted}/3 signals posted\n")

        # Run daily audit once at 9am UTC (GitHub Actions cron fires at :00 and :30)
        if datetime.utcnow().hour == 9:
            print("🔍 9am UTC — running daily performance audit...")
            await auditor_agent(session)


# ── Entry point ───────────────────────────────────────────────────────────────

def check_daily_limit() -> bool:
    """Returns True if under the daily run cap, False if limit reached."""
    global _runs_today, _runs_reset_date
    today = datetime.now().date()
    if _runs_reset_date != today:
        _runs_today = 0
        _runs_reset_date = today
    if _runs_today >= MAX_RUNS_PER_DAY:
        print(f"🛑 Daily run cap reached ({MAX_RUNS_PER_DAY} runs). Skipping until tomorrow.")
        return False
    _runs_today += 1
    print(f"📊 Run {_runs_today}/{MAX_RUNS_PER_DAY} today")
    return True


if __name__ == '__main__':
    if not ANTHROPIC_API_KEY:
        print("❌ ANTHROPIC_API_KEY not set. Add it to agents/.env")
        sys.exit(1)

    # Rough cost estimate at startup
    est_monthly = (86400 / LOOP_INTERVAL) * 30 * 0.001  # ~$0.001 per run
    print(f"[cost] Estimated max: ~${est_monthly:.2f}/month at {LOOP_INTERVAL}s interval")
    print(f"       Daily cap: {MAX_RUNS_PER_DAY} runs/day  |  Set MAX_RUNS_PER_DAY in .env to adjust\n")

    if '--loop' in sys.argv:
        print(f"🔄 Running in loop mode (every {LOOP_INTERVAL}s)")
        while True:
            if check_daily_limit():
                asyncio.run(run_swarm())
            print(f"⏳ Next run in {LOOP_INTERVAL}s...")
            time.sleep(LOOP_INTERVAL)
    else:
        asyncio.run(run_swarm())
