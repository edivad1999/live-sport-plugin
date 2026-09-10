const { canonicalEventId } = require('../../services/EventIdentityService');
const { serializeEvent, filterEvents } = require('./EventSerializer');
const { wrapPlayableUrl, pickPlayableStream } = require('./PlaybackService');

const PROVIDER_KEYS = [
  'streamFreeProvider',
  'timStreamsProvider',
  'sportyHunterProvider',
  'watchFootyProvider',
  'cdnLiveProvider',
  'streamSports99Provider',
  'streamicProvider',
  'streamedPkProvider',
  'embedIndiaProvider',
  'embedStProvider'
];

function requireBearer(req, res, next) {
  const token = process.env.DISPATCHARR_API_TOKEN;
  if (!token) return next();
  const hdr = req.headers.authorization || '';
  if (hdr === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function providerHealth(container) {
  return PROVIDER_KEYS.map((key) => {
    try {
      container.resolve(key);
      return { id: key, registered: true };
    } catch (_) {
      return { id: key, registered: false };
    }
  });
}

function mountDispatcharrApi(app, deps) {
  const container = deps.container;
  const resolveMatchStreams = deps.resolveMatchStreams;
  const getRequestBaseUrl = deps.getRequestBaseUrl;
  const engineVersion = deps.engineVersion || '0.0.0';

  app.use('/api/dispatcharr/v1', requireBearer);

  app.get('/api/dispatcharr/v1/status', (req, res) => {
    const cacheService = container.resolve('cacheService');
    const matches = cacheService.getMatches();
    const last = cacheService.lastFetchTime || 0;
    res.json({
      status: 'ok',
      engineVersion,
      apiVersion: 1,
      cachedEvents: matches.length,
      lastSync: last ? new Date(last).toISOString() : null,
      providers: providerHealth(container)
    });
  });

  app.get('/api/dispatcharr/v1/events', (req, res) => {
    const cacheService = container.resolve('cacheService');
    const matches = cacheService.getMatches();
    const serialized = matches.map((m) => serializeEvent(m, canonicalEventId(m)));
    try {
      const events = filterEvents(serialized, {
        sports: req.query.sports,
        from: req.query.from,
        to: req.query.to
      });
      res.json({ events });
    } catch (err) {
      if (err.message === 'invalid_from' || err.message === 'invalid_to') {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/api/dispatcharr/v1/events/:eventId/play.m3u8', async (req, res) => {
    const eventId = req.params.eventId;
    const cacheService = container.resolve('cacheService');
    const match = cacheService.getMatches().find((m) => canonicalEventId(m) === eventId);
    if (!match) return res.status(404).json({ error: 'event_not_found' });

    let streams;
    try {
      streams = await resolveMatchStreams(match.id, null);
    } catch (err) {
      return res.status(503).json({ error: 'resolve_failed' });
    }

    const chosen = pickPlayableStream(streams);
    if (!chosen) return res.status(503).json({ error: 'no_playable_stream' });

    const playUrl = wrapPlayableUrl(chosen, getRequestBaseUrl(req));
    if (!playUrl) return res.status(503).json({ error: 'no_playable_stream' });
    res.redirect(302, playUrl);
  });
}

module.exports = { mountDispatcharrApi, requireBearer };
