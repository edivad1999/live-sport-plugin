const http = require('http');
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { canonicalEventId } = require('../src/services/EventIdentityService');
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

function jsonGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathName, headers }, (res) => {
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
  const kickoff = Date.now() - 10 * 60 * 1000;
  const match = {
    id: 'sf_e2e-inter-juv',
    title: 'Inter vs Juventus',
    category: 'football',
    date: String(kickoff),
    league: 'Serie A',
    team1: { name: 'Inter' },
    team2: { name: 'Juventus' },
    sources: [{ source: 'streamfree', id: 'a' }]
  };
  const eventId = canonicalEventId(match);
  const cacheService = {
    lastFetchTime: Date.now(),
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
  const engineUrl = 'http://127.0.0.1:' + port;

  try {
    const listing = await jsonGet(port, '/api/dispatcharr/v1/events');
    assert('engine lists the live event', listing.status === 200 && listing.body.events[0].id === eventId);
    assert('listing did not JIT-resolve', resolveCalls === 0);

    const result = await new Promise((resolve, reject) => {
      const child = spawn('python3', [
        path.join(__dirname, '../dispatcharr-live-sports/tests/e2e_http.py'),
        engineUrl
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('plugin e2e python failed: ' + stderr + stdout));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error('plugin e2e python returned non-JSON: ' + stdout + stderr));
        }
      });
    });
    const channel = result.channels[0];
    assert('first sync created one channel', result.first.channels_created === 1 && result.channels.length === 1);
    assert('second sync created no duplicates', result.second.channels_created === 0 && result.second.channels_unchanged === 1 && result.channels.length === 1);
    assert('stored url is the stable play path', channel.url === engineUrl + '/api/dispatcharr/v1/events/' + eventId + '/play.m3u8');
    assert('stored url is not a provider CDN', !channel.url.includes('cdn.example'));
    assert('channel has EPG times', Boolean(channel.start_time) && Boolean(channel.end_time));
    assert('tvg_id uses live-sports prefix', channel.tvg_id === 'live-sports:' + eventId);

    const play = await jsonGet(port, '/api/dispatcharr/v1/events/' + eventId + '/play.m3u8');
    assert('Dispatcharr play URL JIT-resolves through /api/manifest', play.status === 302 && String(play.headers.location).includes('/api/manifest?url='));
    assert('play does not redirect to raw CDN', play.headers.location !== 'https://cdn.example/token/abc/master.m3u8');
    assert('play resolved after sync, not during listing', resolveCalls === 1);
  } finally {
    server.close();
  }
}

run().then(() => {
  console.log('plugin e2e ok');
}).catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
