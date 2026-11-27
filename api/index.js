'use strict';

const serverHandler = require('../server');

module.exports = (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const forwardedPath = url.searchParams.get('__pms_path');
  if (forwardedPath) {
    const originalUrl = new URL(forwardedPath, 'http://localhost');
    if (originalUrl.origin === 'http://localhost' && originalUrl.pathname.startsWith('/api/')) {
      url.searchParams.delete('__pms_path');
      request.url = `${originalUrl.pathname}${url.search}`;
    }
  }
  return serverHandler(request, response);
};
