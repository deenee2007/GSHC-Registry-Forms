/*
 * core/api.js — talks to the server.
 * Every call carries the X-Requested-With header the server requires.
 * A dropped connection raises an OfflineError so callers can fall back to
 * saving drafts on this computer.
 */
(function () {
  window.App = window.App || {};

  class ApiError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body; }
  }
  class OfflineError extends Error {
    constructor() { super('No connection to the server. You appear to be offline.'); this.offline = true; }
  }

  let onUnauthorized = null;

  async function request(method, path, body) {
    const opts = { method, headers: { 'X-Requested-With': 'GSHC' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }

    let res;
    try { res = await fetch('/api' + path, opts); }
    catch (e) { throw new OfflineError(); }

    // The service worker answers 503 + offline:true when it has nothing cached.
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => ({})) : null;
    if (res.status === 503 && data && data.offline) throw new OfflineError();
    if (!res.ok) {
      const err = new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`, data);
      if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/')) onUnauthorized(err);
      throw err;
    }
    return data;
  }

  window.App.api = {
    ApiError, OfflineError,
    get:  (p)    => request('GET', p),
    post: (p, b) => request('POST', p, b === undefined ? {} : b),
    put:  (p, b) => request('PUT', p, b),
    patch:(p, b) => request('PATCH', p, b),
    del:  (p)    => request('DELETE', p),
    onUnauthorized(fn) { onUnauthorized = fn; },
    online: () => navigator.onLine !== false,
    qs(params) {
      const s = new URLSearchParams();
      Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') s.set(k, v); });
      const str = s.toString();
      return str ? '?' + str : '';
    }
  };
})();
