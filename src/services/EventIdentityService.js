const crypto = require('crypto');

/**
 * Normalizes team/event names by collapsing well-known multi-word clubs and
 * popular abbreviations into single collision-safe compound tokens so that
 * Jaccard / subset matching cannot accidentally merge different teams that share
 * a single word (e.g. "Inter Milan" vs "AC Milan" both contain "milan").
 *
 * ORDER MATTERS: more specific aliases (inter miami, inter turku) must come
 * before the bare-"inter" rule, otherwise "Inter Miami" would compound to
 * "intermilan" and collide with Inter Milan.
 */
function _compoundify(t) {
  const aliases = [
    [/\bman(chester)?\s*utd\b|\bmanchester\s*united\b/g, 'manchesterunited'],
    [/\bman\.?\s+united\b/g, 'manchesterunited'],
    [/\bman(chester)?\s*city\b/g, 'manchestercity'],
    [/\bspurs\b|\btottenham(\s*hotspur)?\b/g, 'tottenham'],
    [/\bwolves\b|\bwolverhampton(\s*wanderers)?\b/g, 'wolverhampton'],
    [/\bpsg\b|\bparis\s*(saint|st)\s*germain\b/g, 'psg'],
    [/\bbayern(\s*m[uü]nchen)?\b|\bbayern\s*munich\b/g, 'bayernmunich'],
    [/\batl(etico)?\s*madrid\b/g, 'atleticomadrid'],
    [/\breal\s*madrid\b|\br\s*madrid\b/g, 'realmadrid'],
    [/\binter\s*miami\b/g, 'intermiami'],
    [/\binter\s*turku\b/g, 'interturku'],
    [/\binter(\s*milan)?\b|\binternazionale\b/g, 'intermilan'],
    [/\bac\s*milan\b/g, 'acmilan'],
    [/\bborussia\s*dortmund\b|\bbvb\b|\bdortmund\b/g, 'borussiadortmund'],
    [/\brb\s*leipzig\b/g, 'rbleipzig'],
    [/\baston\s*villa\b/g, 'astonvilla'],
    [/\bwest\s*ham(\s*united)?\b/g, 'westham'],
    [/\bcrystal\s*palace\b/g, 'crystalpalace'],
    [/\bnewcastle(\s*united)?\b/g, 'newcastle'],
    [/\bnottingham\s*forest\b|\bnott(?:s|m)\s+forest\b/g, 'nottinghamforest'],
    [/\bleicester(\s*city)?\b/g, 'leicestercity'],
    [/\bsheff(?:ield)?\s*(?:utd|united)\b/g, 'sheffieldunited'],
    [/\bbe(?:in\s*sport|\s*in)\b/g, 'beinsport'],
    [/\bal[\s\-]nassr\b/g, 'alnassr'],
    [/\bal[\s\-]hilal\b/g, 'alhilal'],
    [/\bal[\s\-]ahly\b/g, 'alahly'],
    [/\bboca\s*juniors\b|\bca\s*boca\b/g, 'bocajuniors'],
    [/\bkansas\s*city\s*chiefs\b|\bkc\s*chiefs\b|\bchiefs\b/g, 'kansascitychiefs'],
    [/\bseattle\s*seahawks\b|\bseahawks\b/g, 'seattleseahawks'],
    [/\bsan\s*francisco\s*49ers\b|\bniners\b|\b49ers\b/g, 'sf49ers'],
    [/\bdallas\s*cowboys\b|\bcowboys\b/g, 'dallascowboys'],
    [/\bphiladelphia\s*eagles\b|\beagles\b/g, 'philadelphiaeagles'],
    [/\bgreen\s*bay\s*packers\b|\bpackers\b/g, 'greenbaypacker'],
    [/\bcincinatti\s*bengals\b|\bbengals\b/g, 'cincinnatibengals'],
    [/\bpittsburgh\s*steelers\b|\bsteelers\b/g, 'pittsburghsteelers'],
    [/\bny\s*knicks\b|\bnew\s*york\s*knicks\b|\bknicks\b/g, 'nyknicks'],
    [/\bboston\s*celtics\b|\bceltics\b/g, 'bostonceltics'],
    [/\bla\s*lakers\b|\blakers\b|\blos\s*angeles\s*lakers\b/g, 'lalakers'],
    [/\bgolden\s*state\s*warriors\b|\bwarriors\b/g, 'gswarriors'],
    [/\bchicago\s*bulls\b|\bbulls\b/g, 'chicagobulls'],
    [/\bmiami\s*heat\b|\bheat\b/g, 'miamiheat'],
    [/\bdenver\s*nuggets\b|\bnuggets\b/g, 'denvernuggets'],
    [/\bmilwaukee\s*bucks\b|\bbucks\b/g, 'milwaukeebucks'],
  ];
  let r = t.toLowerCase();
  for (const [regex, rep] of aliases) r = r.replace(regex, rep);
  return r;
}

