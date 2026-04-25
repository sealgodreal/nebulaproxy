// ts code so beautiful twin
// i fixed sum of like the most important bugs like requests and js rewriting
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { CookieJar } = require("tough-cookie");
const { createProxyServer } = require("http-proxy");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

const wsProxy = createProxyServer({ changeOrigin: true, secure: false, ws: true });

const PREFIX = "/lessons/math";
const PROXY = "https://onlinehomeworkhelper.onrender.com"; // http://localhost:3000
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
      if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:")) return m;
      const abs = new URL(u, base).href;
      return `fetch(${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/\.open\s*\(\s*(['"`][A-Z]+['"`])\s*,\s*(['"`])(\/?[^'"` ]+)\2/g, (m, method, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:")) return m;
      const abs = new URL(u, base).href;
      return `.open(${method}, ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/location\.href\s*=\s*(['"`])([^'"` ]+)\1/g, (m, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:")) return m;
      const abs = new URL(u, base).href;
      return `location.href = ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/window\.location\s*=\s*(['"`])([^'"` ]+)\1/g, (m, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:")) return m;
      const abs = new URL(u, base).href;
      return `window.location = ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/window\.open\s*\(\s*(['"`])([^'"` ]+)\1/g, (m, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:")) return m;
      const abs = new URL(u, base).href;
      return `window.open(${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/\.src\s*=\s*(['"`])([^'"` ]+)\1/g, (m, q, u) => {
    try {
      if (u.startsWith("data:") || u.startsWith("blob:")) return m;
      const abs = new URL(u, base).href;
      return `.src = ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  return js;
}

function rewriteHtmlAttrs(body, base) {
  body = body.replace(/(src|href|action|poster|data|formaction|ping|launch)\s*=\s*(['"])([^'"]+)\2/gi, (m, attr, q, u) => {
    return `${attr}=${q}${proxify(u, base)}${q}`;
  });

  body = body.replace(/srcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, val) => {
    const rewritten = val.replace(/([^\s,]+)(\s*(?:\d+[wx])?)(?=,|$)/g, (mm, u, desc) => {
      return proxify(u, base) + desc;
    });
    return `srcset=${q}${rewritten}${q}`;
  });

  body = body.replace(/on\w+\s*=\s*(['"])([^'"]*(?:https?:\/\/|javascript:)[^'"]*)\1/gi, (m, q, code) => {
    const rewritten = code
      .replace(/(https?:\/\/[^\s"'<>]+)/g, u => proxify(u, base))
      .replace(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/g, (mm, u) => `window.location.href = '${proxify(u, base)}'`)
      .replace(/location\.href\s*=\s*['"]([^'"]+)['"]/g, (mm, u) => `location.href = '${proxify(u, base)}'`);
    return `on${m.substring(2, 3).toLowerCase()}${m.substring(3, m.indexOf('='))}=${q}${rewritten}${q}`;
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
      if (
        !url ||
        typeof url !== 'string' ||
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.startsWith("javascript:") ||
        url.startsWith("#") ||
        url.startsWith("mailto:") ||
        url.startsWith("tel:") ||
        url.includes("/lessons/math?url=")
      ) return url;

      const base = BASE || window.location.href;
      const abs = new URL(url, base).href;

      return "/lessons/math?url=" + encodeURIComponent(abs) +
             "&origin=" + encodeURIComponent(ORIGIN);
    } catch {
      return url;
    }
  }

  function proxifyWs(url) {
    try {
      if (url.includes("/lessons/math")) return url;
      const abs = new URL(url, BASE).href;
      return "/lessons/math?url=" + encodeURIComponent(abs) + "&origin=" + encodeURIComponent(ORIGIN);
    } catch { return url; }
  }

  let _baseUrl;
  try { _baseUrl = new URL(BASE); } catch { _baseUrl = new URL("https://example.com"); } // yes, example.com

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
    if (el.dataset.proxified) return;
    el.dataset.proxified = "1";
    try {
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === "SCRIPT") return;

      const urlAttrs = ["href", "src", "action", "launch", "poster", "data", "formaction", "ping"];
      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        let value = attr.value;
        if (!value) continue;

        if (urlAttrs.includes(name)) {
          if (!value.includes("/lessons/math?url=")) {
            el.setAttribute(attr.name, proxify(value));
          }
        }
        else if (name === "srcset") {
          const rewritten = value.replace(/([^\\s,]+)(\\s+[\\d.]+[wx])?/g, (m, url, desc) => {
            return proxify(url) + (desc || "");
          });
          if (rewritten !== value) el.setAttribute(attr.name, rewritten);
        }
        else if (/^on/.test(name) && typeof value === "string") {
          const rewritten = value
            .replace(/(https?:\\/\\/[^\\s"'<>]+)/g, proxify)
            .replace(/window\\.location\\.href\\s*=\\s*['"](.*?)['"]/g, (m, u) => {
              return "window.location.href = '" + proxify(u) + "'";
            })
            .replace(/location\\.href\\s*=\\s*['"](.*?)['"]/g, (m, u) => {
              return "location.href = '" + proxify(u) + "'";
            });
          if (rewritten !== value) el.setAttribute(attr.name, rewritten);
        }
        else if (name.startsWith("data-") && typeof value === "string") {
          if (value.match(/^https?:\\/\\//) || value.match(/^\\/[\\w]/)) {
            el.setAttribute(attr.name, proxify(value));
          }
        }
      }

      if (el.hasAttribute("style")) {
        const css = el.getAttribute("style");
        const rewritten = css.replace(/url\\(\\s*(['\"]?)([^'")]+)\\1\\s*\\)/gi, (m, q, u) => {
          return "url(" + q + proxify(u) + q + ")";
        });
        if (rewritten !== css) el.setAttribute("style", rewritten);
      }
    } catch {}
  }

  window.addEventListener("load", () => {
    document.querySelectorAll("*").forEach(fixEl);

    new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          fixEl(n);
          n.querySelectorAll && n.querySelectorAll("*").forEach(fixEl);
        }
      }));
    }).observe(document, { childList: true, subtree: true });
  });

  const origFetch = window.fetch;
  window.fetch = async function(url, ...args) {
    try {
      if (typeof url === 'string') {
        url = proxify(url);
      } else if (url && typeof url === 'object' && url.url) {
        url = new Request(proxify(url.url), url);
      }
    } catch {}
    return origFetch.call(this, url, ...args);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    try { 
      url = proxify(url); 
    } catch {}
    return _open.call(this, method, url, async, user, pass);
  };

  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(data) {
    return _send.call(this, data);
  };

  const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    return _setReqHeader.call(this, header, value);
  };

  const _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      const abs = new URL(url, BASE).href;
      const wsUrl = abs.replace(/^https?:/, location.protocol === "https:" ? "wss:" : "ws:");
      return protocols ? new _WS(wsUrl, protocols) : new _WS(wsUrl);
    } catch {
      return protocols ? new _WS(url, protocols) : new _WS(url);
    }
  };

  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function(s, t, u) {
    if (u && !String(u).includes("/lessons/math")) {
      return _push(s, t, proxify(String(u)));
    }
    return _push(s, t, u);
  };
  history.replaceState = function(s, t, u) {
    if (u && !String(u).includes("/lessons/math")) {
      return _replace(s, t, proxify(String(u)));
    }
    return _replace(s, t, u);
  };

  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const raw = a.getAttribute("href");
    if (!raw || raw.startsWith("/lessons/math") || raw.startsWith("javascript:") || raw.startsWith("#")) return;
    e.preventDefault();
    location.href = proxify(raw);
  }, true);

  document.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    const action = f.getAttribute("action") || "";
    if (!action || action.includes("/lessons/math")) {
      return f.submit();
    }
    const fd = new FormData(f);
    const q = new URLSearchParams(fd).toString();
    location.href = proxify(action + (q ? "?" + q : ""));
  }, true);

  const origImage = window.Image;
  window.Image = function() {
    const img = new origImage();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(img), 'src');
    Object.defineProperty(img, 'src', {
      set(val) { desc.set.call(this, proxify(val)); },
      get() { return desc.get.call(this); },
      configurable: true
    });
    return img;
  };

  const origOpen = window.open;
  window.open = function(url, target, features) {
    if (url) url = proxify(url);
    return origOpen(url, target, features);
  };

  const scriptProto = HTMLScriptElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(scriptProto, 'src') || {
    set: function(val) { this.setAttribute('src', val); },
    get: function() { return this.getAttribute('src'); }
  };
  Object.defineProperty(scriptProto, 'src', {
    set(val) { srcDesc.set.call(this, proxify(val)); },
    get() { return srcDesc.get.call(this); },
    configurable: true
  });

  const imgProto = HTMLImageElement.prototype;
  const imgSrcDesc = Object.getOwnPropertyDescriptor(imgProto, 'src') || {
    set: function(val) { this.setAttribute('src', val); },
    get: function() { return this.getAttribute('src'); }
  };
  Object.defineProperty(imgProto, 'src', {
    set(val) { imgSrcDesc.set.call(this, proxify(val)); },
    get() { return imgSrcDesc.get.call(this); },
    configurable: true
  });

  const elements = ['HTMLAnchorElement', 'HTMLLinkElement', 'HTMLScriptElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLAudioElement', 'HTMLSourceElement', 'HTMLIFrameElement'];
  elements.forEach(name => {
    try {
      const proto = window[name]?.prototype;
      if (!proto) return;
      
      if (name !== 'HTMLImageElement' && name !== 'HTMLScriptElement') {
        const desc = Object.getOwnPropertyDescriptor(proto, 'href') || Object.getOwnPropertyDescriptor(proto, 'src');
        if (desc) {
          Object.defineProperty(proto, 'href', {
            set(val) { desc.set?.call(this, proxify(val)) || this.setAttribute('href', proxify(val)); },
            get() { return desc.get?.call(this) || this.getAttribute('href'); },
            configurable: true
          });
          Object.defineProperty(proto, 'src', {
            set(val) { desc.set?.call(this, proxify(val)) || this.setAttribute('src', proxify(val)); },
            get() { return desc.get?.call(this) || this.getAttribute('src'); },
            configurable: true
          });
        }
      }
    } catch {}
  });

})();
</script>`;
}


app.all(PREFIX, async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("missing url");

  const origin = req.query.origin || target;

  try {
    let jar = cookieJarMap.get(origin);
    if (!jar) {
      jar = new CookieJar();
      cookieJarMap.set(origin, jar);
    }

    const cookies = await jar.getCookieString(target);

    const headers = { ...req.headers };

    const hopByHop = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "transfer-encoding",
      "upgrade",
      "host",
      "content-length"
    ]);

    for (const h of hopByHop) delete headers[h];

    headers["user-agent"] = headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    headers["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    headers["accept-language"] = "en-US,en;q=0.9";
    headers["accept-encoding"] = "identity";
    headers["connection"] = "keep-alive";
    headers["upgrade-insecure-requests"] = "1";
    headers["cache-control"] = "no-cache";
    headers["cookie"] = cookies;
    headers["referer"] = origin;
    headers["origin"] = origin;
    if (req.headers.range) { headers["range"] = req.headers.range; } // kinda useless

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = req.body;

      const ct = req.headers["content-type"] || "";

      if (Buffer.isBuffer(body)) {
      } else if (typeof body === "object" && ct.includes("application/json")) {
        body = JSON.stringify(body);
      } else if (typeof body === "object" && ct.includes("application/x-www-form-urlencoded")) {
        body = new URLSearchParams(body).toString();
      } else if (typeof body !== "string" && body) {
        body = String(body);
      }
    }

    const response = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      agent: target.startsWith("https") ? httpsAgent : httpAgent
    });

    const setCookieHeader = response.headers.raw?.()["set-cookie"];
    if (setCookieHeader) {
      setCookieHeader.forEach(c => jar.setCookieSync(c, target));
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (loc) {
        const newUrl = new URL(loc, target).href;

        return res.redirect(
          `${PREFIX}?url=${encodeURIComponent(newUrl)}&origin=${encodeURIComponent(origin)}`
        );
      }
    }

    const contentType = response.headers.get("content-type") || "";
    res.status(response.status);

    for (const h of ["content-type", "content-length", "accept-ranges", "content-range"]) {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (contentType.includes("text/html")) {
      let body = await response.text();

      body = rewriteHtmlAttrs(body, target);
      body = rewriteInlineStyles(body, target);
      body = rewriteStyleBlocks(body, target);

      const script = clientScript(origin, target);

      body = /<\/head>/i.test(body)
        ? body.replace(/<\/head>/i, script + "</head>")
        : script + body;

      return res.send(body);
    }

    if (contentType.includes("text/css")) {
      const css = await response.text();
      return res.type("text/css").send(rewriteCss(css, target));
    }

    if (contentType.includes("javascript")) {
      const js = await response.text();
      return res.type("application/javascript").send(rewriteJs(js, target));
    }

    if (response.body) {
      return response.body.pipe(res);
    }

    res.end();

  } catch (e) {
    res.status(500).send("proxy error: " + e.message);
  }
});

app.use((req, res) => {
  if (req.path.startsWith(PREFIX)) return res.status(404).send("not found");

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

  return res.status(400).send(`something went wrong.`);
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