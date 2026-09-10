const http = require('http');
const express = require('express');
const { canonicalEventId } = require('../src/services/EventIdentityService');
const { serializeEvent, filterEvents } = require('../src/integrations/dispatcharr/EventSerializer');
const { wrapPlayableUrl, pickPlayableStream } = require('../src/integrations/dispatcharr/PlaybackService');
const { mountDispatcharrApi } = require('../src/integrations/dispatcharr/routes');

function assert(name, cond) {
  if (!cond) throw new Error(name);
  console.log('  PASS ' + name);
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port };
}

function jsonGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    }).on('error', reject);
  });
}

async function run() {
  const kickoff = Date.UTC(2026, 8, 12, 18, 45, 0);
  const match = {
    id: 'sf_inter-juv',
    title: 'Inter vs Juventus',
    category: 'football',
    date: String(kickoff),
    league: 'Serie A',
    team1: { name: 'Inter', logo: 'http://example/inter.png' },
    team2: { name: 'Juventus', logo: 'http://example/juv.png' },
    poster: 'http://example/poster.png',
    logo: 'http://example/logo.png',
    background: 'http://example/bg.png',
    sources: [{ source: 'streamfree', id: 'a' }, { source: 'watchfooty', id: 'b' }]
  };
  const eventId = canonicalEventId(match);

  const serialized = serializeEvent(match, eventId);
  assert('canonical id is opaque ls_ hex', /^ls_[0-9a-f]{16}$/.test(serialized.id));
  assert('startTime is UTC ISO-8601', serialized.startTime === new Date(kickoff).toISOString() && serialized.startTime.endsWith('Z'));
  assert('estimatedEndTime is after start', Date.parse(serialized.estimatedEndTime) > Date.parse(serialized.startTime));
  assert('playback url is stable engine path', serialized.playback.url === `/api/dispatcharr/v1/events/${eventId}/play.m3u8`);
  assert('sourceCount does not resolve streams', serialized.sourceCount === 2);

  const tennis = serializeEvent({ ...match, id: 'x', title: 'Court 7', category: 'tennis', team1: null, team2: null, date: String(kickoff) }, canonicalEventId({ title: 'Court 7', category: 'tennis', date: String(kickoff) }));
  const filtered = filterEvents([serialized, tennis], { sports: 'football' });
  assert('sports filter keeps football', filtered.length === 1 && filtered[0].sport === 'football');
  const ranged = filterEvents([serialized], { from: '2026-09-12T00:00:00Z', to: '2026-09-12T23:59:59Z' });
  assert('from/to keeps same-day kickoff', ranged.length === 1);
  const outside = filterEvents([serialized], { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
  assert('from/to drops out-of-range', outside.length === 0);

  const raw = { url: 'https://cdn.example/token/abc/master.m3u8', name: 'Nuvio Direct', behaviorHints: { proxyHeaders: { request: { Referer: 'https://watchfooty.st/', Origin: 'https://watchfooty.st' } } } };
  const wrapped = wrapPlayableUrl(raw, 'http://127.0.0.1:7010');
  assert('raw m3u8 is wrapped through /api/manifest', wrapped.includes('/api/manifest?url=') && wrapped.includes(encodeURIComponent('https://cdn.example/token/abc/master.m3u8')));
  assert('wrap is not a bare CDN url', wrapped !== raw.url);
  const already = wrapPlayableUrl({ url: '/api/manifest?url=' + encodeURIComponent('https://cdn.example/x.m3u8') + '&referer=' + encodeURIComponent('https://streamfree.top/') + '&origin=' + encodeURIComponent('https://streamfree.top') }, 'http://sports');
  assert('existing manifest wrap stays on proxy', already.startsWith('http://sports/api/manifest?url='));
  assert('web-only is not pickable', pickPlayableStream([{ externalUrl: '/watch?x', name: 'Nuvio Web Player' }]) === null);

  const cacheService = {
    lastFetchTime: Date.UTC(2026, 8, 10, 9, 10, 0),
    getMatches() { return [match]; }
  };
  const container = {
    resolve(name) {
      if (name === 'cacheService') return cacheService;
      if (name === 'streamFreeProvider') return {};
      throw new Error('missing ' + name);
    }
  };

  let resolveCalls = 0;
  const app = express();
  mountDispatcharrApi(app, {
    container,
    engineVersion: '3.0.0',
    getRequestBaseUrl: () => 'http://127.0.0.1:9',
    resolveMatchStreams: async () => {
      resolveCalls += 1;
      return [{ url: 'https://cdn.example/token/abc/master.m3u8', name: 'Nuvio Direct' }];
    }
  });
  const { server, port } = await listen(app);

  const status = await jsonGet(port, '/api/dispatcharr/v1/status');
  assert('status ok', status.status === 200 && status.body.status === 'ok');
  assert('status has versions and counts', status.body.engineVersion === '3.0.0' && status.body.apiVersion === 1 && status.body.cachedEvents === 1);
  assert('lastSync is UTC ISO', status.body.lastSync === '2026-09-10T09:10:00.000Z');
  assert('listing does not resolve streams', resolveCalls === 0);

  const events = await jsonGet(port, '/api/dispatcharr/v1/events');
  assert('events lists canonical id', events.body.events[0].id === eventId);
  assert('events playback is stable path', events.body.events[0].playback.url.endsWith(`/events/${eventId}/play.m3u8`));
  assert('listing still did not resolve', resolveCalls === 0);

  const footballOnly = await jsonGet(port, '/api/dispatcharr/v1/events?sports=football');
  assert('query sports=football returns the fixture', footballOnly.body.events.length === 1);
  const none = await jsonGet(port, '/api/dispatcharr/v1/events?sports=tennis');
  assert('query sports=tennis is empty', none.body.events.length === 0);

  const play = await jsonGet(port, `/api/dispatcharr/v1/events/${eventId}/play.m3u8`);
  assert('play redirects to manifest proxy', play.status === 302 && String(play.headers.location).includes('/api/manifest?url='));
  assert('play does not redirect to raw CDN', play.headers.location !== 'https://cdn.example/token/abc/master.m3u8');
  assert('play resolved JIT', resolveCalls === 1);

  const missing = await jsonGet(port, '/api/dispatcharr/v1/events/ls_deadbeefdeadbeef/play.m3u8');
  assert('unknown event is 404', missing.status === 404);

  server.close();

  const webOnlyMatch = { ...match, id: 'spk_dup' };
  const directMatch = { ...match, id: 'wf_dup' };
  const dupCache = {
    lastFetchTime: Date.UTC(2026, 8, 10, 9, 10, 0),
    getMatches() { return [webOnlyMatch, directMatch]; }
  };
  const dupResolves = [];
  const dupApp = express();
  mountDispatcharrApi(dupApp, {
    container: {
      resolve(name) {
        if (name === 'cacheService') return dupCache;
        if (name === 'streamFreeProvider') return {};
        throw new Error('missing ' + name);
      }
    },
    engineVersion: '3.0.0',
    getRequestBaseUrl: () => 'http://127.0.0.1:9',
    resolveMatchStreams: async (id) => {
      dupResolves.push(id);
      if (id === 'wf_dup') return [{ url: 'https://cdn.example/token/abc/master.m3u8', name: 'Nuvio Direct' }];
      return [{ externalUrl: '/watch?x', name: 'Nuvio Web Player' }];
    }
  });
  const dup = await listen(dupApp);
  const listed = await jsonGet(dup.port, '/api/dispatcharr/v1/events');
  assert('duplicate canonical ids collapse to one event', listed.body.events.length === 1 && listed.body.events[0].id === eventId);
  const dupPlay = await jsonGet(dup.port, `/api/dispatcharr/v1/events/${eventId}/play.m3u8`);
  assert('play unions sources across duplicate matches', dupPlay.status === 302 && String(dupPlay.headers.location).includes('/api/manifest?url='));
  assert('play tried both match ids', dupResolves.includes('spk_dup') && dupResolves.includes('wf_dup'));
  dup.server.close();

  const webApp = express();
  mountDispatcharrApi(webApp, {
    container,
    engineVersion: '3.0.0',
    getRequestBaseUrl: () => 'http://127.0.0.1:9',
    resolveMatchStreams: async () => [{ externalUrl: '/watch?embed', name: 'Nuvio Web Player' }]
  });
  const web = await listen(webApp);
  const noDirect = await jsonGet(web.port, `/api/dispatcharr/v1/events/${eventId}/play.m3u8`);
  assert('web-only resolve is 503', noDirect.status === 503);
  web.server.close();

  process.env.DISPATCHARR_API_TOKEN = 'secret-token';
  const authed = express();
  mountDispatcharrApi(authed, {
    container,
    engineVersion: '3.0.0',
    getRequestBaseUrl: () => 'http://127.0.0.1:9',
    resolveMatchStreams: async () => []
  });
  const authServer = await listen(authed);
  const denied = await jsonGet(authServer.port, '/api/dispatcharr/v1/status');
  assert('missing bearer is 401 when token configured', denied.status === 401);
  const okAuth = await jsonGet(authServer.port, '/api/dispatcharr/v1/status', { authorization: 'Bearer secret-token' });
  assert('bearer token is accepted', okAuth.status === 200);
  delete process.env.DISPATCHARR_API_TOKEN;
  authServer.server.close();

  console.log('ALL DISPATCHARR API TESTS PASSED');
}

run().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
