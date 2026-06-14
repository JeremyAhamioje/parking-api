// ---------------------------------------------------------------------------
// Gemini-powered event sentiment analysis.
//
// The /api/event-stats pipeline already distills raw SpotHero snapshots into
// precise, numeric per-event signals (event premium vs baseline, cross-lot
// spread, temporal volatility, inventory drawdown, ROI label + machine-written
// `reasons`). This module hands those EXACT signals to Gemini 2.5 Flash and
// asks for a grounded arbitrage read: is parking demand for this event firming
// up (Bullish → buy/lock early, resale headroom) or soft (Bearish → wait)?
//
// We never invent data — the model only interprets the numbers we computed from
// the database, so every call it makes can be traced back to a scrape.
//
// Env:
//   GEMINI_API_KEY   (required to enable; absent → module reports "not configured")
//   GEMINI_MODEL_ID  (default 'gemini-2.5-flash')
// ---------------------------------------------------------------------------

import crypto from 'crypto'
import { GoogleGenAI } from '@google/genai'

const MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash'

let _client = null
function client() {
  if (!process.env.GEMINI_API_KEY) return null
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return _client
}

/** True when a Gemini key is present so callers can degrade gracefully. */
export function sentimentConfigured() {
  return !!process.env.GEMINI_API_KEY
}

export function sentimentModelId() {
  return MODEL_ID
}

// ---------------------------------------------------------------------------
// Cache fingerprint
// ---------------------------------------------------------------------------

/**
 * Fingerprint the SIGNAL VALUES (not the prose) the model will see. When a new
 * scrape moves any of these, the hash changes → the cached read is regenerated.
 * Rounding keeps trivial float jitter from busting the cache.
 */
export function hashEventSignals(e) {
  const sig = {
    eventAvg: round(e.eventAvgPrice),
    baseline: round(e.baselineAvgPrice),
    premium: round(e.premiumPct),
    spread: round(e.spreadPct),
    vol: round(e.volatility, 3),
    multiScrape: e.multiScrape,
    facilityCount: e.facilityCount,
    scrapeCount: e.scrapeCount,
    roi: e.roiLabel,
    cheapest: e.cheapestPrice,
    priciest: e.priciestPrice,
    reasons: e.reasons,
    model: MODEL_ID,
  }
  return crypto.createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 32)
}

