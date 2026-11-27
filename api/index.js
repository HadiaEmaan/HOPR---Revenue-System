'use strict';

const serverHandler = require('../server');

module.exports = (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const parsedQuery = request.query && typeof request.query === 'object' ? request.query : {};
  const queryPath = parsedQuery.__pms_path;
  const forwardedPath = url.searchParams.get('__pms_path')
    || (Array.isArray(queryPath) ? queryPath[0] : queryPath);
  if (typeof forwardedPath === 'string') {
    const originalUrl = new URL(forwardedPath, 'http://localhost');
    if (originalUrl.origin === 'http://localhost'
      && forwardedPath.startsWith('/')
      && !forwardedPath.startsWith('//')) {
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
  return serverHandler(request, response);
};