const { serializeCatalogSources } = require('./SourceIdentity');

const DURATION_MS = {
  football: 2.5 * 3600 * 1000,
  basketball: 2.5 * 3600 * 1000,
  tennis: 3 * 3600 * 1000,
  motorsport: 3 * 3600 * 1000,
  cricket: 8 * 3600 * 1000,
  american_football: 3.5 * 3600 * 1000,
  hockey: 2.5 * 3600 * 1000,
  baseball: 3.5 * 3600 * 1000,
  golf: 6 * 3600 * 1000,
  rugby: 2 * 3600 * 1000,
  mma: 3 * 3600 * 1000,
  darts: 3 * 3600 * 1000
};

function toIsoUtc(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function participant(team) {
  if (!team) return null;
  if (typeof team === 'string') return { name: team, logo: null };
  return { name: team.name || team.title || '', logo: team.logo || null };
}

function estimatedEndMs(startMs, category) {
  if (!startMs) return null;
  const dur = DURATION_MS[category] || 3 * 3600 * 1000;
  return startMs + dur;
}

function eventStatus(startMs, endMs, now) {
  if (!startMs) return 'live';
  if (now < startMs) return 'upcoming';
  if (!endMs || now < endMs) return 'live';
  return 'ended';
}

function serializeEvent(match, canonicalId) {
  const startMs = Number(match.date) || 0;
  const endMs = estimatedEndMs(startMs, match.category);
  const now = Date.now();
  const p1 = participant(match.team1);
  const p2 = participant(match.team2);
  const participants = [p1, p2].filter(Boolean);
  return {
    id: canonicalId,
    title: match.title,
    sport: match.category || 'other',
    league: match.league || '',
    startTime: toIsoUtc(startMs),
    estimatedEndTime: toIsoUtc(endMs),
    status: eventStatus(startMs, endMs, now),
    participants,
    artwork: {
      logo: match.logo || '',
      poster: match.poster || match.thumbnail_url || '',
      background: match.background || ''
    },
    sourceCount: Array.isArray(match.sources) ? match.sources.length : 0,
    sources: serializeCatalogSources(match, canonicalId),
    playback: {
      url: `/api/dispatcharr/v1/events/${canonicalId}/play.m3u8`
    }
  };
}

function preferEvent(a, b) {
  const ac = a && a.sourceCount ? a.sourceCount : 0;
  const bc = b && b.sourceCount ? b.sourceCount : 0;
  if (ac !== bc) return ac > bc ? a : b;
  if (a && a.status === 'live' && (!b || b.status !== 'live')) return a;
  if (b && b.status === 'live' && (!a || a.status !== 'live')) return b;
  return a;
}

function dedupeEvents(events) {
  const byId = new Map();
  for (const event of events || []) {
    if (!event || !event.id) continue;
    const prev = byId.get(event.id);
    byId.set(event.id, prev ? preferEvent(event, prev) : event);
  }
  return [...byId.values()];
}

function filterEvents(events, { sports, from, to } = {}) {
  let out = events;
  if (sports) {
    const set = new Set(String(sports).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (set.size) out = out.filter((e) => set.has(String(e.sport || '').toLowerCase()));
  }
  if (from) {
    const fromMs = Date.parse(from);
    if (Number.isNaN(fromMs)) throw new Error('invalid_from');
    out = out.filter((e) => {
      if (!e.startTime) return true;
      return Date.parse(e.startTime) >= fromMs;
    });
  }
  if (to) {
    const toMs = Date.parse(to);
    if (Number.isNaN(toMs)) throw new Error('invalid_to');
    out = out.filter((e) => {
      if (!e.startTime) return true;
      return Date.parse(e.startTime) <= toMs;
    });
  }
  return out;
}

module.exports = {
  serializeEvent,
  filterEvents,
  dedupeEvents,
  estimatedEndMs,
  toIsoUtc
};
