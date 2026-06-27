import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { analyzeEventSentiment, hashEventSignals, sentimentConfigured, sentimentModelId } from './sentiment.js'

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ---------------------------------------------------------------------------
// Event-stats helpers (used by GET /api/event-stats)
// ---------------------------------------------------------------------------

const _mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const _round2 = n => Math.round(n * 100) / 100
const _round4 = n => Math.round(n * 10000) / 10000

/**
 * Classify an event's arbitrage opportunity from its premium + volatility.
 * Premium (how much pricier than a normal day) is the headline ROI driver;
 * volatility (how much the price swings) is the trade-able movement. The blended
 * score ranks events for the sentiment/arbitrage LLM; the label drives UI color.
 */
function classifyRoi(premiumPct, volatility, spreadPct = 0) {
  const p = premiumPct ?? 0
  const vPct = (volatility ?? 0) * 100
  const sPct = spreadPct ?? 0
  // Premium is the headline ROI driver (how much pricier than a normal day);
  // temporal volatility is the trade-able run-over-run movement; cross-lot spread
  // is secondary headroom. Blend into one rankable score.
  const score = Math.round(p + vPct * 0.5 + sPct * 0.1)
  let label = 'Low'
  if (p >= 40 || volatility >= 0.4) label = 'High'
  else if (p >= 15 || volatility >= 0.15) label = 'Medium'
  return { label, score }
}

/**
 * Turn an event's aggregated scrape stats into precise, LLM-readable reasons.
 * Every sentence is grounded in actual numbers pulled from the snapshots so the
 * downstream sentiment model can cite *why* an event is (or isn't) high-ROI.
 */
