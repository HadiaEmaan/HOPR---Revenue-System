'use strict';

const serverHandler = require('../server');
const routeOrigin = 'http://localhost';

function firstString(value) {
  if (Array.isArray(value)) return value.find(item => typeof item === 'string');
  return typeof value === 'string' ? value : undefined;
}

function parseApiPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  const parsed = new URL(value, routeOrigin);
  if (parsed.origin !== routeOrigin
    || !parsed.pathname.startsWith('/api/')
    || parsed.pathname === '/api/index'
    || parsed.pathname.includes(':')
    || parsed.pathname.includes('*')
    || parsed.pathname.includes('[')
    || parsed.pathname.includes(']')) return null;
  return parsed;
}

function apiPathFromSource(value) {
  const directPath = parseApiPath(value);
  if (directPath) return directPath;
  if (typeof value !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(value, routeOrigin);
  } catch {
    return null;
  }
  return parseApiPath(parsed.searchParams.get('__pms_path'));
}

function pathFromRouteMatches(value) {
  const directPath = apiPathFromSource(value);
  if (directPath) return `${directPath.pathname}${directPath.search}`;
  if (typeof value !== 'string') return null;
  const matches = new URLSearchParams(value);
  for (const key of ['__pms_path', 'path', 'route', '1']) {
    const matchedValue = matches.get(key);
    if (typeof matchedValue !== 'string' || !matchedValue) continue;
    const candidate = matchedValue.startsWith('/api/')
      ? matchedValue
      : `/api/${matchedValue.replace(/^\/+/, '')}`;
    const parsed = parseApiPath(candidate);
    if (parsed) return `${parsed.pathname}${parsed.search}`;
  }
  return null;
}

function safeRoute(value) {
  const parsed = parseApiPath(value);
  if (parsed) return `/api/${parsed.pathname.split('/')[2] || ''}`;
  if (typeof value === 'string' && value.startsWith('/')) {
    const parsedPath = new URL(value, routeOrigin);
    return parsedPath.pathname === '/api/index' ? '/api/index' : '[non-api]';
  }
  return null;
}

function safePathSource(value) {
  const resolvedPath = apiPathFromSource(value);
  return resolvedPath ? safeRoute(resolvedPath.pathname) : safeRoute(value);
}

function safeRequestUrl(value) {
  let parsed;
  try {
    parsed = new URL(value || '/', routeOrigin);
  } catch {
    return '[invalid]';
  }
  const query = [...parsed.searchParams].map(([key, item]) => [
    key,
    key === '__pms_path' ? safeRoute(item) || '[invalid]' : '[redacted]'
  ]);
  const queryString = query.map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`).join('&');
  return `${parsed.pathname}${queryString ? `?${queryString}` : ''}`;
}

function resolveRequestPath(request, url = new URL(request.url || '/', `http://${request.headers?.host || 'localhost'}`)) {
  const parsedQuery = request.query && typeof request.query === 'object' ? request.query : {};
  const headers = request.headers || {};
  const queryPath = firstString(url.searchParams.get('__pms_path')) || firstString(parsedQuery.__pms_path);
  const candidates = [
    queryPath,
    apiPathFromSource(request.originalUrl),
    apiPathFromSource(firstString(headers['x-vercel-matched-path'])),
    apiPathFromSource(firstString(headers['x-matched-path'])),
    apiPathFromSource(firstString(headers['x-invoke-path'])),
    pathFromRouteMatches(firstString(headers['x-now-route-matches'])),
    url.pathname
  ];
  return candidates.map(value => value instanceof URL ? value : parseApiPath(value)).find(Boolean) || url;
}

const handler = (request, response) => {
  const rawUrl = request.url || '/';
  const url = new URL(rawUrl, `http://${request.headers?.host || 'localhost'}`);
  const parsedQuery = request.query && typeof request.query === 'object' ? request.query : {};
  const queryPath = firstString(url.searchParams.get('__pms_path')) || firstString(parsedQuery.__pms_path);
  const headers = request.headers || {};
  const matchedPath = firstString(headers['x-matched-path']);
  const invokePath = firstString(headers['x-invoke-path']);
  const vercelMatchedPath = firstString(headers['x-vercel-matched-path']);
  const routeMatches = firstString(headers['x-now-route-matches']);
  const routeMatchPath = pathFromRouteMatches(routeMatches);
  const targetUrl = resolveRequestPath(request, url);
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete('__pms_path');
  for (const [key, value] of Object.entries(parsedQuery)) {
    if (key === '__pms_path' || searchParams.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') searchParams.append(key, item);
    }
  }
  if (targetUrl) {
    for (const [key, value] of targetUrl.searchParams) {
      if (key !== '__pms_path' && !searchParams.has(key)) searchParams.append(key, value);
    }
    request.url = `${targetUrl.pathname}${searchParams.size ? `?${searchParams}` : ''}`;
  } else if (url.searchParams.has('__pms_path')) {
    request.url = `${url.pathname}${searchParams.size ? `?${searchParams}` : ''}`;
  }

  if (process.env.VERCEL) {
    const queryKeys = new Set([...url.searchParams.keys(), ...Object.keys(parsedQuery)]);
    const safeQuery = Object.fromEntries([...queryKeys].map(key => {
      const value = key === '__pms_path'
        ? queryPath
        : '[redacted]';
      return [key, key === '__pms_path' ? safeRoute(value) || '[invalid]' : value];
    }));
    console.log('[pms-incoming-req]', JSON.stringify({
      method: request.method,
      url: safeRequestUrl(rawUrl),
      originalUrl: request.originalUrl ? safeRequestUrl(request.originalUrl) : null,
      query: safeQuery,
      headers: {
        matched: safePathSource(matchedPath),
        invoke: safePathSource(invokePath),
        vercelUrl: firstString(headers['x-vercel-deployment-url']) || null,
        nowMatches: safeRoute(routeMatchPath) || (routeMatches ? '[present]' : null),
        allKeys: Object.keys(headers)
      },
      routeMatches: safeRoute(routeMatchPath) || (routeMatches ? '[present]' : null),
      resolvedRoute: targetUrl ? safeRoute(targetUrl.pathname) : safeRoute(url.pathname),
      resolvedPathname: targetUrl.pathname
    }));
  }
  return serverHandler(request, response);
};

handler.resolveRequestPath = resolveRequestPath;
module.exports = handler;
