const TARGET = 'http://tex.ravenhost.space:17730';

export default async function handler(req, res) {
  try {
    const pathParts = req.query.path || [];
    const path = Array.isArray(pathParts) ? pathParts.join('/') : pathParts;
    const qs = new URL(req.url, `https://${req.headers.host}`).search;
    const targetUrl = `${TARGET}/${path}${qs}`;

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host', 'connection', 'content-length'].includes(key.toLowerCase()) && value != null) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    headers.host = new URL(TARGET).host;

    const init = {
      method: req.method,
      headers,
      redirect: 'manual'
    };

    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = req;
    }

    const upstream = await fetch(targetUrl, init);
    const contentType = upstream.headers.get('content-type') || '';

    // Redirects must stay inside the HTTPS Vercel proxy.
    const location = upstream.headers.get('location');
    if (location) {
      const absolute = new URL(location, TARGET);
      if (absolute.hostname === new URL(TARGET).hostname && absolute.port === new URL(TARGET).port) {
        const proxiedPath = absolute.pathname.replace(/^\//, '');
        const proxied = `/api/proxy/${proxiedPath}${absolute.search}`;
        res.setHeader('Location', proxied);
      } else {
        res.setHeader('Location', location);
      }
    }

    const passHeaders = [
      'content-type', 'cache-control', 'etag', 'last-modified',
      'content-encoding', 'accept-ranges', 'vary'
    ];
    for (const name of passHeaders) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    // These headers can prevent the proxied page from being embedded.
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');

    res.status(upstream.status);

    if (req.method === 'HEAD') {
      return res.end();
    }

    let body = Buffer.from(await upstream.arrayBuffer());

    // Make common absolute-root links/assets point back through the proxy.
    // This is intentionally limited to HTML so binary assets are untouched.
    if (contentType.includes('text/html')) {
      let html = body.toString('utf8');
      html = html.replace(/\b(href|src|action)=(['"])\/(?!\/)/gi, '$1=$2/api/proxy/');
      html = html.replace(/url\((['"]?)\/(?!\/)/gi, 'url($1/api/proxy/');
      body = Buffer.from(html, 'utf8');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.removeHeader('content-encoding');
    }

    res.end(body);
  } catch (err) {
    res.status(502).json({
      error: 'Proxy gagal menghubungi website tujuan.',
      detail: String(err.message || err)
    });
  }
}