function buildEventReasons(ctx) {
  const {
    eventAvg, baselineAvg, premiumPct, spreadMin, spreadMax, spreadPct,
    volatility, multiScrape, facilityCount, cheapest, priciest, facilities,
  } = ctx
  const fmt = n => `$${Number(n).toFixed(2)}`
  const pct = n => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
  const reasons = []

  // 1. Premium vs normal-day baseline — the headline buy signal.
  if (premiumPct !== null && baselineAvg !== null) {
    reasons.push(`Parking averaged ${fmt(eventAvg)} for this event vs a ${fmt(baselineAvg)} normal-day baseline — a ${pct(premiumPct)} event premium.`)
  } else {
    reasons.push(`Parking averaged ${fmt(eventAvg)} across event scrapes. No generic baseline captured for these lots yet, so the premium figure is still pending.`)
  }

  // 2. Cross-lot spread — arbitrage headroom, available even from a single scrape.
  if (cheapest && priciest && cheapest.facilityName !== priciest.facilityName) {
    reasons.push(`Across ${facilityCount} lots, prices span ${fmt(spreadMin)}–${fmt(spreadMax)} (a ${spreadPct.toFixed(0)}% gap) — cheapest: ${cheapest.facilityName} at ${fmt(cheapest.eventAvgPrice)}, priciest: ${priciest.facilityName} at ${fmt(priciest.eventAvgPrice)}.`)
  }

  // 3. Temporal volatility — the run-over-run, date-stamped movement signal.
  if (multiScrape && volatility > 0) {
    reasons.push(`Re-scraped over time, parking for this event has moved ${(volatility * 100).toFixed(0)}% run-over-run — active price discovery as the date approaches.`)
  } else {
    reasons.push(`Captured in a single scrape so far — run-over-run volatility will register once this event is re-scraped closer to the date.`)
  }

  // 4. Biggest inventory drawdown = strongest demand signal.
  const drops = facilities
    .filter(f => f.spacesDelta !== null && f.spacesDelta < 0 && f.minSpaces !== null)
    .sort((a, b) => a.spacesDelta - b.spacesDelta)
  if (drops.length) {
    const d = drops[0]
    reasons.push(`Inventory tightened at ${d.facilityName}: spaces fell to ${d.minSpaces} (${d.spacesDelta}) — a demand signal.`)
  }

  // 5. Strongest single-lot markup.
  const topPrem = facilities
    .filter(f => f.premiumPct !== null)
    .sort((a, b) => b.premiumPct - a.premiumPct)[0]
  if (topPrem && topPrem.premiumPct >= 20) {
    reasons.push(`${topPrem.facilityName} carries the steepest markup at ${pct(topPrem.premiumPct)} over its own baseline.`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// Ticketmaster event surfacing
//
// The events table holds every upcoming show at every tracked venue. Dumping
// that wall undifferentiated is what made the feature feel useless. These
// helpers turn a raw row into an *actionability* view — is it genuinely new, is
// the on-sale window opening soon (the earliest "secure passes early" moment),
// is it already on sale — and a score so the time-sensitive opportunities sort
// to the top. Past events are dropped at the endpoint level.
// ---------------------------------------------------------------------------
const NEW_WINDOW_DAYS  = parseInt(process.env.EVENTS_NEW_DAYS || '10', 10)
// Lead time for "secure early": any event whose on-sale is still in the future is
// a get-ahead opportunity, so this window is wide (a year). It only governs the
// "secure-early" badge/status; the events feed already filters to future on-sale.
const ONSALE_SOON_DAYS = parseInt(process.env.EVENTS_ONSALE_SOON_DAYS || '365', 10)

function startOfTodayMs() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime()
}

// Ticketmaster uses placeholder on-sale dates: 1900-01-01 ("no info") and
// 9999-12-31 ("on-sale not yet scheduled / TBD"). cleanOnsale rejects BOTH so a
// real, plausible date is the only thing that survives for ranking/display.
function cleanOnsale(s) {
  if (!s) return null
  const t = new Date(s).getTime()
  if (Number.isNaN(t)) return null
  const yr = new Date(t).getUTCFullYear()
  if (yr < 2005 || yr > 2100) return null
  return s
}

// For DISPLAY: only a still-in-the-future real on-sale date (a "mark your calendar"
// signal). Past on-sale = noise (tickets already out); placeholders → null.
function futureOnsale(s) {
  const c = cleanOnsale(s)
  return c && new Date(c).getTime() > Date.now() ? c : null
}

// The 9999-style "on-sale TBD" placeholder = tickets scheduled but no date yet.
function isOnsaleTBD(s) {
  if (!s) return false
  const t = new Date(s).getTime()
  return !Number.isNaN(t) && new Date(t).getUTCFullYear() > 2100
}

// "Tickets NOT yet on sale" = a real future on-sale date OR a TBD placeholder.
// (A 1900 placeholder or a real past date means tickets are already out → false.)
function ticketsNotYetOnSale(s) {
  return !!futureOnsale(s) || isOnsaleTBD(s)
}

const ONSALE_RECENT_DAYS = parseInt(process.env.EVENTS_ONSALE_RECENT_DAYS || '7', 10)

function classifyEvent(e, nowMs) {
  const eventMs    = e.event_date    ? new Date(e.event_date).getTime()    : NaN
  const firstSeen  = e.first_seen_at ? new Date(e.first_seen_at).getTime() : NaN
  const onsaleMs   = cleanOnsale(e.onsale_start) ? new Date(e.onsale_start).getTime() : NaN

  const daysUntilEvent  = Number.isNaN(eventMs)   ? null : Math.ceil((eventMs  - nowMs) / 86_400_000)
  const daysSinceSeen   = Number.isNaN(firstSeen) ? null : Math.floor((nowMs   - firstSeen) / 86_400_000)
  const daysUntilOnsale = Number.isNaN(onsaleMs)  ? null : Math.ceil((onsaleMs - nowMs) / 86_400_000)

  const onsaleUpcoming   = !Number.isNaN(onsaleMs) && onsaleMs > nowMs
  const onsaleSoon       = onsaleUpcoming && daysUntilOnsale != null && daysUntilOnsale <= ONSALE_SOON_DAYS
  const onsaleJustOpened = !Number.isNaN(onsaleMs) && onsaleMs <= nowMs && (nowMs - onsaleMs) <= ONSALE_RECENT_DAYS * 86_400_000
  // Tickets that went on sale a while ago — there's no "secure early" left, and an
  // event whose tickets sold weeks ago is NOT newly announced no matter when WE
  // first saw it (our first_seen reflects discovery time, not TM's announcement).
  const onsaleStale      = !Number.isNaN(onsaleMs) && (nowMs - onsaleMs) > ONSALE_RECENT_DAYS * 86_400_000

  // "Newly announced" requires a VALID on-sale date. Without one we can't tell a
  // genuinely-fresh announcement from an old event we merely discovered late
  // (first_seen is our import time, not TM's announcement). So bogus/unknown
  // on-sale (e.g. 1900 placeholder) → plain "upcoming", not a false "new" badge.
  const isNew = daysSinceSeen != null && daysSinceSeen <= NEW_WINDOW_DAYS && !onsaleStale && !Number.isNaN(onsaleMs)

  const tags = []
  if (isNew) tags.push('new')
  if (onsaleSoon) tags.push('onsale-soon')
  else if (onsaleUpcoming) tags.push('onsale-scheduled')
  if (onsaleJustOpened) tags.push('onsale-open')

  let status = 'upcoming'
  if (onsaleSoon) status = 'secure-early'
  else if (onsaleJustOpened) status = 'on-sale-now'
  else if (isNew) status = 'newly-announced'

  // Rank by ACTIONABILITY, not event proximity. A future on-sale (you can still
  // get ahead of the parking rush) is the top tier — sooner = more urgent. Then
  // just-opened sales, then freshly-announced. Event proximity is only a faint
  // tiebreaker so already-on-sale games happening tomorrow don't crowd out the
  // genuinely actionable stuff.
  let score = 0
  if (onsaleSoon)            score += 1000 - Math.min(daysUntilOnsale ?? 0, 120)
  else if (onsaleJustOpened) score += 500
  if (isNew)                 score += 200 - Math.min(daysSinceSeen ?? 0, 30)
  if (daysUntilEvent != null) score += Math.max(0, 90 - Math.min(daysUntilEvent, 90)) * 0.1

  return { daysUntilEvent, daysSinceSeen, daysUntilOnsale, isNew, onsaleSoon, onsaleJustOpened, tags, status, score }
}

// Collapse multi-date runs of the SAME event (a residency / a 30-night show like
// the Christmas Spectacular is 30 separate Ticketmaster events sharing one on-sale
// date) into ONE representative card, so the feed shows distinct opportunities
// rather than 30 identical rows. Keeps the highest-scored row (earliest date on a
// tie) and attaches performanceCount + the date range.
function collapseEventRuns(rows, { nameKey, venueKey, dateKey, scoreKey = '_score', repBy = 'score' }) {
  const groups = new Map()
  for (const r of rows) {
    const key = `${String(r[nameKey] || '').toLowerCase()}|${r[venueKey] || ''}`
    const g = groups.get(key)
    if (!g) { groups.set(key, { rep: r, count: 1, first: r[dateKey], last: r[dateKey] }); continue }
    g.count++
    if (r[dateKey] < g.first) g.first = r[dateKey]
    if (r[dateKey] > g.last)  g.last = r[dateKey]
    // repBy 'first' keeps the first-encountered row as representative (caller
    // pre-sorts, e.g. by date → earliest performance wins); 'score' keeps the
    // highest-scored (earliest date breaks ties).
    if (repBy === 'score') {
      const better = r[scoreKey] > g.rep[scoreKey] ||
        (r[scoreKey] === g.rep[scoreKey] && new Date(r[dateKey]) < new Date(g.rep[dateKey]))
      if (better) g.rep = r
    }
  }
  return [...groups.values()].map(g => ({ ...g.rep, performanceCount: g.count, firstDate: g.first, lastDate: g.last }))
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Parking Arbitrage API',
    endpoints: {
      health: '/health',
      metrics: '/api/metrics',
      venues: '/api/venues',
      events: '/api/events',
      facilityStats: '/api/facility-stats',
      eventStats: '/api/event-stats',
      eventSentiment: '/api/event-sentiment/:eventId',
      priceHistory: '/api/price-history?venueId=&days=7',
      alerts: '/api/alerts',
      venueDetail: '/api/venue/:id'
    }
  })
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// GET /api/metrics - Key performance indicators
app.get('/api/metrics', async (req, res) => {
  try {
    console.log('📊 /api/metrics called')
    const { source } = req.query
    let metricsQuery = supabase
      .from('snapshots')
      .select('total_price, available_spaces, venue_id, facility_id')
      .order('scraped_at', { ascending: false })
      .limit(500)
    if (source) metricsQuery = metricsQuery.eq('source', source)
    const { data: snapshots, error: snapshotsError } = await metricsQuery

    if (snapshotsError) {
      console.error('❌ Snapshots query failed:', snapshotsError)
      return res.status(500).json({ error: `Snapshots query failed: ${snapshotsError.message}` })
    }

    const { data: venues, error: venuesError } = await supabase.from('venues').select('id, name')

    if (venuesError) {
      console.error('❌ Venues query failed:', venuesError)
      return res.status(500).json({ error: `Venues query failed: ${venuesError.message}` })
    }

    if (!snapshots || snapshots.length === 0) {
      return res.json({
        avgPrice: '$0.00',
        venuesTracked: venues?.length || 0,
        availableSpots: 0,
        bestDeal: { price: '$0.00', venue: 'N/A' },
      })
    }

    // Calculate metrics
    const avgPrice = snapshots.reduce((sum, s) => sum + (s.total_price || 0), 0) / snapshots.length
    const venuesTracked = new Set(snapshots.map(s => s.venue_id)).size
    const totalSpots = snapshots.reduce((sum, s) => sum + (s.available_spaces || 0), 0)

    // Find best deal
    const bestSnapshot = snapshots.reduce((best, s) =>
      (s.total_price || Infinity) < (best.total_price || Infinity) ? s : best
    )
    const bestVenue = venues?.find(v => v.id === bestSnapshot.venue_id)

    res.json({
      avgPrice: `$${avgPrice.toFixed(2)}`,
      venuesTracked,
      availableSpots: totalSpots,
      bestDeal: {
        price: `$${bestSnapshot.total_price?.toFixed(2) || '0.00'}`,
        venue: bestVenue?.name || 'Unknown',
      },
    })
  } catch (error) {
    console.error('Metrics error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/venues - All venues with current pricing
app.get('/api/venues', async (req, res) => {
  try {
    const { data: venues } = await supabase.from('venues').select('id, name, lat, lon')

    if (!venues) return res.json([])

    // Get latest snapshot for each venue
    const venuesWithPrices = await Promise.all(
      venues.map(async (venue) => {
        const { data: latestSnapshot } = await supabase
          .from('snapshots')
          .select('total_price, available_spaces, scraped_at, city, state')
          .eq('venue_id', venue.id)
          .order('scraped_at', { ascending: false })
          .limit(1)
          .single()

        const { data: previousSnapshots } = await supabase
          .from('snapshots')
          .select('total_price')
          .eq('venue_id', venue.id)
          .order('scraped_at', { ascending: false })
          .limit(2)

        const previousSnapshot = previousSnapshots?.[1] || null

        const avgPrice = latestSnapshot?.total_price || 0
        const prevPrice = previousSnapshot?.total_price || avgPrice
        const trend = avgPrice > prevPrice ? 'up' : avgPrice < prevPrice ? 'down' : 'neutral'

        return {
          id: venue.id,
          name: venue.name,
          city: latestSnapshot?.city || 'Unknown',
          state: latestSnapshot?.state || '',
          avgPrice: parseFloat(avgPrice.toFixed(2)),
          availableSpots: latestSnapshot?.available_spaces || 0,
          trend,
          lastUpdated: latestSnapshot?.scraped_at ? new Date(latestSnapshot.scraped_at).toLocaleTimeString() : 'N/A',
        }
      })
    )

    res.json(venuesWithPrices)
  } catch (error) {
    console.error('Venues error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/ticketmaster-events - The "newly discovered" feed: ONLY genuinely
// actionable upcoming events (freshly announced, on-sale opening soon, or just
// opened), newest discoveries first. Past events and the venue's static back
// catalogue are filtered out so this reads as a heads-up list, not a dump.
app.get('/api/ticketmaster-events', async (req, res) => {
  try {
    const nowMs = Date.now()
    const todayMs = startOfTodayMs()
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)

    const { data: rawEvents } = await supabase
      .from('events')
      .select('id, venue_id, event_name, event_date, onsale_start, public_visibility_start, first_seen_at, source_url, created_at, ticketmaster_id')
      .not('ticketmaster_id', 'is', null)   // Ticketmaster-sourced ONLY — the SpotHero scraper also writes this table (spothero.com URLs), which is what produced the broken "View on Ticketmaster" links.
      .order('first_seen_at', { ascending: false, nullsFirst: false })
      .limit(300)

    if (!rawEvents || rawEvents.length === 0) return res.json([])

    const { data: allVenues } = await supabase.from('venues').select('id, name')
    const venueMap = Object.fromEntries((allVenues || []).map(v => [v.id, v.name]))

    const out = []
    for (const e of rawEvents) {
      const eventMs = e.event_date ? new Date(e.event_date).getTime() : NaN
      if (!Number.isNaN(eventMs) && eventMs < todayMs) continue // upcoming only
      const c = classifyEvent(e, nowMs)
      if (!c.isNew && !c.onsaleSoon && !c.onsaleJustOpened) continue // actionable only
      out.push({
        id: e.id,
        venue_id: e.venue_id,
        venue_name: venueMap[e.venue_id] || 'Unknown Venue',
        event_name: e.event_name,
        event_date: e.event_date,
        onsale_start: futureOnsale(e.onsale_start),
        source_url: e.source_url,
        created_at: e.created_at,
        discoveredAt: e.first_seen_at || e.created_at || null,
        status: c.status,
        tags: c.tags,
        isNew: c.isNew,
        onsaleSoon: c.onsaleSoon,
        daysUntilEvent: c.daysUntilEvent,
        daysUntilOnsale: c.daysUntilOnsale,
        _score: c.score,
      })
    }

    const collapsed = collapseEventRuns(out, { nameKey: 'event_name', venueKey: 'venue_id', dateKey: 'event_date' })
    collapsed.sort((a, b) => (b._score - a._score) || (new Date(a.event_date) - new Date(b.event_date)))
    collapsed.forEach(x => delete x._score)
    res.json(collapsed.slice(0, limit))
  } catch (error) {
    console.error('Ticketmaster events error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/events - "Secure early" feed: ONLY events whose tickets are not yet on
// sale (on-sale date still in the future). These are the genuine get-ahead-of-it
// opportunities — grab parking before tickets drop and demand spikes. Ranked by
// soonest on-sale first. Today there are ~2 (e.g. Christmas Spectacular, NY Comic
// Con); the feed grows as venues announce new shows. ?all=1 returns every upcoming
// event (the full calendar) instead.
app.get('/api/events', async (req, res) => {
  try {
    const includePast = req.query.includePast === '1'
    const showAll = req.query.all === '1'
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 300)
    const nowMs = Date.now()
    const todayMs = startOfTodayMs()

    // Secure-early mode: filter "tickets not yet on sale" in the QUERY, not after a
    // date-ordered limit. `onsale_start > now()` matches future real dates AND the
    // 9999 TBD placeholder, while excluding past/1900/null. Critically, doing it in
    // SQL means far-future shows (a November residency, an October convention) can't
    // be cut off by the row limit — which was leaving only a near-term event in the
    // feed. ?all=1 returns the full upcoming calendar by date instead.
    let q = supabase
      .from('events')
      .select('id, venue_id, event_name, event_date, onsale_start, public_visibility_start, first_seen_at, created_at, source_url, ticketmaster_id')
      .not('ticketmaster_id', 'is', null)   // Ticketmaster-sourced ONLY (this table also holds SpotHero-scraped events with spothero.com URLs).
    if (!showAll) q = q.gt('onsale_start', new Date(nowMs).toISOString())
    const { data: rawEvents } = await q
      .order(showAll ? 'event_date' : 'onsale_start', { ascending: true })
      .limit(showAll ? 500 : 1000)

    if (!rawEvents || rawEvents.length === 0) return res.json([])

    const { data: allVenues } = await supabase.from('venues').select('id, name')
    const venueMap = Object.fromEntries((allVenues || []).map(v => [v.id, v.name]))

    const enriched = []
    for (const e of rawEvents) {
      const eventMs = e.event_date ? new Date(e.event_date).getTime() : NaN
      if (!includePast && !Number.isNaN(eventMs) && eventMs < todayMs) continue // drop past events
      if (!showAll && !ticketsNotYetOnSale(e.onsale_start)) continue // secure-early only: tickets not yet on sale (future date or TBD)
      const c = classifyEvent(e, nowMs)
      enriched.push({
        id: e.id,
        name: e.event_name,
        venue: venueMap[e.venue_id] || 'Unknown Venue',
        venueId: e.venue_id,
        eventDate: e.event_date,
        date: e.event_date,            // legacy field name read by some components
        onSaleDate: futureOnsale(e.onsale_start),
        onsaleTBD: isOnsaleTBD(e.onsale_start),
        sourceUrl: e.source_url,
        // When discovery first saw this event (first_seen_at), falling back to the
        // row's creation time. Drives the "Discovered" stamp + filter on the UI.
        discoveredAt: e.first_seen_at || e.created_at || null,
        ticketmasterId: e.ticketmaster_id,
        // In the secure-early feed every event is "tickets not yet on sale" → badge it as such.
        status: showAll ? c.status : 'secure-early',
        tags: c.tags,
        isNew: c.isNew,
        onsaleSoon: c.onsaleSoon,
        daysUntilEvent: c.daysUntilEvent,
        daysUntilOnsale: c.daysUntilOnsale,
        _score: c.score,
      })
    }

    // Rank by soonest ON-SALE first (when tickets drop = when to act). Events with
    // a concrete future on-sale come first by that date; TBD-on-sale events fall to
    // the end (by event date). ?all=1 (full calendar) sorts by soonest event date.
    const sortKey = showAll
      ? (a, b) => new Date(a.eventDate) - new Date(b.eventDate)
      : (a, b) => {
          if (a.onSaleDate && b.onSaleDate) return new Date(a.onSaleDate) - new Date(b.onSaleDate)
          if (a.onSaleDate) return -1
          if (b.onSaleDate) return 1
          return new Date(a.eventDate) - new Date(b.eventDate)
        }
    enriched.sort(sortKey)
    const collapsed = collapseEventRuns(enriched, { nameKey: 'name', venueKey: 'venueId', dateKey: 'eventDate', repBy: 'first' })
    collapsed.sort(sortKey)
    collapsed.forEach(x => delete x._score)
    res.json(collapsed.slice(0, limit))
  } catch (error) {
    console.error('Events error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/price-history - Historical pricing data
app.get('/api/price-history', async (req, res) => {
  try {
    const { venueId, days = 7, source } = req.query
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - parseInt(days))

    // Paginate past PostgREST's 1000-row cap so multi-venue / multi-day windows aren't truncated.
    let snapshots = []
    const PAGE_SIZE = 1000
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase
        .from('snapshots')
        .select('scraped_at, total_price, venue_id')
        .gte('scraped_at', startDate.toISOString())

      if (venueId) {
        query = query.eq('venue_id', venueId)
      }
      if (source) {
        query = query.eq('source', source)
      }

      const { data: page } = await query
        .order('scraped_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)

      if (!page || page.length === 0) break
      snapshots = snapshots.concat(page)
      if (page.length < PAGE_SIZE) break
    }

    if (!snapshots || snapshots.length === 0) return res.json([])

    // Group by day and calculate average
    const grouped = snapshots.reduce((acc, snapshot) => {
      const date = new Date(snapshot.scraped_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })

      if (!acc[date]) {
        acc[date] = { prices: [], date }
      }
      acc[date].prices.push(snapshot.total_price || 0)
      return acc
    }, {})

    const history = Object.values(grouped).map(day => ({
      date: day.date,
      price: parseFloat((day.prices.reduce((a, b) => a + b, 0) / day.prices.length).toFixed(2)),
    }))

    res.json(history)
  } catch (error) {
    console.error('Price history error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/snapshots - Venue price trends with classification
app.get('/api/snapshots', async (req, res) => {
  try {
    // Fetch all venues to map venue_id
    const { data: allVenues } = await supabase
      .from('venues')
      .select('id, name')

    const venueMap = {}
    if (allVenues) {
      for (const v of allVenues) {
        venueMap[v.name] = v.id
      }
    }

    // Optional source filter (e.g. ?source=way) — omitted = all sources.
    const { source } = req.query

    // PostgREST caps each request at 1000 rows, so paginate to fetch ALL snapshots.
    // Without this, only the first 1000 rows (a handful of venues) are ever returned.
    let snapshots = []
    let snapshotError = null
    const PAGE_SIZE = 1000
    for (let from = 0; ; from += PAGE_SIZE) {
      let pageQuery = supabase
        .from('snapshots')
        .select('venue_id, total_price, available_spaces, scraped_at')
        .order('venue_id', { ascending: true })
        .order('scraped_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (source) pageQuery = pageQuery.eq('source', source)
      const { data: page, error } = await pageQuery

      if (error) {
        snapshotError = error
        break
      }
      if (!page || page.length === 0) break
      snapshots = snapshots.concat(page)
      if (page.length < PAGE_SIZE) break
    }

    if (snapshotError) {
      console.error('Snapshots query error:', snapshotError)
      return res.status(500).json({ error: snapshotError.message })
    }

    if (!snapshots || snapshots.length === 0) {
      return res.json({
        venues: [],
        chartData: [],
        message: 'Monitoring started. Price trends will appear after the first few scraper runs.',
      })
    }

    // Create venue ID to name map
    const venueIdMap = {}
    if (allVenues) {
      for (const v of allVenues) {
        venueIdMap[v.id] = v.name
      }
    }

    // Group by venue_id
    const groupedByVenueId = {}
    for (const snap of snapshots) {
      const venueId = snap.venue_id
      const venueName = venueIdMap[venueId] || 'Unknown'
      const price = snap.total_price || 0
      const spaces = snap.available_spaces || 0

      if (!groupedByVenueId[venueId]) {
        groupedByVenueId[venueId] = { name: venueName, snapshots: [] }
      }
      groupedByVenueId[venueId].snapshots.push({
        price,
        spaces,
        scraped_at: snap.scraped_at,
      })
    }

    // Classify each venue and prepare chart data
    const venues = []
    const chartDataByTimestamp = {}

    for (const [venueId, venueData] of Object.entries(groupedByVenueId)) {
      const snapshots = venueData.snapshots
      const venueName = venueData.name
      // Skip venues with insufficient data (< 2 snapshots)
      if (snapshots.length < 2) {
        venues.push({
          id: venueId,
          name: venueName,
          classification: 'insufficient_data',
          color: '#9ca3af',
          snapshotCount: snapshots.length,
        })
        continue
      }

      // Calculate price deltas
      const deltas = []
      for (let i = 1; i < snapshots.length; i++) {
        const delta = snapshots[i].price - snapshots[i - 1].price
        deltas.push(delta)
      }

      // Classify: positive trend, negative trend, flat, or volatile
      const avgPrice = snapshots.reduce((sum, s) => sum + s.price, 0) / snapshots.length
      const priceRange = Math.max(...snapshots.map(s => s.price)) - Math.min(...snapshots.map(s => s.price))
      const volatility = priceRange / avgPrice // coefficient of variation

      let classification = 'low_activity_flat'
      let color = '#9ca3af' // grey

      if (volatility > 0.15) {
        // High volatility
        classification = 'volatile'
        color = '#eab308' // yellow
      } else if (Math.min(...deltas) >= -0.5 && Math.max(...deltas) > 0.5) {
        // Consistently positive
        classification = 'high_activity_positive'
        color = '#22c55e' // green
      } else if (Math.max(...deltas) <= 0.5 && Math.min(...deltas) < -0.5) {
        // Consistently negative
        classification = 'high_activity_negative'
        color = '#ef4444' // red
      }

      venues.push({
        id: venueId,
        name: venueName,
        classification,
        color,
        snapshotCount: snapshots.length,
        avgPrice: parseFloat(avgPrice.toFixed(2)),
        minPrice: Math.min(...snapshots.map(s => s.price)),
        maxPrice: Math.max(...snapshots.map(s => s.price)),
      })

      // Add to chart data
      for (const snap of snapshots) {
        const timestamp = new Date(snap.scraped_at).toISOString().split('T')[0]
        if (!chartDataByTimestamp[timestamp]) {
          chartDataByTimestamp[timestamp] = { time: timestamp }
        }
        chartDataByTimestamp[timestamp][venueName] = snap.price
      }
    }

    // Convert to array and sort by time
    const chartData = Object.values(chartDataByTimestamp).sort(
      (a, b) => new Date(a.time) - new Date(b.time)
    )

    res.json({
      venues: venues.sort((a, b) => a.name.localeCompare(b.name)),
      chartData,
    })
  } catch (error) {
    console.error('Snapshots error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/facility-stats - Table-based price trends.
// Reads the facility_stats summary layer directly (no raw-snapshot loops).
// Returns venues, each with a price rollup and its facility rows.
app.get('/api/facility-stats', async (req, res) => {
  try {
    // Optional source filter (e.g. ?source=way) — omitted = all sources.
    const { source } = req.query

    // Fetch all stats rows (paginate past PostgREST's 1000-row cap, though
    // facility_stats is ~750 rows total this is future-proofing).
    let stats = []
    const PAGE_SIZE = 1000
    for (let from = 0; ; from += PAGE_SIZE) {
      let pageQuery = supabase
        .from('facility_stats')
        .select('*')
        .order('venue_id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (source) pageQuery = pageQuery.eq('source', source)
      const { data: page, error } = await pageQuery
      if (error) {
        console.error('facility_stats query error:', error)
        return res.status(500).json({ error: error.message })
      }
      if (!page || page.length === 0) break
      stats = stats.concat(page)
      if (page.length < PAGE_SIZE) break
    }

    if (stats.length === 0) {
      return res.json({
        venues: [],
        message: 'No facility stats yet. Run the scraper or backfill-facility-stats.js.',
      })
    }

    const { data: allVenues } = await supabase.from('venues').select('id, name')
    const venueNameMap = {}
    for (const v of allVenues || []) venueNameMap[v.id] = v.name

    // Group facility rows under their venue
    const byVenue = {}
    for (const s of stats) {
      if (!byVenue[s.venue_id]) {
        byVenue[s.venue_id] = {
          id: s.venue_id,
          name: venueNameMap[s.venue_id] || 'Unknown',
          facilities: [],
        }
      }
      byVenue[s.venue_id].facilities.push({
        facilityId: s.facility_id,
        facilityName: s.facility_name,
        address: s.address,
        walkingMeters: s.walking_meters,
        latestPrice: s.latest_price !== null ? Number(s.latest_price) : null,
        prevPrice: s.prev_price !== null ? Number(s.prev_price) : null,
        priceDelta: s.price_delta !== null ? Number(s.price_delta) : 0,
        priceDeltaPct: s.price_delta_pct !== null ? Number(s.price_delta_pct) : 0,
        latestSpaces: s.latest_spaces,
        prevSpaces: s.prev_spaces,
        spacesDelta: s.spaces_delta,
        minPrice: s.min_price !== null ? Number(s.min_price) : null,
        maxPrice: s.max_price !== null ? Number(s.max_price) : null,
        avgPrice: s.avg_price !== null ? Number(s.avg_price) : null,
        volatility: s.volatility !== null ? Number(s.volatility) : 0,
        trend: s.trend,
        priceHistory: Array.isArray(s.price_history) ? s.price_history.map(Number) : [],
        scrapeCount: s.scrape_count,
        lastScrapedAt: s.last_scraped_at,
        genericAvgPrice: s.generic_avg_price !== null ? Number(s.generic_avg_price) : null,
        genericCount: s.generic_count || 0,
        eventAvgPrice: s.event_avg_price !== null ? Number(s.event_avg_price) : null,
        eventCount: s.event_count || 0,
        eventPremiumPct: s.event_premium_pct !== null ? Number(s.event_premium_pct) : null,
      })
    }

    // Build venue-level rollup (price spread across that venue's lots)
    const venues = Object.values(byVenue).map(v => {
      const prices = v.facilities.map(f => f.latestPrice).filter(p => p !== null && p > 0)
      const vols = v.facilities.map(f => f.volatility).filter(x => typeof x === 'number')
      const premiums = v.facilities.map(f => f.eventPremiumPct).filter(x => x !== null && x !== undefined)
      const maxPremium = premiums.length ? Math.max(...premiums) : null
      const minPrice = prices.length ? Math.min(...prices) : null
      const maxPrice = prices.length ? Math.max(...prices) : null
      const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null
      const cheapest = v.facilities
        .filter(f => f.latestPrice !== null)
        .sort((a, b) => a.latestPrice - b.latestPrice)[0]
      return {
        id: v.id,
        name: v.name,
        facilityCount: v.facilities.length,
        minPrice: minPrice !== null ? parseFloat(minPrice.toFixed(2)) : null,
        maxPrice: maxPrice !== null ? parseFloat(maxPrice.toFixed(2)) : null,
        avgPrice: avgPrice !== null ? parseFloat(avgPrice.toFixed(2)) : null,
        // Spread = arbitrage headroom between cheapest and priciest lot at the venue
        spread: minPrice !== null && maxPrice !== null ? parseFloat((maxPrice - minPrice).toFixed(2)) : null,
        avgVolatility: vols.length ? parseFloat((vols.reduce((a, b) => a + b, 0) / vols.length).toFixed(4)) : 0,
        // Strongest event premium among this venue's lots (the headline buy signal)
        maxEventPremiumPct: maxPremium !== null ? parseFloat(maxPremium.toFixed(2)) : null,
        cheapestFacility: cheapest ? cheapest.facilityName : null,
        // Facilities sorted cheapest → priciest for the table
        facilities: v.facilities.sort((a, b) => (a.latestPrice ?? Infinity) - (b.latestPrice ?? Infinity)),
      }
    })

    // Venues sorted by name
    venues.sort((a, b) => a.name.localeCompare(b.name))

    res.json({ venues })
  } catch (error) {
    console.error('facility-stats error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/facility-price-log/:venueId/:facilityId
// The run-by-run price trajectory for ONE parking lot. Powers the drill-down
// history table and is the time-series input for the LLM buy/wait model.
app.get('/api/facility-price-log/:venueId/:facilityId', async (req, res) => {
  try {
    const { venueId, facilityId } = req.params
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500)

    const { data, error } = await supabase
      .from('facility_price_log')
      .select('id, run_id, scraped_at, price, spaces, prev_price, price_delta, price_delta_pct, prev_spaces, spaces_delta, event_id')
      .eq('venue_id', venueId)
      .eq('facility_id', facilityId)
      .order('scraped_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('facility-price-log query error:', error)
      return res.status(500).json({ error: error.message })
    }

    const log = (data || []).map(r => ({
      runId: r.run_id,
      scrapedAt: r.scraped_at,
      price: r.price !== null ? Number(r.price) : null,
      spaces: r.spaces,
      prevPrice: r.prev_price !== null ? Number(r.prev_price) : null,
      priceDelta: r.price_delta !== null ? Number(r.price_delta) : null,
      priceDeltaPct: r.price_delta_pct !== null ? Number(r.price_delta_pct) : null,
      prevSpaces: r.prev_spaces,
      spacesDelta: r.spaces_delta,
      isEventContext: r.event_id !== null,
    }))

    res.json({ venueId, facilityId, count: log.length, log })
  } catch (error) {
    console.error('facility-price-log error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/event-stats - Per-EVENT price volatility & ROI, grouped by venue.
//
// Where /api/facility-stats answers "how does each lot behave in general",
// THIS answers "how does parking behave for a SPECIFIC named event at a venue"
// (e.g. "Raiders vs. Titans at Allegiant Stadium, Dec 27"). It aggregates only
// event-context snapshots (snapshots.event_id set), groups them by event, and
// contrasts each event's average price against the lot's generic baseline
// (facility_stats.generic_avg_price). The output is a ranked, *explainable* feed
// of high-ROI events — each row carries scrape-derived "why" reasons — that the
// sentiment/arbitrage LLM consumes directly.
// Shared aggregation: turns event-context snapshots into per-event signals.
// Used by BOTH /api/event-stats (the table) and the /api/event-sentiment
// endpoints (the LLM input) so the model reads the EXACT numbers the UI shows —
// one source of truth, no drift. Returns { venues, events, venueNameMap }.
async function computeEventStats(source = null) {
  {
    // 1. Venues (id → name)
    const { data: allVenues } = await supabase.from('venues').select('id, name')
    const venueNameMap = {}
    for (const v of allVenues || []) venueNameMap[v.id] = v.name

    // 2. Events (identity + timing)
    let events = []
    const EV_PAGE = 1000
    for (let from = 0; ; from += EV_PAGE) {
      const { data: page, error } = await supabase
        .from('events')
        .select('id, venue_id, event_name, event_date, starts_at, ends_at, source_url')
        .order('event_date', { ascending: true })
        .range(from, from + EV_PAGE - 1)
      if (error) throw new Error(error.message)
      if (!page || page.length === 0) break
      events = events.concat(page)
      if (page.length < EV_PAGE) break
    }
    const eventMap = {}
    for (const e of events) eventMap[e.id] = e

    // 3. Event-context snapshots only (event_id set). Paginate past the 1000 cap.
    let snaps = []
    const SN_PAGE = 1000
    for (let from = 0; ; from += SN_PAGE) {
      let snapQuery = supabase
        .from('snapshots')
        .select('event_id, venue_id, facility_id, facility_name, total_price, available_spaces, scraped_at')
        .not('event_id', 'is', null)
        .order('event_id', { ascending: true })
        .order('scraped_at', { ascending: true })
        .range(from, from + SN_PAGE - 1)
      if (source) snapQuery = snapQuery.eq('source', source) // scope to one platform
      const { data: page, error } = await snapQuery
      if (error) throw new Error(error.message)
      if (!page || page.length === 0) break
      snaps = snaps.concat(page)
      if (page.length < SN_PAGE) break
    }

    if (snaps.length === 0) {
      return {
        venues: [],
        events: [],
        venueNameMap,
        message: 'No event-context pricing captured yet. Once the scraper runs with resolved destination_ids, event scrapes will populate this view.',
      }
    }

    // 4. Generic baselines from facility_stats (per lot)
    let stats = []
    const ST_PAGE = 1000
    for (let from = 0; ; from += ST_PAGE) {
      let statQuery = supabase
        .from('facility_stats')
        .select('venue_id, facility_id, generic_avg_price')
        .range(from, from + ST_PAGE - 1)
      // Match the baseline to the same platform so the premium is apples-to-apples
      // (a facility_id can recur across sources under different pricing).
      if (source) statQuery = statQuery.eq('source', source)
      const { data: page, error } = await statQuery
      if (error) break // baselines are optional; premiums just show as pending
      if (!page || page.length === 0) break
      stats = stats.concat(page)
      if (page.length < ST_PAGE) break
    }
    const baselineMap = {}
    for (const s of stats) {
      baselineMap[`${s.venue_id}::${s.facility_id}`] =
        s.generic_avg_price !== null ? Number(s.generic_avg_price) : null
    }

    // 5. Group event-context snapshots by event_id
    const byEvent = {}
    for (const s of snaps) {
      if (!byEvent[s.event_id]) byEvent[s.event_id] = []
      byEvent[s.event_id].push(s)
    }

    // 6. Aggregate each event into volatility + premium + ROI + reasons
    const eventStats = []
    for (const [eventId, rows] of Object.entries(byEvent)) {
      const ev = eventMap[eventId]
      if (!ev) continue // orphaned event_id (event row deleted)

      // group this event's snapshots by facility (chronological within facility)
      const byFac = {}
      for (const r of rows) {
        const k = String(r.facility_id)
        if (!byFac[k]) byFac[k] = { facilityId: k, facilityName: r.facility_name, prices: [], spaces: [] }
        const p = Number(r.total_price)
        if (p > 0) byFac[k].prices.push(p)
        if (typeof r.available_spaces === 'number') byFac[k].spaces.push(r.available_spaces)
      }

      const facilities = []
      let maxObs = 0 // most observations any single lot has → tells us if temporal vol is measurable
      for (const f of Object.values(byFac)) {
        if (!f.prices.length) continue
        maxObs = Math.max(maxObs, f.prices.length)
        const fAvg = _mean(f.prices)
        const fMin = Math.min(...f.prices)
        const fMax = Math.max(...f.prices)
        // Per-lot TEMPORAL volatility: how this one lot's price moved across its
        // own scrape runs for this event. 0 with a single observation.
        const fVol = fAvg > 0 ? (fMax - fMin) / fAvg : 0
        const baseline = baselineMap[`${ev.venue_id}::${f.facilityId}`] ?? null
        const premiumPct = baseline && baseline > 0 ? ((fAvg - baseline) / baseline) * 100 : null
        const latestSpaces = f.spaces.length ? f.spaces[f.spaces.length - 1] : null
        const firstSpaces = f.spaces.length ? f.spaces[0] : null
        const minSpaces = f.spaces.length ? Math.min(...f.spaces) : null
        const spacesDelta = latestSpaces !== null && firstSpaces !== null ? latestSpaces - firstSpaces : null
        facilities.push({
          facilityId: f.facilityId,
          facilityName: f.facilityName,
          eventAvgPrice: _round2(fAvg),
          minPrice: _round2(fMin),
          maxPrice: _round2(fMax),
          latestPrice: _round2(f.prices[f.prices.length - 1]),
          volatility: _round4(fVol),
          obsCount: f.prices.length,
          baselinePrice: baseline !== null ? _round2(baseline) : null,
          premiumPct: premiumPct !== null ? _round2(premiumPct) : null,
          latestSpaces,
          minSpaces,
          spacesDelta,
          scrapeCount: f.prices.length,
        })
      }
      if (!facilities.length) continue

      // Event price level = mean across every observation (all lots, all runs).
      const allPrices = rows.map(r => Number(r.total_price)).filter(p => p > 0)
      const eventAvg = _mean(allPrices)

      // CROSS-LOT SPREAD: dispersion between the cheapest and priciest lot at this
      // event (arbitrage headroom). This is a snapshot-in-time gap, NOT volatility —
      // it's available from a single scrape.
      const lotPrices = facilities.map(f => f.eventAvgPrice)
      const spreadMin = Math.min(...lotPrices)
      const spreadMax = Math.max(...lotPrices)
      const spreadPct = eventAvg > 0 ? ((spreadMax - spreadMin) / eventAvg) * 100 : 0

      // TEMPORAL VOLATILITY: run-over-run price movement for this event, averaged
      // across lots. 0 until an event is re-scraped; grows as date-stamped history
      // accumulates. This is the "between scrape N and N+1" signal.
      const multiScrape = maxObs >= 2
      const eventVol = multiScrape ? _mean(facilities.map(f => f.volatility)) : 0

      // PREMIUM over MATCHED lots only (lots that have a generic baseline), so the
      // event-vs-normal comparison is apples-to-apples.
      const matched = facilities.filter(f => f.baselinePrice !== null)
      const baselineAvg = matched.length ? _mean(matched.map(f => f.baselinePrice)) : null
      const matchedEventAvg = matched.length ? _mean(matched.map(f => f.eventAvgPrice)) : null
      const premiumPct =
        baselineAvg && baselineAvg > 0 && matchedEventAvg !== null
          ? ((matchedEventAvg - baselineAvg) / baselineAvg) * 100
          : null

      const times = rows.map(r => r.scraped_at).sort()
      const cheapest = [...facilities].sort((a, b) => a.eventAvgPrice - b.eventAvgPrice)[0]
      const priciest = [...facilities].sort((a, b) => b.eventAvgPrice - a.eventAvgPrice)[0]

      const roi = classifyRoi(premiumPct, eventVol, spreadPct)
      const reasons = buildEventReasons({
        eventAvg, baselineAvg, premiumPct, spreadMin, spreadMax, spreadPct,
        volatility: eventVol, multiScrape, facilityCount: facilities.length,
        cheapest, priciest, facilities,
      })

      eventStats.push({
        eventId,
        venueId: ev.venue_id,
        venueName: venueNameMap[ev.venue_id] || 'Unknown',
        eventName: ev.event_name,
        eventDate: ev.event_date,
        startsAt: ev.starts_at,
        sourceUrl: ev.source_url,
        eventAvgPrice: _round2(eventAvg),
        minPrice: _round2(spreadMin),
        maxPrice: _round2(spreadMax),
        spreadPct: _round2(spreadPct),
        volatility: _round4(eventVol),
        multiScrape,
        baselineAvgPrice: baselineAvg !== null ? _round2(baselineAvg) : null,
        premiumPct: premiumPct !== null ? _round2(premiumPct) : null,
        facilityCount: facilities.length,
        scrapeCount: rows.length,
        firstScrapedAt: times[0],
        lastScrapedAt: times[times.length - 1],
        cheapestFacility: cheapest ? cheapest.facilityName : null,
        cheapestPrice: cheapest ? cheapest.eventAvgPrice : null,
        priciestFacility: priciest ? priciest.facilityName : null,
        priciestPrice: priciest ? priciest.eventAvgPrice : null,
        roiLabel: roi.label,
        roiScore: roi.score,
        reasons,
        facilities: facilities.sort((a, b) => a.eventAvgPrice - b.eventAvgPrice),
      })
    }

    // 7. Group events under their venue + venue rollup
    const byVenue = {}
    for (const e of eventStats) {
      if (!byVenue[e.venueId]) {
        byVenue[e.venueId] = { id: e.venueId, name: venueNameMap[e.venueId] || 'Unknown', events: [] }
      }
      byVenue[e.venueId].events.push(e)
    }

    const venues = Object.values(byVenue).map(v => {
      const premiums = v.events.map(e => e.premiumPct).filter(x => x !== null)
      const vols = v.events.map(e => e.volatility)
      return {
        id: v.id,
        name: v.name,
        eventCount: v.events.length,
        avgPremiumPct: premiums.length ? _round2(_mean(premiums)) : null,
        maxPremiumPct: premiums.length ? _round2(Math.max(...premiums)) : null,
        peakVolatility: vols.length ? _round4(Math.max(...vols)) : 0,
        highRoiCount: v.events.filter(e => e.roiLabel === 'High').length,
        totalScrapes: v.events.reduce((s, e) => s + e.scrapeCount, 0),
        // Events ranked by ROI score so the strongest opportunity surfaces first
        events: v.events.sort((a, b) => b.roiScore - a.roiScore),
      }
    })

    // Venues with the most high-ROI events (then biggest premium) bubble up
    venues.sort((a, b) =>
      (b.highRoiCount - a.highRoiCount) ||
      ((b.maxPremiumPct ?? -Infinity) - (a.maxPremiumPct ?? -Infinity))
    )

    return { venues, events: eventStats, venueNameMap }
  }
}

// GET /api/event-stats — the price-trends "By Event" table reads this.
// Optional ?source=spothero|parkwhiz|way scopes the view to one platform (the
// per-platform data pages pass it); anything else → all sources (SpotHero page).
const EVENT_STATS_SOURCES = new Set(['spothero', 'parkwhiz', 'way'])
app.get('/api/event-stats', async (req, res) => {
  try {
    const source = EVENT_STATS_SOURCES.has(req.query.source) ? req.query.source : null
    const { venues, message } = await computeEventStats(source)
    return res.json(message ? { venues, message } : { venues })
  } catch (error) {
    console.error('event-stats error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ---------------------------------------------------------------------------
// Gemini event sentiment — on-demand, cached in event_sentiment.
//
// Flow: recompute the event's signals (same source of truth as the table) →
// fingerprint them → if a cached row exists with the same hash and ?refresh is
// not set, serve it free → else call Gemini, persist, and return. The model only
// ever interprets numbers we computed from the database.
// ---------------------------------------------------------------------------

function mapSentimentRow(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    venueId: row.venue_id,
    source: row.source,
    sentiment: row.sentiment,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    headline: row.headline,
    narrative: row.narrative,
    recommendedPlay: row.recommended_play,
    keyDrivers: row.key_drivers || [],
    riskCaveats: row.risk_caveats || [],
    roiLabel: row.roi_label,
    premiumPct: row.premium_pct !== null ? Number(row.premium_pct) : null,
    volatility: row.volatility !== null ? Number(row.volatility) : null,
    spreadPct: row.spread_pct !== null ? Number(row.spread_pct) : null,
    modelId: row.model_id,
    generatedAt: row.generated_at,
    cached: true,
  }
}

// GET /api/event-sentiment — all cached reads (lightweight, for badges/lists).
app.get('/api/event-sentiment', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('event_sentiment')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(500)
    if (error) return res.status(500).json({ error: error.message })
    res.json({
      configured: sentimentConfigured(),
      modelId: sentimentModelId(),
      items: (data || []).map(mapSentimentRow),
    })
  } catch (error) {
    console.error('event-sentiment list error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/event-sentiment/:eventId?refresh=1 — cached read, or generate on miss.
app.get('/api/event-sentiment/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
    // Passive UI loads pass cachedOnly=1: serve cache but NEVER spend a model
    // call on a miss — the user generates explicitly via a button.
    const cachedOnly = req.query.cachedOnly === '1' || req.query.cachedOnly === 'true'

    // 1. Recompute this event's signals (one source of truth with the table).
    const { events } = await computeEventStats()
    const event = (events || []).find(e => e.eventId === eventId)
    if (!event) {
      return res.status(404).json({ error: 'No event-context pricing for this event yet. It needs at least one event-tagged scrape.' })
    }

    const inputHash = hashEventSignals(event)

    // 2. Cache check — same signals + not forced → serve the stored read.
    const { data: cachedRow } = await supabase
      .from('event_sentiment')
      .select('*')
      .eq('event_id', eventId)
      .maybeSingle()

    if (cachedRow && cachedRow.input_hash === inputHash && !forceRefresh) {
      return res.json({ ...mapSentimentRow(cachedRow), stale: false })
    }

    // 2b. Passive load: don't spend a model call. Return any stale read + a flag
    //     so the UI can show "Generate" (or "Refresh" when the data has moved).
    if (cachedOnly && !forceRefresh) {
      return res.json({
        notGenerated: true,
        configured: sentimentConfigured(),
        stale: cachedRow ? { ...mapSentimentRow(cachedRow), stale: true } : null,
      })
    }

    // 3. Need a fresh read — make sure Gemini is wired.
    if (!sentimentConfigured()) {
      // Degrade gracefully: hand back the deterministic signals + any stale read
      // so the UI still shows something useful without a key.
      return res.status(503).json({
        error: 'Sentiment model not configured (GEMINI_API_KEY missing).',
        configured: false,
        stale: cachedRow ? mapSentimentRow(cachedRow) : null,
      })
    }

    // 4. Call Gemini on the exact computed signals.
    const { result, modelId } = await analyzeEventSentiment(event, { venueName: event.venueName })

    // 5. Persist (upsert by event_id) so the next view is free until data moves.
    const rowOut = {
      event_id: eventId,
      venue_id: event.venueId,
      source: 'spothero',
      input_hash: inputHash,
      sentiment: result.sentiment,
      confidence: result.confidence,
      headline: result.headline,
      narrative: result.narrative,
      recommended_play: result.recommendedPlay,
      key_drivers: result.keyDrivers,
      risk_caveats: result.riskCaveats,
      signals: {
        eventAvgPrice: event.eventAvgPrice,
        baselineAvgPrice: event.baselineAvgPrice,
        premiumPct: event.premiumPct,
        spreadPct: event.spreadPct,
        volatility: event.volatility,
        multiScrape: event.multiScrape,
        facilityCount: event.facilityCount,
        scrapeCount: event.scrapeCount,
        reasons: event.reasons,
      },
      roi_label: event.roiLabel,
      premium_pct: event.premiumPct,
      volatility: event.volatility,
      spread_pct: event.spreadPct,
      model_id: modelId,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { error: upsertErr } = await supabase
      .from('event_sentiment')
      .upsert(rowOut, { onConflict: 'event_id' })
    if (upsertErr) console.error('event_sentiment upsert failed (returning result anyway):', upsertErr.message)

    res.json({
      eventId,
      venueId: event.venueId,
      source: 'spothero',
      ...result,
      roiLabel: event.roiLabel,
      premiumPct: event.premiumPct,
      volatility: event.volatility,
      spreadPct: event.spreadPct,
      modelId,
      generatedAt: rowOut.generated_at,
      cached: false,
      stale: false,
    })
  } catch (error) {
    console.error('event-sentiment error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/signals - High-profile venue signals (change detection)
// Sourced from the alerts table (the venue_signals table was never created in
// prod). Change-detection writes price/inventory alerts whose metadata carries the
// full signal payload (signal_type, before/after, event correlation); we surface
// exactly those (identified by metadata.signal_type) in the legacy signals shape.
app.get('/api/signals', async (req, res) => {
  try {
    const { data: alerts } = await supabase
      .from('alerts')
      .select('id, type, venue_id, message, metadata, created_at')
      .in('type', ['price_spike', 'availability_drop'])
      .order('created_at', { ascending: false })
      .limit(300)

    const num = v => (v === null || v === undefined ? null : Number(v))

    const enriched = (alerts || [])
      .filter(a => a.metadata && a.metadata.signal_type)   // change-detection signals only
      .map(a => {
        const m = a.metadata
        const priceChangePct = num(m.price_change_pct) ?? 0
        const spacesChangePct = num(m.spaces_change_pct) ?? 0
        return {
          id: a.id,
          venue: m.venue_name || 'Unknown',
          lot: m.facility_name || m.address || 'lot',
          signalType: m.signal_type,
          priceBefore: num(m.price_before),
          priceAfter: num(m.price_after),
          priceChangePct,
          spacesBefore: num(m.spaces_before),
          spacesAfter: num(m.spaces_after),
          spacesChangePct,
          timestamp: a.created_at,
          // event correlation (null when the move had no nearby event)
          eventCorrelated: !!m.event_correlated,
          eventName: m.event_name || null,
          eventDate: m.event_date || null,
          eventDaysUntil: m.event_days_until ?? null,
          severity: Math.max(Math.abs(priceChangePct), Math.abs(spacesChangePct)),
        }
      })

    if (enriched.length === 0) return res.json([])

    // Event-correlated signals first, then by severity.
    enriched.sort((a, b) => (Number(b.eventCorrelated) - Number(a.eventCorrelated)) || (b.severity - a.severity))

    res.json(enriched.slice(0, 50))
  } catch (error) {
    console.error('Signals error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Resolve the best "open this listing" link for an alert from its metadata.
// Exact lot URL wins (ParkWhiz). Otherwise the event page — but ONLY if it points
// at the same platform we'd buy from, so a SpotHero alert never links to a
// Ticketmaster/ParkWhiz page. Returns { url, kind } or null.
const PLATFORM_DOMAIN = { spothero: 'spothero.com', parkwhiz: 'parkwhiz.com', way: 'way.com' }
function resolveListingUrl(m) {
  if (m.listing_url) return { url: m.listing_url, kind: 'exact' }
  const ev = m.event_url
  const dom = PLATFORM_DOMAIN[m.source]
  if (ev && dom && ev.includes(dom)) return { url: ev, kind: 'event' }
  return null
}

// GET /api/alerts - Recent alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const { read, limit = 50, category, context, source, since } = req.query

    // NB: the column is is_read (not read) — selecting the wrong name errors the
    // whole query and silently returns an empty alerts feed.
    let query = supabase.from('alerts').select('id, type, venue_id, facility_id, message, metadata, created_at, is_read')

    if (read === 'false') query = query.eq('is_read', false)

    // Category tab — server-side so high-value alerts surface even when buried.
    if (category === 'soldout') {
      query = query.or('metadata->>signal_type.eq.SOLD_OUT,metadata->>signal_type.eq.INVENTORY_THINNING')
    } else if (category === 'volatility') {
      query = query.eq('type', 'price_spike')      // all price jumps
    } else if (category === 'pricedrop') {
      query = query.eq('type', 'price_drop')
    }

    // Provenance + time filters (context/source only match newly-tagged alerts).
    if (context === 'event' || context === 'generic') query = query.eq('metadata->>context', context)
    if (['spothero', 'parkwhiz', 'way'].includes(source)) query = query.eq('metadata->>source', source)
    if (since) {
      const hours = parseFloat(since)
      if (hours > 0) query = query.gte('created_at', new Date(Date.now() - hours * 3600000).toISOString())
    }

    const { data: alerts } = await query
      .order('created_at', { ascending: false })
      .limit(parseInt(limit))

    if (!alerts) return res.json([])

    // Enrich with venue names
    const enrichedAlerts = await Promise.all(
      alerts.map(async (alert) => {
        const { data: venue } = await supabase
          .from('venues')
          .select('name')
          .eq('id', alert.venue_id)
          .single()

        const m = alert.metadata || {}
        // The two runs being compared (prev run → this run), when known. Producers
        // stamp these into metadata; change-detection has only the "after" run.
        const fromIso = m.prev_scraped_at || null
        const toIso = m.new_scraped_at || m.latest_scraped_at || alert.created_at

        return {
          id: alert.id,
          type: alert.type,
          // change-detection alerts carry venue_id=null but stash the name in metadata
          venue: venue?.name || m.venue_name || 'Unknown',
          message: alert.message,
          value: m.delta ? `$${Math.abs(m.delta).toFixed(2)}` : 'N/A',
          // Raw ISO — the UI formats in the viewer's timezone. `time` kept as an
          // ISO fallback for older clients during deploy skew.
          createdAt: alert.created_at,
          time: alert.created_at,
          window: { from: fromIso, to: toIso }, // from may be null (no exact prior run)
          // Provenance for the per-alert label + filters.
          source: m.source || null,
          context: m.context || 'generic',
          signalType: m.signal_type || null,
          confidence: m.confidence || null,        // confirmed | likely | unverified (sold-out trust tier)
          eventName: m.event_name || null,
          // Deep link to the listing on the buying platform (exact lot / event page).
          ...(() => { const r = resolveListingUrl(m); return r ? { listingUrl: r.url, listingUrlKind: r.kind } : {} })(),
          read: alert.is_read || false,
        }
      })
    )

    res.json(enrichedAlerts)
  } catch (error) {
    console.error('Alerts error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/alerts/unread-count — drives the navbar bell badge.
app.get('/api/alerts/unread-count', async (req, res) => {
  try {
    const { count } = await supabase
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('is_read', false)
    res.json({ count: count || 0 })
  } catch (error) {
    console.error('Alerts unread-count error:', error)
    res.json({ count: 0 })
  }
})

// POST /api/alerts/read — mark alerts read (persisted in is_read). Body { ids? }:
// specific ids, or omit to mark ALL unread as read. Alerts are NEVER deleted —
// this only flips is_read, so the history stays in the DB and the unread badge
// reflects what you've acknowledged.
app.post('/api/alerts/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
    let q = supabase.from('alerts').update({ is_read: true })
    q = ids ? q.in('id', ids) : q.eq('is_read', false)
    const { error } = await q
    if (error) throw error
    res.json({ ok: true })
  } catch (error) {
    console.error('Alerts mark-read error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/event/:id - Detailed event with all parking listings
app.get('/api/event/:id', async (req, res) => {
  try {
    const { id } = req.params
    console.log(`📍 /api/event/${id} called`)

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .single()

    if (eventError) {
      console.error('❌ Event query failed:', eventError)
      return res.status(404).json({ error: 'Event not found' })
    }

    const { data: venue, error: venueError } = await supabase
      .from('venues')
      .select('name, lat, lon')
      .eq('id', event.venue_id)
      .single()

    if (venueError) {
      console.error('❌ Venue query failed:', venueError)
    }

    // Get parking listings for this event; fall back to venue's generic listings if none
    let { data: listings, error: listingsError } = await supabase
      .from('snapshots')
      .select('*')
      .eq('event_id', id)
      .order('total_price', { ascending: true })

    if (listingsError) {
      console.error('❌ Listings query failed:', listingsError)
      return res.status(500).json({ error: `Listings query failed: ${listingsError.message}` })
    }

    if (!listings || listings.length === 0) {
      // No event-specific parking scraped — fall back to most recent generic snapshot for this venue
      const { data: generic } = await supabase
        .from('snapshots')
        .select('*')
        .eq('venue_id', event.venue_id)
        .is('event_id', null)
        .order('scraped_at', { ascending: false })
        .limit(500)
      listings = generic || []
    }

    const parsedListings = (listings || []).map(l => ({
      id: l.id,
      facilityName: l.facility_name,
      address: l.address,
      city: l.city,
      state: l.state,
      facilityType: l.facility_type,
      amenities: l.amenities ? l.amenities.split(', ') : [],
      advertisedPrice: l.advertised_price,
      serviceFee: l.service_fee,
      totalPrice: l.total_price,
      availableSpaces: l.available_spaces,
      isAvailable: l.is_available,
      walkingMeters: l.walking_meters,
      scrapedAt: l.scraped_at,
    }))

    const venueData = venue ? {
      name: venue.name,
      city: parsedListings[0]?.city || 'Unknown',
      state: parsedListings[0]?.state || '',
    } : { name: 'Unknown Venue', city: 'Unknown', state: '' }

    res.json({
      event: {
        id: event.id,
        name: event.event_name,
        date: event.event_date,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        sourceUrl: event.source_url,
      },
      venue: venueData,
      listings: parsedListings,
      totalListings: parsedListings.length,
      avgPrice: parsedListings.length
        ? (parsedListings.reduce((sum, l) => sum + l.totalPrice, 0) / parsedListings.length).toFixed(2)
        : 0,
      totalAvailableSpots: parsedListings.reduce((sum, l) => sum + (l.availableSpaces || 0), 0),
    })
  } catch (error) {
    console.error('Event detail error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/venue-snapshots/:venueName - Detailed venue snapshots and signals
app.get('/api/venue-snapshots/:venueName', async (req, res) => {
  try {
    const { venueName } = req.params
    const decodedName = decodeURIComponent(venueName)

    // Get all snapshots for this venue
    const { data: snapshots } = await supabase
      .from('parking_snapshots')
      .select('price, spaces, scraped_at')
      .eq('venue_name', decodedName)
      .order('scraped_at', { ascending: false })

    // Get all signals for this venue
    const { data: signals } = await supabase
      .from('venue_signals')
      .select('*')
      .eq('venue_name', decodedName)
      .order('tagged_at', { ascending: false })

    res.json({
      venueName: decodedName,
      snapshots: snapshots || [],
      signals: signals || [],
      snapshotCount: snapshots?.length || 0,
    })
  } catch (error) {
    console.error('Venue snapshots error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/venue/:id - Detailed venue information
app.get('/api/venue/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data: venue } = await supabase
      .from('venues')
      .select('*')
      .eq('id', id)
      .single()

    if (!venue) return res.status(404).json({ error: 'Venue not found' })

    // Get all parking snapshots for this venue (optional ?source= filter)
    const { source } = req.query
    let snapshotsQuery = supabase
      .from('snapshots')
      .select('*')
      .eq('venue_id', id)
      .order('scraped_at', { ascending: false })
      .limit(100)
    if (source) snapshotsQuery = snapshotsQuery.eq('source', source)
    const { data: snapshots } = await snapshotsQuery

    // Get events for this venue
    const { data: events } = await supabase
      .from('events')
      .select('*')
      .eq('venue_id', id)
      .order('starts_at', { ascending: false })

    res.json({
      venue,
      recentSnapshots: snapshots || [],
      events: events || [],
    })
  } catch (error) {
    console.error('Venue detail error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`🚀 Parking API running on http://localhost:${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Metrics: http://localhost:${PORT}/api/metrics`)
})
