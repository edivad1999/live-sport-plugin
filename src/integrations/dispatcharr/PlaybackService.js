function headersFromStream(stream) {
  const reqHeaders = stream.behaviorHints && stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request;
  const referer = (reqHeaders && (reqHeaders.Referer || reqHeaders.referer)) || '';
  let origin = (reqHeaders && (reqHeaders.Origin || reqHeaders.origin)) || '';
  if (!origin && referer) {
    try { origin = new URL(referer).origin; } catch (_) {}
  }
  return { referer, origin };
}

function unwrapManifest(url) {
  if (!url || !url.includes('/api/manifest')) {
    return { targetUrl: url, referer: '', origin: '' };
  }
  try {
    const parsed = url.startsWith('http') ? new URL(url) : new URL('http://local.invalid' + url);
    return {
      targetUrl: parsed.searchParams.get('url') || url,
      referer: parsed.searchParams.get('referer') || '',
      origin: parsed.searchParams.get('origin') || ''
    };
  } catch (_) {
    return { targetUrl: url, referer: '', origin: '' };
  }
}

function isWebOnly(stream) {
  if (!stream || !stream.url) return true;
  if (stream.url.includes('/watch?')) return true;
  if (stream.externalUrl && !stream.url) return true;
  return false;
}

function wrapPlayableUrl(stream, baseUrl) {
  if (isWebOnly(stream)) return null;
  const fromQuery = unwrapManifest(stream.url);
  const fromHints = headersFromStream(stream);
  const referer = fromQuery.referer || fromHints.referer || 'https://embed.st/';
  const origin = fromQuery.origin || fromHints.origin || (() => {
    try { return new URL(referer).origin; } catch (_) { return 'https://embed.st'; }
  })();
  const targetUrl = fromQuery.targetUrl;
  if (!targetUrl) return null;
  const root = String(baseUrl || '').replace(/\/$/, '');
  return `${root}/api/manifest?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
}

function pickPlayableStream(streams) {
  const list = Array.isArray(streams) ? streams : [];
  for (const s of list) {
    if (!isWebOnly(s)) return s;
  }
  return null;
}

module.exports = {
  wrapPlayableUrl,
  pickPlayableStream,
  isWebOnly,
  unwrapManifest
};
