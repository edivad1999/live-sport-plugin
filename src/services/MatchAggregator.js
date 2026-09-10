const identity = require('./EventIdentityService');

class MatchAggregator {
  constructor({ streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, cacheService, yamlProviders }) {
    this.providers = [streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, ...(yamlProviders || [])];
    this.cacheService = cacheService;
  }

  /**
   * Precompute everything isSameEvent needs ONCE per match. The merge loop is
   * O(N^2) in pair comparisons; doing the regex-heavy normalization here instead
   * of inside every comparison removes ~50x of repeated work on large catalogs.
   */
  _precompute(e) {
    return identity.precompute(e);
  }

  /**
   * Merge decision on precomputed matches. Same decision tree as before, with
   * two fixes found by A/B testing against the real catalog:
   *   - "Man United" style alias gap (same match, two catalog names)
   *   - channel-like titles (no team-vs-team parse) collapsing under a loose
   *     Jaccard rule ("Sky Sports F1" + "Sky Sports Main Event" merged;
   *     "US Open Court 13" + "Court 7" merged)
   */
  _sameEventPre(p1, p2) {
    return identity.sameEventPre(p1, p2);
  }

  /** Public API preserved: decision on raw matches (computes pre on the fly). */
  isSameEvent(e1, e2) {
    return identity.isSameEvent(e1, e2);
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    const finalMatches = [];
    const finalPres = []; // precomputed identity for each accepted match

    const processProviderMatches = (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      providerMatches.forEach(match => {
        if (!match.id || !match.title) return;

        const pre = this._precompute(match);
        let idx = -1;
        for (let i = 0; i < finalMatches.length; i++) {
          if (this._sameEventPre(finalPres[i], pre)) { idx = i; break; }
        }

        if (idx === -1) {
          finalMatches.push(match);
          finalPres.push(pre);
          return;
        }

        const existing = finalMatches[idx];
        if (match.sources && Array.isArray(match.sources)) {
          match.sources.forEach(src => {
            if (!existing.sources.find(s => s.id === src.id && s.source === src.source)) {
              existing.sources.push(src);
            }
          });
        }
        if (match.popular === '1') existing.popular = '1';
        if (!existing.poster && match.poster) existing.poster = match.poster;
        if (!existing.logo && match.logo) existing.logo = match.logo;
        if (!existing.thumbnail_url && match.thumbnail_url) existing.thumbnail_url = match.thumbnail_url;
        if (!existing.background && match.background) existing.background = match.background;
        if (!existing.league && match.league) existing.league = match.league;
        if (!existing.team1 && match.team1) existing.team1 = match.team1;
        else if (existing.team1 && !existing.team1.logo && match.team1 && match.team1.logo) existing.team1.logo = match.team1.logo;
        if (!existing.team2 && match.team2) existing.team2 = match.team2;
        else if (existing.team2 && !existing.team2.logo && match.team2 && match.team2.logo) existing.team2.logo = match.team2.logo;
        if (existing.description === 'No description' && match.description && match.description !== 'No description') {
          existing.description = match.description;
        }

        // Canonical naming: prefer a team-vs-team fixture title over a
        // channel-like listing title, so the merged event keeps the most
        // informative name regardless of which provider arrived first.
        if (!existing._titleIsFixture && pre.teams) {
          existing.title = match.title;
          existing._titleIsFixture = true;
          finalPres[idx] = pre;
        }
      });
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of this.providers) {
        try {
          const providerMatches = await p.getMatches();
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          processProviderMatches(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      const results = await Promise.allSettled(this.providers.map(p => p.getMatches()));
      results.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          processProviderMatches(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${index} failed:`, promiseResult.reason);
        }
      });
    }

    const now = Date.now();
    // Smart Trending Engine: Boost popular matches globally, but only if they are actually live or starting soon
    const TRENDING_KEYWORDS = ['bein', 'real madrid', 'barcelona', 'manchester', 'arsenal', 'liverpool', 'chelsea', 'bayern', 'psg', 'lakers', 'warriors', 'mcgregor', 'super bowl', 'champions league', 'el clasico', 'f1', 'formula 1', 'grand prix'];

    finalMatches.forEach(match => {
      const titleLower = match.title.toLowerCase();

      // Parse kickoff date (default to 0 if none provided, assume live)
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      // Allow matches to be flagged as 'Live' from 3 hours before kickoff up to 14 hours after kickoff
      const isWithinTimeWindow = kickoff === 0 || (now >= kickoff - (3 * 3600 * 1000) && now <= kickoff + (14 * 3600 * 1000));

      if (TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        if (isWithinTimeWindow) {
          match.popular = '1';
        }
      }

      // GLOBAL FIX: Some providers (like Streamed.pk) flag future events as popular/live early.
      // We must override and strip the popular flag if the event is too far in the future.
      if (match.popular === '1' && kickoff > 0 && !isWithinTimeWindow) {
        match.popular = '0';
      }
    });

    // Filter out matches that are already over (kickoff was > 24 hours ago)
    const activeMatches = finalMatches.filter(match => {
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      if (kickoff === 0) return true; // Keep if we don't know the time

      // Keep matches up to 24 hours after kickoff, except TimStreams which we keep for 48 hours (VODs)
      const isTimStreams = match.sources && match.sources.some(s => s.source === 'timstreams');
      const expiryWindowMs = isTimStreams ? (48 * 3600 * 1000) : (24 * 3600 * 1000);
      return now <= kickoff + expiryWindowMs;
    });

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    if (anyProviderSucceeded) {
      this.cacheService.setMatches(activeMatches);
      return activeMatches;
    }
    return null;
  }
}

module.exports = MatchAggregator;
module.exports._internal = {
  _compoundify: identity._compoundify,
  _stripNoise: identity._stripNoise,
  _tokenize: identity._tokenize,
  _teamsSimilar: identity._teamsSimilar,
  _tryExtractTeams: identity._tryExtractTeams
};
