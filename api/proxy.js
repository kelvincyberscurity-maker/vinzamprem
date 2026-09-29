const TARGET = 'http://tex.ravenhost.space:17730';
const TARGET_URL = new URL(TARGET);

function proxiedPath(pathname, search = '') {
  return '/proxy' + (pathname.startsWith('/') ? pathname : '/' + pathname) + search;
}

function rewriteLocation(value) {
  if (!value) return value;
  try {
    const u = new URL(value, TARGET_URL);
    if (u.hostname === TARGET_URL.hostname && String(u.port || '80') === String(TARGET_URL.port || '80')) {
      return proxiedPath(u.pathname, u.search);
    }
  } catch (_) {}
  return value;
}

function rewriteUrls(text) {
  // Absolute backend URLs.
  text = text.replaceAll(TARGET, '/proxy');
  text = text.replaceAll('https://tex.ravenhost.space:17730', '/proxy');
  text = text.replaceAll('http://tex.ravenhost.space:17730', '/proxy');

  // Root-relative application endpoints/assets.
  text = text.replace(/(["'`(=:\s])\/(?!proxy(?:\/|["'`?\s)]))(api|assets|static|public|uploads|media|_next|favicon\.ico|robots\.txt)(?=[\/"'`?\s)]|$)/gi, '$1/proxy/$2');

  // Common relative endpoints used by fetch/axios.
  text = text.replace(/(["'`])\/(?!proxy(?:\/|["'`?]))/g, '$1/proxy/');
  return text;
}

const INJECT = `
<script>
(function(){
  const P='/proxy';
  const ORIGIN='http://tex.ravenhost.space:17730';
  function map(v){
    if(typeof v!=='string') return v;
    if(v.indexOf(ORIGIN)===0) return P+v.slice(ORIGIN.length);
    if(/^https?:\\/\\/tex\\.ravenhost\\.space:17730/i.test(v)) return P+v.replace(/^https?:\\/\\/tex\\.ravenhost\\.space:17730/i,'');
    if(v.charAt(0)==='/' && v.indexOf('/proxy')!==0) return P+v;
    return v;
  }
  const oldFetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(input instanceof Request){
        const u=map(input.url);
        if(u!==input.url) input=new Request(u,input);
      } else input=map(input);
    }catch(e){}
    return oldFetch.call(this,input,init);
  };
  const oldOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    try{arguments[1]=map(url);}catch(e){}
    return oldOpen.apply(this,arguments);
  };
  if(window.WebSocket){
    const WS=window.WebSocket;
    window.WebSocket=function(url,protocols){
      try{url=map(url).replace(/^http:/,'ws:').replace(/^https:/,'wss:');}catch(e){}
      return protocols===undefined?new WS(url):new WS(url,protocols);
    };
    window.WebSocket.prototype=WS.prototype;
  }
})();
</script>`;

function rewriteHtml(text) {
  text = rewriteUrls(text);
  if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, m => m + INJECT);
  return INJECT + text;
}

async function readBody(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  try {
    let p = req.query && req.query.path ? req.query.path : '';
    if (Array.isArray(p)) p=p.join('/');
    p=String(p||'').replace(/^\/+/, '');

    const incoming = new URL(req.url, `https://${req.headers.host}`);
    const target = new URL(TARGET_URL);
    target.pathname='/' + p;
    target.search='';
    for(const [k,v] of incoming.searchParams){
      if(k!=='path') target.searchParams.append(k,v);
    }

    const headers={};
    for(const [k,v] of Object.entries(req.headers||{})){
      const key=k.toLowerCase();
      if(!['host','connection','content-length','transfer-encoding','x-forwarded-host','x-forwarded-proto','x-forwarded-for'].includes(key) && v!=null){
        headers[k]=Array.isArray(v)?v.join(', '):v;
      }
    }
    headers.host=TARGET_URL.host;
    headers['x-forwarded-proto']='http';

    const init={method:req.method,headers,redirect:'manual'};
    if(!['GET','HEAD'].includes(req.method)){
      const body=await readBody(req);
      if(body.length) init.body=body;
    }

    const upstream=await fetch(target,init);
    const type=upstream.headers.get('content-type')||'';

    const location=upstream.headers.get('location');
    if(location) res.setHeader('Location',rewriteLocation(location));

    if(typeof upstream.headers.getSetCookie==='function'){
      const cookies=upstream.headers.getSetCookie();
      if(cookies.length) res.setHeader('Set-Cookie',cookies.map(c=>c.replace(/;\\s*Domain=[^;]+/gi,'').replace(/;\\s*Path=\//gi,'; Path=/proxy/')));
    } else {
      const cookie=upstream.headers.get('set-cookie');
      if(cookie) res.setHeader('Set-Cookie',cookie.replace(/;\\s*Domain=[^;]+/gi,'').replace(/;\\s*Path=\//gi,'; Path=/proxy/'));
    }

    for(const h of ['cache-control','etag','last-modified','accept-ranges','vary']){
      const v=upstream.headers.get(h); if(v) res.setHeader(h,v);
    }
    res.statusCode=upstream.status;
    if(req.method==='HEAD') return res.end();

    let body=Buffer.from(await upstream.arrayBuffer());
    const textual=/^(text\/|application\/(javascript|json|x-javascript)|image\/svg\+xml)/i.test(type);
    if(textual){
      let text=body.toString('utf8');
      if(/text\/html/i.test(type)) text=rewriteHtml(text); else text=rewriteUrls(text);
      body=Buffer.from(text,'utf8');
      res.setHeader('content-type',type.includes('charset=')?type:(type+'; charset=utf-8'));
    } else if(type) res.setHeader('content-type',type);

    res.removeHeader('content-encoding');
    res.removeHeader('content-length');
    res.removeHeader('transfer-encoding');
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.end(body);
  } catch(err) {
    res.statusCode=502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({ok:false,error:'PROXY_ERROR',detail:String(err&&err.message||err),target:TARGET}));
  }
};