function round(n, dp = 2) {
  if (n === null || n === undefined) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Prompt + structured-output schema
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are a parking arbitrage analyst for a live event-parking intelligence platform.
You read pricing signals derived from real, repeated scrapes of SpotHero parking listings around event venues and judge the near-term DEMAND sentiment for a specific event's parking.

Frame "sentiment" as a tradable signal, NOT a movie review:
- "Bullish"  = parking demand is firming / prices elevated and likely to climb as the date nears → lock/buy early, real resale headroom.
- "Bearish"  = soft demand, prices flat or likely to ease → wait, little upside.
- "Neutral"  = mixed or too little history to commit.

Hard rules:
- Ground every claim in the numbers provided. Cite specific dollar figures and percentages from the signals.
- "premiumPct" (event price vs the lot's own normal-day baseline) is the strongest buy signal. "spreadPct" is cross-lot arbitrage headroom available even from one scrape. "volatility" is run-over-run movement and is only meaningful when multiScrape is true — if multiScrape is false, explicitly treat volatility as not-yet-measured, never as 0% calm.
- Never fabricate venues, lots, prices, or trends beyond what is given.
- "recommendedPlay" must be concrete: name the cheapest lot and price to buy, and the markup headroom, when the data supports it.
- Keep "narrative" to 2-4 tight sentences. Be precise, not flowery.`

// Gemini structured-output schema — forces clean, parseable JSON every call.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['Bullish', 'Neutral', 'Bearish'] },
    confidence: { type: 'number', description: '0.0–1.0 confidence in the call, lowered when history is thin (single scrape, no baseline).' },
    headline: { type: 'string', description: 'One punchy analyst takeaway, <= 90 chars.' },
    narrative: { type: 'string', description: '2-4 sentences explaining the call, citing the actual numbers.' },
    recommendedPlay: { type: 'string', description: 'The concrete arbitrage action grounded in the cheapest lot / premium / spread.' },
    keyDrivers: { type: 'array', items: { type: 'string' }, description: 'The 2-4 signals that most drove the call.' },
    riskCaveats: { type: 'array', items: { type: 'string' }, description: '1-3 things that would invalidate the read (e.g. only one scrape, no baseline).' },
  },
  required: ['sentiment', 'confidence', 'headline', 'narrative', 'recommendedPlay', 'keyDrivers', 'riskCaveats'],
}

/** Build the user-content payload: identity + the exact computed signals. */
function buildUserContent(e, ctx = {}) {
  const lots = (e.facilities || []).map(f => ({
    lot: f.facilityName,
    eventAvg: f.eventAvgPrice,
    baseline: f.baselinePrice,
    premiumPct: f.premiumPct,
    range: [f.minPrice, f.maxPrice],
    volatility: f.volatility,
    latestSpaces: f.latestSpaces,
    spacesDelta: f.spacesDelta,
    scrapes: f.scrapeCount,
  }))

  const payload = {
    event: e.eventName,
    venue: ctx.venueName || e.venueName || 'Unknown venue',
    date: e.startsAt || e.eventDate || 'TBA',
    source: 'spothero',
    signals: {
      eventAvgPrice: e.eventAvgPrice,
      baselineAvgPrice: e.baselineAvgPrice,
      premiumPct: e.premiumPct,
      crossLotSpreadPct: e.spreadPct,
      priceRange: [e.minPrice, e.maxPrice],
      temporalVolatility: e.volatility,
      multiScrape: e.multiScrape,
      facilityCount: e.facilityCount,
      totalScrapes: e.scrapeCount,
      cheapest: { lot: e.cheapestFacility, price: e.cheapestPrice },
      priciest: { lot: e.priciestFacility, price: e.priciestPrice },
      roiLabel: e.roiLabel,
      roiScore: e.roiScore,
    },
    machineReasons: e.reasons,
    lots,
  }

  return `Analyze the near-term parking-demand sentiment for this event. Use ONLY these scrape-derived numbers.\n\n${JSON.stringify(payload, null, 2)}`
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Call Gemini for one event's sentiment. Returns the parsed structured object
 * plus the model id. Throws if not configured or the call/parse fails — the
 * caller decides how to surface that.
 */
export async function analyzeEventSentiment(e, ctx = {}) {
  const ai = client()
  if (!ai) throw new Error('GEMINI_API_KEY not configured')

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL_ID,
      contents: buildUserContent(e, ctx),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.4,
        // Gemini 2.5 "thinking" spends output tokens before emitting; for a
        // bounded structured payload that just truncates the JSON. Disable it.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 1200,
      },
    })
  )

  const text = (response.text || '').trim()
  if (!text) throw new Error('Gemini returned an empty response')

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // Defensive: strip ```json fences if the model wrapped them despite the schema.
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    parsed = JSON.parse(cleaned)
  }

  // Normalize / clamp.
  parsed.confidence = clamp01(Number(parsed.confidence))
  if (!['Bullish', 'Neutral', 'Bearish'].includes(parsed.sentiment)) parsed.sentiment = 'Neutral'
  parsed.keyDrivers = Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.slice(0, 4) : []
  parsed.riskCaveats = Array.isArray(parsed.riskCaveats) ? parsed.riskCaveats.slice(0, 3) : []

  return { result: parsed, modelId: MODEL_ID }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

/**
 * Retry transient Gemini failures (503 overloaded / 429 rate-limit / network
 * blips) with exponential backoff. Auth/validation errors (4xx other than 429)
 * fail fast — retrying them is pointless.
 */
async function withRetry(fn, { attempts = 4, baseMs = 700 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = err?.status
      const transient = status === 503 || status === 429 || status === 500 || status === undefined
      if (!transient || i === attempts - 1) throw err
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 250)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}