function _stripNoise(t) {
  return t
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(live|stream|streaming|free|hd|fhd|4k|hq|web|online|tv|match|fixture|round|week|day|game|league|cup|tournament|season|fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv)\b/gi, ' ');
}

function _tokenize(t) {
  return t.replace(/[^a-z0-9]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w);
}

function _teamsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(' ').filter(w => w.length > 2);
  const bt = b.split(' ').filter(w => w.length > 2);
  if (at.length === 0 || bt.length === 0) return false;
  if (at.length === 1 && bt.length === 1) return at[0] === bt[0];
  const sa = new Set(at), sb = new Set(bt);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  const minLen = Math.min(sa.size, sb.size);
  return minLen > 0 && (common / minLen) >= 0.7;
}

function _tryExtractTeams(title) {
  const clean = _compoundify(_stripNoise(title));
  const parts = clean.split(/\s(?:vs?\.?|@|[-–—])\s/i);
  if (parts.length === 2) {
    return [_tokenize(parts[0]).join(' '), _tokenize(parts[1]).join(' ')];
  }
  return null;
}

function precompute(e) {
  const title = e && e.title ? String(e.title) : '';
  const id = e && e.id != null ? String(e.id) : '';
  return {
    id,
    category: e && e.category ? String(e.category) : '',
    date: Number(e && e.date) || 0,
    teams: _tryExtractTeams(title),
    tokens: new Set(_tokenize(_compoundify(_stripNoise(title)))),
    norm: _compoundify(_stripNoise(title)).replace(/\s+/g, ' ').trim(),
    digits: (title.match(/\d+/g) || []).sort().join(',')
  };
}

function sameEventPre(p1, p2) {
  if (p1.category && p2.category && p1.category !== 'other' && p2.category !== 'other' && p1.category !== p2.category) {
    return false;
  }
  if (p1.id && p2.id && p1.id === p2.id) return true;
  if (p1.date && p2.date && Math.abs(p1.date - p2.date) > 86400000) return false;

  if (p1.teams && p2.teams) {
    const fwd = _teamsSimilar(p1.teams[0], p2.teams[0]) && _teamsSimilar(p1.teams[1], p2.teams[1]);
    const rev = _teamsSimilar(p1.teams[0], p2.teams[1]) && _teamsSimilar(p1.teams[1], p2.teams[0]);
    return fwd || rev;
  }

  if (p1.tokens.size === 0 || p2.tokens.size === 0) return false;
  if (p1.digits !== p2.digits) return false;

  if (p1.teams || p2.teams) {
    const channel = p1.teams ? p2 : p1;
    const fixture = p1.teams ? p1 : p2;
    for (const w of channel.tokens) if (!fixture.tokens.has(w)) return false;
    return true;
  }

  if (p1.norm === p2.norm) return true;
  let common = 0;
  for (const w of p1.tokens) if (p2.tokens.has(w)) common++;
  const union = p1.tokens.size + p2.tokens.size - common;
  if (union > 0 && common / union >= 0.75) return true;
  return false;
}

function isSameEvent(e1, e2) {
  return sameEventPre(precompute(e1), precompute(e2));
}

function utcDayBucket(dateValue) {
  const ms = Number(dateValue) || 0;
  if (!ms) return 'undated';
  return new Date(ms).toISOString().slice(0, 10);
}

function canonicalEventId(match) {
  const pre = precompute(match);
  const category = pre.category || 'other';
  let payload;
  if (pre.teams) {
    const participants = [...pre.teams].sort();
    payload = ['fixture', category, participants[0], participants[1], utcDayBucket(match && match.date)].join('\0');
  } else {
    payload = ['channel', category, pre.norm, pre.digits].join('\0');
  }
  return 'ls_' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

module.exports = {
  precompute,
  sameEventPre,
  isSameEvent,
  canonicalEventId,
  utcDayBucket,
  _compoundify,
  _stripNoise,
  _tokenize,
  _teamsSimilar,
  _tryExtractTeams
};
