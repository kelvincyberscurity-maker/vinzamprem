const TARGET = 'http://tex.ravenhost.space:17730';

module.exports = async function handler(req, res) {
  try {
    let p = req.query && req.query.path ? req.query.path : '';
    if (Array.isArray(p)) p = p.join('/');
    p = String(p || '').replace(/^\/+/, '');

    const incoming = new URL(req.url, `https://${req.headers.host}`);
    const qs = new URLSearchParams(incoming.searchParams);
    qs.delete('path');
    const target = new URL(TARGET + '/' + p);
    for (const [k,v] of qs) target.searchParams.append(k,v);

    const headers = {};
    for (const [k,v] of Object.entries(req.headers || {})) {
      if (!['host','connection','content-length'].includes(k.toLowerCase()) && v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    headers.host = new URL(TARGET).host;

    const init = { method:req.method, headers, redirect:'manual' };
    if (!['GET','HEAD'].includes(req.method)) init.body = req;

    const upstream = await fetch(target, init);
    const type = upstream.headers.get('content-type') || '';
    const location = upstream.headers.get('location');

    if (location) {
      const u = new URL(location, TARGET);
      const t = new URL(TARGET);
      if (u.hostname === t.hostname && u.port === t.port) {
        res.setHeader('Location', '/proxy/' + u.pathname.replace(/^\//,'') + u.search);
      } else res.setHeader('Location', location);
    }

    for (const h of ['cache-control','etag','last-modified','accept-ranges','vary']) {
      const v = upstream.headers.get(h); if (v) res.setHeader(h,v);
    }
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.statusCode = upstream.status;

    if (req.method === 'HEAD') return res.end();

    let body = Buffer.from(await upstream.arrayBuffer());
    if (type.includes('text/html')) {
      let html = body.toString('utf8');
      html = html.replace(/\b(href|src|action)=(['"])\/(?!\/)/gi, '$1=$2/proxy/');
      html = html.replace(/url\((['"]?)\/(?!\/)/gi, 'url($1/proxy/');
      body = Buffer.from(html,'utf8');
      res.setHeader('content-type','text/html; charset=utf-8');
    } else if (type) res.setHeader('content-type',type);
    res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:'Proxy gagal',detail:String(err.message || err)}));
  }
};
