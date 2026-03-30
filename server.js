// ts code so beautiful twin
const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { CookieJar } = require("tough-cookie");
const { createProxyServer } = require("http-proxy");

const app = express();

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const wsProxy = createProxyServer({ changeOrigin: true, secure: false, ws: true });

const PREFIX = "/lessons/math";
const PROXY = "https://k3v9q1x8b4m2f7z6r0.onrender.com"; // http://localhost:3000 - for testin
const cookieJarMap = new Map();

function encode(url) { return encodeURIComponent(url); }

function proxify(url, base) {
  try {
    if (!url || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("#")) return url;
    if (url.includes(PREFIX)) return url;
    const abs = new URL(url, base).href;
    return `${PREFIX}?url=${encode(abs)}&origin=${encode(base)}`;
  } catch {
    return url;
  }
}

function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    return `url(${q}${proxify(u, base)}${q})`;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    return `@import ${q}${proxify(u, base)}${q}`;
  });
  return css;
}

function rewriteJs(js, base) {
  js = js.replace(/\bfetch\s*\(\s*(['"`])(\/?[^'"` ]+)\1/g, (m, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:")) return m;
      const abs = new URL(u, base).href;
      return `fetch(${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/\.open\s*\(\s*(['"`][A-Z]+['"`])\s*,\s*(['"`])(\/?[^'"` ]+)\2/g, (m, method, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:")) return m;
      const abs = new URL(u, base).href;
      return `.open(${method}, ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  return js;
}

function rewriteHtmlAttrs(body, base) {
  body = body.replace(/(src|href|action)\s*=\s*(['"])([^'"]+)\2/gi, (m, attr, q, u) => {
    return `${attr}=${q}${proxify(u, base)}${q}`;
  });

  body = body.replace(/srcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, val) => {
    const rewritten = val.replace(/([^\s,]+)(\s*(?:\d+[wx])?)(?=,|$)/g, (mm, u, desc) => {
      return proxify(u, base) + desc;
    });
    return `srcset=${q}${rewritten}${q}`;
  });

  return body;
}

function rewriteInlineStyles(body, base) {
  return body.replace(/style\s*=\s*(['"])([^'"]*)\1/gi, (m, q, css) => {
    return `style=${q}${rewriteCss(css, base)}${q}`;
  });
}

function rewriteStyleBlocks(body, base) {
  return body.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => {
    return `<style${attrs}>${rewriteCss(css, base)}</style>`;
  });
}

function clientScript(origin, base) {
  return `
<script>
(function(){
  const ORIGIN = ${JSON.stringify(origin)};
  let BASE = ${JSON.stringify(base)};
  const PROXY = ${JSON.stringify(PROXY)};

  try {
    const _params = new URLSearchParams(window.location.search);
    if (_params.get('url')) BASE = decodeURIComponent(_params.get('url'));
  } catch {}

  function proxify(url) {
    try {
      if (!url || url.startsWith("data:") || url.startsWith("blob:") ||
          url.startsWith("javascript:") || url.startsWith("#")) return url;
      if (url.includes("/lessons/math")) return url;
      const base = BASE || window.location.href;
      const abs = new URL(url, base).href;
      return "/lessons/math?url=" + encodeURIComponent(abs) + "&origin=" + encodeURIComponent(ORIGIN);
    } catch { return url; }
  }

  function proxifyWs(url) {
    try {
      if (url.includes("/lessons/math")) return url;
      const abs = new URL(url, BASE).href;
      return "/lessons/math?url=" + encodeURIComponent(abs) + "&origin=" + encodeURIComponent(ORIGIN);
    } catch { return url; }
  }

  let _baseUrl;
  try { _baseUrl = new URL(BASE); } catch { _baseUrl = new URL("https://example.com"); }

  const _realOrigin   = _baseUrl.origin;
  const _realHost     = _baseUrl.host;
  const _realHostname = _baseUrl.hostname;
  const _realPort     = _baseUrl.port;
  const _realProtocol = _baseUrl.protocol;
  const _realPathname = _baseUrl.pathname;

  const _locationProxy = new Proxy(location, {
    get(target, prop) {
      switch(prop) {
        case 'origin':   return _realOrigin;
        case 'host':     return _realHost;
        case 'hostname': return _realHostname;
        case 'port':     return _realPort;
        case 'protocol': return _realProtocol;
        case 'href':     return BASE;
        case 'pathname': return _realPathname;
        case 'assign':   return (url) => { target.href = proxify(url); };
        case 'replace':  return (url) => { target.replace(proxify(url)); };
        default:
          return typeof target[prop] === 'function'
            ? target[prop].bind(target)
            : target[prop];
      }
    },
    set(target, prop, value) {
      if (prop === 'href') { target.href = proxify(value); return true; }
      target[prop] = value;
      return true;
    }
  });

  try { Object.defineProperty(window, 'location', { get() { return _locationProxy; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(document, 'location', { get() { return _locationProxy; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(document, 'domain', { get() { return _realHostname; }, configurable: true }); } catch(e) {}

  function fixEl(el) {
    try {
      if (el.tagName === "SCRIPT") return;
      if (el.href && !el.href.includes("/lessons/math")) el.href = proxify(el.href);
      if (el.src && !el.src.includes("/lessons/math")) el.src = proxify(el.src);
      if (el.action && !el.action.includes("/lessons/math")) el.action = proxify(el.action);
      if (el.style && el.style.cssText) {
        el.style.cssText = el.style.cssText.replace(new RegExp('url\\(([\'"]?)([^\'"()]+)\\1\\)', 'g'), (m,q,u) => {
          return "url(" + q + proxify(u) + q + ")";
        });
      }
    } catch {}
  }

  document.querySelectorAll("*").forEach(fixEl);
  new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) { fixEl(n); n.querySelectorAll && n.querySelectorAll("*").forEach(fixEl); }
    }));
  }).observe(document, { childList: true, subtree: true });

  const _fetch = window.fetch;
  window.fetch = function(url, ...args) {
    try {
      if (typeof url === 'string') url = proxify(url);
      else if (url && url.url) url = new Request(proxify(url.url), url);
    } catch {}
    return _fetch(url, ...args);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try { url = proxify(url); } catch {}
    return _open.call(this, method, url, ...rest);
  };

  const _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      const proxied = proxifyWs(url);
      const wsUrl = proxied.replace(/^https?:/, location.protocol === "https:" ? "wss:" : "ws:");
      return protocols ? new _WS(wsUrl, protocols) : new _WS(wsUrl);
    } catch {
      return protocols ? new _WS(url, protocols) : new _WS(url);
    }
  };

  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function(s, t, u) {
    if (u && !String(u).includes("/lessons/math")) return _push(s, t, proxify(String(u)));
    return _push(s, t, u);
  };
  history.replaceState = function(s, t, u) {
    if (u && !String(u).includes("/lessons/math")) return _replace(s, t, proxify(String(u)));
    return _replace(s, t, u);
  };

  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (a) { e.preventDefault(); location.href = proxify(a.href); }
  }, true);

  document.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    const q = new URLSearchParams(new FormData(f)).toString();
    location.href = proxify(f.action + (q ? "?" + q : ""));
  }, true);

})();
</script>`;
}

app.get(PREFIX, async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  const origin = req.query.origin || target;

  try {
    let jar = cookieJarMap.get(origin);
    if (!jar) { jar = new CookieJar(); cookieJarMap.set(origin, jar); }

    const cookies = await jar.getCookieString(target);

    const response = await fetch(target, {
      agent: target.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
        "Referer": origin,
        "Origin": origin,
        "Cookie": cookies
      }
    });

    const setCookieHeader = response.headers.raw()["set-cookie"];
    if (setCookieHeader) setCookieHeader.forEach(c => jar.setCookieSync(c, target));

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (loc) {
        const newUrl = new URL(loc, target).href;
        return res.redirect(proxify(newUrl, origin));
      }
    }

    const contentType = response.headers.get("content-type") || "";

    res.status(response.status);
    ["content-type", "content-length", "accept-ranges", "content-range"].forEach(h => {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.removeHeader("content-security-policy");
    res.removeHeader("x-frame-options");

    if (contentType.includes("text/html")) {
      let body = await response.text();

      body = rewriteHtmlAttrs(body, target);
      body = rewriteInlineStyles(body, target);
      body = rewriteStyleBlocks(body, target);

      const script = clientScript(origin, target);
      if (/<\/head>/i.test(body)) body = body.replace(/<\/head>/i, `${script}</head>`);
      else body = script + body;

      return res.send(body);
    }

    if (contentType.includes("text/css")) {
      const css = await response.text();
      res.setHeader("content-type", "text/css");
      return res.send(rewriteCss(css, target));
    }

    if (contentType.includes("javascript")) {
      const js = await response.text();
      res.setHeader("content-type", contentType);
      return res.send(rewriteJs(js, target));
    }

    if (response.body) response.body.pipe(res);
    else res.end();

  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.use((req, res) => {
  if (req.path.startsWith(PREFIX)) return res.status(404).send("Not found");

  const referer = req.headers.referer || "";
  let origin = null;

  try {
    const refUrl = new URL(referer);
    const params = new URLSearchParams(refUrl.search);
    origin = params.get("origin") || params.get("url");
  } catch {}

  if (origin) {
    try {
      const target = new URL(req.originalUrl, origin).href;
      return res.redirect(`${PREFIX}?url=${encode(target)}&origin=${encode(origin)}`);
    } catch {}
  }

  return res.status(400).send(`Something went wrong.`);
});

const server = app.listen(3000, () => console.log("prxy runnin on port 3000 (used for testing)"));

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, PROXY);
    const target = url.searchParams.get("url");
    if (!target) return socket.destroy();

    const wsTarget = target.replace(/^http/, "ws");
    wsProxy.ws(req, socket, head, { target: wsTarget }, (err) => {
      if (err) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
});

wsProxy.on("error", (err, req, res) => {
  if (res && res.end) res.end();
});
