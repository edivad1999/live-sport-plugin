const crypto = require('crypto');

function catalogSourceId(src) {
  const raw = `${src.source || ''}\0${String(src.id || '')}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function serializeCatalogSources(match, eventId) {
  const sources = Array.isArray(match.sources) ? match.sources : [];
  const seen = new Set();
  const out = [];
  for (const src of sources) {
    if (!src || !src.source) continue;
    const id = catalogSourceId(src);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      provider: String(src.source),
      playback: {
        url: `/api/dispatcharr/v1/events/${eventId}/sources/${id}/play.m3u8`
      }
    });
  }
  return out;
}

function findCatalogSource(match, sourceId) {
  const sources = Array.isArray(match && match.sources) ? match.sources : [];
  return sources.find((src) => catalogSourceId(src) === sourceId) || null;
}

module.exports = {
  catalogSourceId,
  serializeCatalogSources,
  findCatalogSource
};
