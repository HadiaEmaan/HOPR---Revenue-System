'use strict';

const serverHandler = require('../server');

module.exports = (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const parsedQuery = request.query && typeof request.query === 'object' ? request.query : {};
  const queryPath = parsedQuery.__pms_path;
  const forwardedPath = url.searchParams.get('__pms_path')
    || (Array.isArray(queryPath) ? queryPath[0] : queryPath);
  let targetPath = url.pathname;
  let resolvedRoute = url.pathname;
  if (typeof forwardedPath === 'string') {
    const originalUrl = new URL(forwardedPath, 'http://localhost');
    if (originalUrl.origin === 'http://localhost'
      && forwardedPath.startsWith('/')
      && !forwardedPath.startsWith('//')) {
      resolvedRoute = originalUrl.pathname.startsWith('/api/')
        ? `/api/${originalUrl.pathname.split('/')[2] || ''}`
        : originalUrl.pathname;
      targetPath = originalUrl.pathname.startsWith('/api/') ? '/api/[route]' : originalUrl.pathname;
      const searchParams = new URLSearchParams(url.search);
      searchParams.delete('__pms_path');
      for (const [key, value] of Object.entries(parsedQuery)) {
        if (key === '__pms_path' || searchParams.has(key)) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          if (typeof item === 'string') searchParams.append(key, item);
        }
      }
      request.url = `${originalUrl.pathname}${searchParams.size ? `?${searchParams}` : ''}`;
    }
  }
  if (process.env.VERCEL) {
    const queryKeys = new Set([...url.searchParams.keys(), ...Object.keys(parsedQuery)]);
    const safeQuery = Object.fromEntries([...queryKeys].map(key => [
      key,
      key === '__pms_path' ? targetPath : '[redacted]'
    ]));
    console.log('[pms-vercel-request]', {
      reqUrl: `${url.pathname}${url.search ? '?<redacted>' : ''}`,
      reqQuery: safeQuery,
      resolvedRoute,
      resolvedTarget: targetPath
    });
  }
  return serverHandler(request, response);
};