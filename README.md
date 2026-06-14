# Parking Arbitrage API

Express API server that provides REST endpoints for the parking arbitrage dashboard. Connects to Supabase to serve scraped parking data, events, and pricing history.

## Setup

### Prerequisites
- Node.js 18+
- Supabase account with parking data (from the scraper)

### Installation

```bash
npm install
cp .env.example .env
```

Update `.env` with your Supabase credentials:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
PORT=3001
```

### Development

```bash
npm run dev
```

Server runs on `http://localhost:3001`

### Production

```bash
npm start
```

## API Endpoints

### Health Check
```
GET /health
```
Returns server status and timestamp.

### Metrics (Dashboard Overview)
```
GET /api/metrics
```
Returns key performance indicators:
- Average parking price across all venues
- Number of venues tracked
- Total available parking spots
- Best current deal (lowest price venue)

**Response:**
```json
{
  "avgPrice": "$18.50",
  "venuesTracked": 45,
  "availableSpots": 1240,
  "bestDeal": {
    "price": "$8.99",
    "venue": "United Center"
  }
}
```

### All Venues
```
GET /api/venues
```
Returns all venues with current pricing and trend.

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "Madison Square Garden",
    "city": "New York",
    "state": "NY",
    "avgPrice": 22.50,
    "availableSpots": 45,
    "trend": "up",
    "lastUpdated": "2:30:45 PM"
  }
]
```

### Upcoming Events
```
GET /api/events
```
Returns upcoming events with parking context.

**Response:**
```json
[
  {
    "id": "event-uuid",
    "name": "Knicks vs Lakers",
    "venue": "Madison Square Garden, New York, NY",
    "date": "Jun 12, 2026",
    "time": "07:30 PM",
    "availableSpots": 45,
    "avgPrice": "$22.50",
    "trend": "up",
    "sourceUrl": "https://spothero.com/events/..."
  }
]
```

### Price History
```
GET /api/price-history?venueId={id}&days={7}
```
Returns historical pricing data grouped by day.

**Query Parameters:**
- `venueId` (optional) - Filter to specific venue
- `days` (default: 7) - Number of days of history

**Response:**
```json
[
  {
    "date": "Jun 6",
    "price": 18.50
  },
  {
    "date": "Jun 7",
    "price": 19.75
  }
]
```

### Recent Alerts
```
GET /api/alerts?read={false}&limit={20}
```
Returns pricing alerts and notifications.

**Query Parameters:**
- `read` (default: all) - Filter by `true` or `false`
- `limit` (default: 20) - Number of alerts

**Response:**
```json
[
  {
    "id": "alert-uuid",
    "type": "price_drop",
    "venue": "United Center",
    "message": "Price dropped $5.00",
    "value": "$5.00",
    "time": "2 minutes ago",
    "read": false
  }
]
```

### Venue Details
```
GET /api/venue/:id
```
Returns detailed information for a specific venue.

**Response:**
```json
{
  "venue": {
    "id": "uuid",
    "name": "Madison Square Garden",
    "lat": 40.7505,
    "lon": -73.9935,
    "city": "New York",
    "state": "NY",
    "spothero_destination_id": null
  },
  "recentSnapshots": [
    {
      "venue_id": "uuid",
      "facility_name": "Lot A",
      "total_price": 22.50,
      "available_spaces": 45,
      "scraped_at": "2026-06-06T14:30:00Z"
    }
  ],
  "events": [
    {
      "event_name": "Knicks vs Lakers",
      "starts_at": "2026-06-12T19:30:00Z",
      "venue_id": "uuid"
    }
  ]
}
```

## Deployment

### Render

1. Push code to GitHub
2. Create new Web Service on Render
3. Connect to repo
4. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `PORT=3001`
5. Deploy

The API will be available at `https://parking-api-xxx.onrender.com`

### Docker

```bash
docker build -t parking-api .
docker run -e SUPABASE_URL=... -e SUPABASE_SERVICE_KEY=... -p 3001:3001 parking-api
```

## Architecture

- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL)
- **Middleware**: CORS, JSON parser
- **Auth**: Service key (Supabase)

## Error Handling

All endpoints return appropriate HTTP status codes:
- `200` - Success
- `400` - Bad request
- `404` - Not found
- `500` - Server error

Error responses include a message:
```json
{
  "error": "Description of what went wrong"
}
```

## Performance

- Metrics endpoint caches recent snapshots for speed
- Venue list with pricing is O(n) but could be optimized with views
- Events enrichment queries could benefit from caching in production

## Future Improvements

- [ ] Add Redis caching for frequently accessed endpoints
- [ ] Implement rate limiting
- [ ] Add authentication for sensitive endpoints
- [ ] Pagination for large datasets
- [ ] Real-time WebSocket updates
- [ ] Aggregate statistics endpoint
