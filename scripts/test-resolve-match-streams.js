const assert = require('assert');
const container = require('../src/container');
const { handleStream, prewarmMatch, resolveMatchStreams } = require('../src/streams');

async function main() {
  let pass = 0, fail = 0;
  const t = (name, cond) => {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
  };

  t('exports resolveMatchStreams', typeof resolveMatchStreams === 'function');
  t('exports handleStream', typeof handleStream === 'function');
  t('exports prewarmMatch', typeof prewarmMatch === 'function');

  {
    const wrongType = await handleStream('movie', 'nuvio_sport_x', {});
    t('handleStream non-tv returns { streams: [] }', Array.isArray(wrongType.streams) && wrongType.streams.length === 0 && wrongType.cacheMaxAge === undefined);
  }

  {
    const wrongId = await handleStream('tv', 'other_prefix_x', {});
    t('handleStream without nuvio_sport_ prefix returns { streams: [] }', Array.isArray(wrongId.streams) && wrongId.streams.length === 0 && wrongId.cacheMaxAge === undefined);
  }

  {
    const missing = await resolveMatchStreams('no_such_match', {});
    t('resolveMatchStreams missing match returns []', Array.isArray(missing) && missing.length === 0);
    const wrapped = await handleStream('tv', 'nuvio_sport_no_such_match', {});
    t('handleStream missing match returns 0 streams without cache headers', wrapped && wrapped.streams.length === 0 && wrapped.cacheMaxAge === undefined);
  }

  const cacheService = container.resolve('cacheService');
  const resolveCache = container.resolve('streamResolveCache');
  cacheService.setMatches([{
    id: 'u1_extract_direct_web',
    title: 'U1 Extract Probe',
    category: 'football',
    date: '0',
    sources: [
      { source: 'sportyhunter', id: 'sporty_u1' },
      { source: 'iptv-org', id: 'iptv_u1', quality: '1080p', url: 'http://127.0.0.1/watch?u1' }
    ]
  }]);
  resolveCache.entries.clear();
  resolveCache.inFlight.clear();

  const domain = await resolveMatchStreams('u1_extract_direct_web', {});
  t('resolveMatchStreams returns two domain streams', domain.length === 2);
  t('domain sort puts direct first', !!(domain[0] && domain[0].url) && !domain[0].externalUrl);
  t('domain sort puts web second', !!domain[1] && !!domain[1].externalUrl);
  t('domain objects are undecorated', domain[0].name === 'Nuvio Direct' && domain[1].name === 'Nuvio Web Player');
  t('domain titles have no Stremio icon prefix', !String(domain[0].title).includes('⚽') && !String(domain[1].title).includes('⚽'));
  t('domain objects have no bingeGroup', !domain[0].behaviorHints || !domain[0].behaviorHints.bingeGroup);

  const wrapped = await handleStream('tv', 'nuvio_sport_u1_extract_direct_web', {});
  t('handleStream wraps domain streams', wrapped.streams.length === 2);
  t('handleStream cache headers unchanged', wrapped.cacheMaxAge === 30 && wrapped.staleRevalidate === 30 && wrapped.staleError === 60);
  t('handleStream sort after decoration: Direct then Web', wrapped.streams[0].name === '⚡ Direct Stream' && wrapped.streams[1].name === '🌐 Web Stream');
  t('handleStream sets bingeGroup', wrapped.streams[0].behaviorHints && wrapped.streams[0].behaviorHints.bingeGroup === 'nuvio_sport_u1_extract_direct_web');

  console.log('\n' + (fail === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED') + ` (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('test harness error:', err); process.exit(1); });
