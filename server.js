const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { promisify } = require("util");
const { CookieJar } = require("tough-cookie");
const { createProxyServer } = require("http-proxy");
const cheerio = require("cheerio");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { parse } = require("meriyah");
const { generate } = require("astring");
const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);
const inflate = promisify(zlib.inflate);
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true, maxSockets: 64, maxFreeSockets: 16 });
const wsProxy = createProxyServer({ changeOrigin: true, secure: false, ws: true });
const PREFIX = "/lessons/math";
const PROXY = "https://onlinehomeworkhelper.onrender.com";
const cookieJarMap = new Map();
const responseCache = new Map();
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 300;
const CACHEABLE_CT = [
  "javascript", "ecmascript",
  "text/css",
  "image/",
  "font/",
  "application/font",
  "application/x-font",
  "application/woff",
];

function isCacheable(contentType, method) {
  if (method !== "GET") return false;
  return CACHEABLE_CT.some(t => contentType.includes(t));
}

function cacheGet(url) {
  const entry = responseCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_MAX_AGE_MS) {
    responseCache.delete(url);
    return null;
  }
  return entry;
}

function cacheSet(url, entry) {
  if (responseCache.size >= CACHE_MAX_SIZE) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(url, { ...entry, ts: Date.now() });
}

function encode(url) { return encodeURIComponent(url); }

function proxify(url, base) {
  try {
    if (!url || typeof url !== "string") return url;
    const trimmed = url.trim();
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("tel:")
    ) return url;
    if (trimmed.includes(PREFIX + "?url=")) return url;
    const normalized = trimmed.startsWith("//") ? "https:" + trimmed : trimmed;
    const abs = new URL(normalized, base).href;
    return `${PREFIX}?url=${encode(abs)}&origin=${encode(base)}`;
  } catch {
    return url;
  }
}

function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return m;
    return `url(${q}${proxify(u, base)}${q})`;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    return `@import ${q}${proxify(u, base)}${q}`;
  });
  css = css.replace(/@import\s+url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    return `@import url(${q}${proxify(u, base)}${q})`;
  });
  return css;
}

const AST_SIZE_LIMIT = 150 * 1024;

function rewriteJsAst(js, base) {
  if (js.length > AST_SIZE_LIMIT) return js;

  let ast;
  try {
    ast = parse(js, { next: true, module: false, tolerant: true });
  } catch {
    return js;
  }

  function rewriteNode(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "Literal" && typeof node.value === "string") {
      const v = node.value;
      if (
        (v.startsWith("http://") || v.startsWith("https://") || (v.startsWith("/") && v.length > 1 && !v.startsWith("//"))) &&
        !v.includes(PREFIX + "?url=")
      ) {
        try {
          const abs = new URL(v, base).href;
          node.value = `${PREFIX}?url=${encode(abs)}&origin=${encode(base)}`;
          node.raw = JSON.stringify(node.value);
        } catch {}
      }
      return;
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(rewriteNode);
      } else if (child && typeof child === "object" && child.type) {
        rewriteNode(child);
      }
    }
  }

  rewriteNode(ast);

  try {
    return generate(ast);
  } catch {
    return js;
  }
}

function rewriteJsRegex(js, base) {
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
      const normalized = u.startsWith("//") ? "https:" + u : u;
      const abs = new URL(normalized, base).href;
      return `.src = ${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  js = js.replace(/\bimportScripts\s*\(\s*(['"`])([^'"` ]+)\1/g, (m, q, u) => {
    try {
      const abs = new URL(u, base).href;
      return `importScripts(${q}${PREFIX}?url=${encode(abs)}&origin=${encode(base)}${q}`;
    } catch { return m; }
  });

  return js;
}

function rewriteJs(js, base) {
  let out = rewriteJsAst(js, base);
  out = rewriteJsRegex(out, base);
  return out;
}

function rewriteHtmlAttrs(html, base) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $("base").remove();

  const urlAttrs = ["src", "href", "action", "poster", "data", "formaction", "ping"];

  $("*").each((_, el) => {
    const $el = $(el);

    for (const attr of urlAttrs) {
      const val = $el.attr(attr);
      if (val) $el.attr(attr, proxify(val, base));
    }

    const srcset = $el.attr("srcset");
    if (srcset) {
      const rewritten = srcset.replace(/([^\s,]+)(\s*\d+[wx]?)/g, (m, url, size) => {
        return proxify(url, base) + size;
      });
      $el.attr("srcset", rewritten);
    }
  });

  $("link[rel='stylesheet']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) $(el).attr("href", proxify(href, base));
  });

  $("head").prepend(`<base href="${PROXY}${PREFIX}?url=${encode(base)}&origin=${encode(base)}">`);

$("link").each((_, el) => {
  const rel = ($(el).attr("rel") || "").toLowerCase();
  if (["preload", "prefetch", "modulepreload"].includes(rel)) {
    const href = $(el).attr("href");
    if (href) $(el).attr("href", proxify(href, base));
  }
});

$('meta[http-equiv="refresh"]').each((_, el) => {
  const content = $(el).attr("content");
  if (!content) return;

  const match = content.match(/url=(.*)$/i);
  if (match) {
    const newUrl = proxify(match[1], base);
    $(el).attr("content", content.replace(match[1], newUrl));
  }
});

  return $.html();
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
      const normalized = url.startsWith("//") ? "https:" + url : url;
      const abs = new URL(normalized, base).href;

      return "/lessons/math?url=" + encodeURIComponent(abs) +
             "&origin=" + encodeURIComponent(ORIGIN);
    } catch {
      return url;
    }
  }

const origFetch = window.fetch;
window.fetch = async function(input, init) {
  try {
    if (input instanceof Request) {
      input = new Request(proxify(input.url), {
        method: input.method,
        headers: input.headers,
        body: input.body,
        mode: input.mode,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer
      });
    } else if (typeof input === "string") {
      input = proxify(input);
    }
  } catch {}
  return origFetch.call(this, input, init);
};

  let _baseUrl;
  try { _baseUrl = new URL(BASE); } catch { _baseUrl = new URL("https://sealgodreal.github.io/nebulabrowser/assets/html/blank.html"); }

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

  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    try {
      if (typeof input === "string") {
        input = proxify(input);
      } else if (input instanceof Request) {
        input = new Request(proxify(input.url), {
          method: input.method,
          headers: input.headers,
          body: input.body,
          mode: input.mode,
          credentials: input.credentials,
          cache: input.cache,
          redirect: input.redirect,
          referrer: input.referrer
        });
      }
    } catch {}
    return origFetch.call(this, input, init);
  };

  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    try {
      const action = this.action || location.href;
      this.action = proxify(action);
    } catch {}
    return origSubmit.call(this);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    try { url = proxify(url); } catch {}
    return _open.call(this, method, url, async !== false, user, pass);
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
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: _WS.CONNECTING });
  Object.defineProperty(window.WebSocket, 'OPEN', { value: _WS.OPEN });
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: _WS.CLOSING });
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: _WS.CLOSED });

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

  const origImage = window.Image;
  window.Image = function(w, h) {
    const img = new origImage(w, h);
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
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
    return origOpen.call(window, url, target, features);
  };

  const origWrite = document.write.bind(document);
  document.write = function(html) {
    try {
      html = html.replace(/(src|href)=["']([^"']+)["']/gi, (m, attr, url) => {
        return attr + '="' + proxify(url) + '"';
      });
    } catch {}
    return origWrite(html);
  };

  try {
    const scriptProto = HTMLScriptElement.prototype;
    const srcDesc = Object.getOwnPropertyDescriptor(scriptProto, 'src') ||
                    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src') ||
                    Object.getOwnPropertyDescriptor(Element.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(scriptProto, 'src', {
        set(val) {
          let normalized = val;
          if (typeof val === 'string' && val.startsWith('//')) {
            normalized = 'https:' + val;
          }
          srcDesc.set.call(this, proxify(normalized));
        },
        get() { return srcDesc.get.call(this); },
        configurable: true
      });
    }
  } catch {}

  try {
    const imgProto = HTMLImageElement.prototype;
    const imgSrcDesc = Object.getOwnPropertyDescriptor(imgProto, 'src');
    if (imgSrcDesc) {
      Object.defineProperty(imgProto, 'src', {
        set(val) { imgSrcDesc.set.call(this, proxify(val)); },
        get() { return imgSrcDesc.get.call(this); },
        configurable: true
      });
    }
  } catch {}

  const elements = [
    'HTMLAnchorElement',
    'HTMLLinkElement',
    'HTMLVideoElement',
    'HTMLAudioElement',
    'HTMLSourceElement',
    'HTMLIFrameElement'
  ];
  elements.forEach(name => {
    try {
      const proto = window[name]?.prototype;
      if (!proto) return;
      for (const prop of ['href', 'src']) {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) continue;
        Object.defineProperty(proto, prop, {
          set(val) { desc.set.call(this, proxify(val)); },
          get() { return desc.get.call(this); },
          configurable: true
        });
      }
    } catch {}
  });

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      return origBeacon(proxify(url), data);
    };
  }

  if (window.EventSource) {
    const _ES = window.EventSource;
    window.EventSource = function(url, config) {
      return new _ES(proxify(url), config);
    };
  }

  if (window.Worker) {
    const _Worker = window.Worker;
    window.Worker = function(url, opts) {
      return new _Worker(proxify(url), opts);
    };
  }

try {
  const origImport = window.import;
  if (origImport) {
    window.import = function(url) {
      return origImport(proxify(url));
    };
  }
} catch {}

  const origCreate = document.createElement.bind(document);
  document.createElement = function(tag, opts) {
    const el = origCreate(tag, opts);
    const t = (tag || "").toLowerCase();
    if (t === "script" || t === "iframe" || t === "img") {
      try {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'src') || Object.getOwnPropertyDescriptor(proto, 'href');
        if (desc && desc.set) {
          const prop = Object.getOwnPropertyDescriptor(proto, 'src') ? 'src' : 'href';
          Object.defineProperty(el, prop, {
            set(v) { desc.set.call(this, proxify(v)); },
            get() { return desc.get.call(this); },
            configurable: true
          });
        }
      } catch {}
    }
    return el;
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    }).catch(() => {});
    navigator.serviceWorker.register = () => Promise.reject(new Error("blocked by proxy"));
  }

  try {
    Object.defineProperty(document, 'referrer', {
      get() { return BASE; },
      configurable: true
    });
  } catch {}

  try {
    const iframeProto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(iframeProto, 'src');
    if (desc && desc.set) {
      Object.defineProperty(iframeProto, 'src', {
        set(val) { desc.set.call(this, proxify(val)); },
        get() { return desc.get.call(this); },
        configurable: true
      });
    }
  } catch {}

  const _processed = new WeakSet();

  function fixEl(el) {
    if (!el || el.nodeType !== 1) return;
    if (_processed.has(el)) return;
    _processed.add(el);

    try {
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
        } else if (name === "srcset") {
          const rewritten = value.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, url, desc) => {
            return proxify(url) + (desc || "");
          });
          if (rewritten !== value) el.setAttribute(attr.name, rewritten);
        } else if (/^on/.test(name) && typeof value === "string") {
          const rewritten = value
            .replace(/(https?:\/\/[^\s"'<>]+)/g, proxify)
            .replace(/window\.location\.href\s*=\s*['"](.*?)['"]/g, (m, u) => {
              return "window.location.href = '" + proxify(u) + "'";
            })
            .replace(/location\.href\s*=\s*['"](.*?)['"]/g, (m, u) => {
              return "location.href = '" + proxify(u) + "'";
            });
          if (rewritten !== value) el.setAttribute(attr.name, rewritten);
        } else if (name.startsWith("data-") && typeof value === "string") {
          if (value.match(/^https?:\/\//) || value.match(/^\/[\w]/)) {
            el.setAttribute(attr.name, proxify(value));
          }
        }
      }

      if (el.hasAttribute("style")) {
        const css = el.getAttribute("style");
        const rewritten = css.replace(new RegExp("url\\(\\s*(['\"]?)([^'\")]+)\\1\\s*\\)", "gi"), (m, q, u) => {
          return "url(" + q + proxify(u) + q + ")";
        });
        if (rewritten !== css) el.setAttribute("style", rewritten);
      }

      const extraAttrs = ["data-href", "data-url", "data-src", "data-action"];
      for (const attr of extraAttrs) {
        const value = el.getAttribute(attr);
        if (value && !value.includes("/lessons/math?url=")) {
          el.setAttribute(attr, proxify(value));
        }
      }
    } catch {}
  }

  function startDomRewriting() {
    document.querySelectorAll("*").forEach(fixEl);

    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === "attributes" && m.target) {
          const el = m.target;
          if (!el || el.nodeType !== 1 || el.tagName === "SCRIPT") return;
          const attr = m.attributeName;
          const urlAttrs = ["href", "src", "action", "poster", "data", "formaction", "ping"];
          if (urlAttrs.includes(attr)) {
            const val = el.getAttribute(attr);
            if (val && !val.includes("/lessons/math?url=")) {
              el.setAttribute(attr, proxify(val));
            }
          }
        }
        if (m.addedNodes) {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
              fixEl(n);
              n.querySelectorAll && n.querySelectorAll("*").forEach(fixEl);
            }
          });
        }
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });

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
  }

  if (document.readyState === "complete") {
    startDomRewriting();
  } else {
    window.addEventListener("load", startDomRewriting, { once: true });
  }

})();
</script>`;
}

async function decompress(buffer, encoding) {
  if (!encoding) return buffer;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") return await gunzip(buffer);
    if (enc === "br") return await brotliDecompress(buffer);
    if (enc === "deflate") return await inflate(buffer);
  } catch {
  }
  return buffer;
}

app.all(PREFIX, async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("missing url");

  const origin = req.query.origin || target;

  try {
    const targetUrl = new URL(target);
    const hostname = targetUrl.hostname;
    const domainKey = hostname.split(".").slice(-2).join(".");

    let jar = cookieJarMap.get(domainKey);
    if (!jar) {
      jar = new CookieJar();
      cookieJarMap.set(domainKey, jar);
    }

    const cookies = await jar.getCookieString(target);

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

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hopByHop.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }

    headers["host"] = targetUrl.host;
    headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    headers["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    headers["accept-language"] = "en-US,en;q=0.9";
    headers["accept-encoding"] = "gzip, br, deflate";
    headers["connection"] = "keep-alive";
    headers["upgrade-insecure-requests"] = "1";
    headers["cache-control"] = "no-cache";
    headers["referer"] = targetUrl.origin + "/";
    headers["origin"] = targetUrl.origin;
    headers["sec-fetch-dest"] = req.headers["sec-fetch-dest"] || "document";
    headers["sec-fetch-mode"] = req.headers["sec-fetch-mode"] || "navigate";
    headers["sec-fetch-site"] = "same-origin";

    const incomingCookie = req.headers["cookie"] || "";
    headers["cookie"] = incomingCookie
      ? (cookies ? `${incomingCookie}; ${cookies}` : incomingCookie)
      : cookies;

    if (req.headers.range) headers["range"] = req.headers.range;

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const ct = req.headers["content-type"] || "";
      body = req.body;

      if (Buffer.isBuffer(body)) {
      } else if (typeof body === "object" && ct.includes("application/json")) {
        body = JSON.stringify(body);
      } else if (typeof body === "object" && ct.includes("application/x-www-form-urlencoded")) {
        body = new URLSearchParams(body).toString();
      } else if (typeof body !== "string" && body) {
        body = String(body);
      }

      if (body) {
        delete headers["content-length"];
      }
    }

    const cacheKey = req.method === "GET" ? target : null;
    if (cacheKey) {
      const hit = cacheGet(cacheKey);
      if (hit) {
        res.status(hit.status);
        for (const [k, v] of Object.entries(hit.headers)) {
          res.setHeader(k, v);
        }
        res.setHeader("X-Proxy-Cache", "HIT");
        return res.end(hit.body);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        agent: target.startsWith("https") ? httpsAgent : httpAgent,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const rawHeaders = response.headers.raw ? response.headers.raw() : {};
    const setCookieHeader = rawHeaders["set-cookie"] || [];
    const cookieList = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
for (const c of cookieList) {
  if (!c) continue;

  try {
    const cookie = require("tough-cookie").Cookie.parse(c);
    if (!cookie) continue;

    const hostname = new URL(target).hostname;

    if (cookie.domain && !hostname.endsWith(cookie.domain.replace(/^\./, ""))) {
      continue;
    }

    jar.setCookieSync(cookie, target);
  } catch {}
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
    const contentEncoding = response.headers.get("content-encoding") || "";
    res.status(response.status);

    const blockedHeaders = new Set([
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "x-content-type-options",
      "strict-transport-security",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
      "permissions-policy",
      "content-encoding"
    ]);

    const forwardedHeaders = {};
    response.headers.forEach((v, k) => {
      if (!blockedHeaders.has(k.toLowerCase())) {
        res.setHeader(k, v);
        forwardedHeaders[k] = v;
      }
    });

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (contentType.includes("text/html")) {
      const rawBuf = await response.buffer();
      const decompressed = await decompress(rawBuf, contentEncoding);
      let text = decompressed.toString("utf8");

      text = rewriteHtmlAttrs(text, target);
      text = rewriteInlineStyles(text, target);
      text = rewriteStyleBlocks(text, target);

      const script = clientScript(origin, target);
      text = /<\/head>/i.test(text)
        ? text.replace(/<\/head>/i, script + "</head>")
        : /<body/i.test(text)
          ? text.replace(/<body[^>]*>/i, (m) => m + script)
          : script + text;

      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.send(text);
    }

    if (contentType.includes("css") || target.match(/\.css(\?|$)/)) {
      const rawBuf = await response.buffer();
      const decompressed = await decompress(rawBuf, contentEncoding);
      const css = decompressed.toString("utf8");
      const rewritten = rewriteCss(css, target);
      const outBuf = Buffer.from(rewritten, "utf8");

      res.setHeader("content-type", "text/css; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=300");

      if (cacheKey && isCacheable(contentType, req.method)) {
        cacheSet(cacheKey, {
          status: response.status,
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" },
          body: outBuf
        });
      }
      return res.end(outBuf);
    }

    if (contentType.includes("javascript") || contentType.includes("ecmascript") || target.match(/\.(m?js)(\?|$)/)) {
      const rawBuf = await response.buffer();
      const decompressed = await decompress(rawBuf, contentEncoding);
      const js = decompressed.toString("utf8");
      const rewritten = rewriteJs(js, target);
      const outBuf = Buffer.from(rewritten, "utf8");

      res.setHeader("content-type", "application/javascript; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=300");

      if (cacheKey && isCacheable(contentType, req.method)) {
        cacheSet(cacheKey, {
          status: response.status,
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
          body: outBuf
        });
      }
      return res.end(outBuf);
    }

    if (response.body) {
      const isImage = contentType.startsWith("image/");
      const isFont = contentType.includes("font") || contentType.includes("woff");

      if ((isImage || isFont) && cacheKey) {
        const rawBuf = await response.buffer();
        if (rawBuf.length < 2 * 1024 * 1024) {
          const decompressed = contentEncoding ? await decompress(rawBuf, contentEncoding) : rawBuf;
          res.setHeader("cache-control", "public, max-age=300");
          cacheSet(cacheKey, {
            status: response.status,
            headers: { ...forwardedHeaders, "cache-control": "public, max-age=300" },
            body: decompressed
          });
          return res.end(decompressed);
        }
        res.setHeader("cache-control", "public, max-age=300");
        const stream = Readable.from(rawBuf);
        try { await pipeline(stream, res); } catch {}
        return;
      }

      try {
        await pipeline(response.body, res);
      } catch (pipeErr) {
        if (!res.headersSent) res.status(500).end();
      }
      return;
    }

    res.end();

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).send("proxy error: " + e.message);
    }
  }
});

app.use((req, res) => {
  if (req.path.startsWith(PREFIX)) return res.status(404).send("not found");

  let originBase = null;

  const referer = req.headers.referer || "";
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const params = new URLSearchParams(refUrl.search);
      const urlParam = params.get("url");
      const originParam = params.get("origin");
      originBase = urlParam || originParam || null;
    } catch {}
  }

  if (!originBase) {
    const originHeader = req.headers["origin"] || "";
    if (originHeader && !originHeader.includes(new URL(PROXY).host)) {
      originBase = originHeader;
    }
  }

  if (originBase) {
    try {
      const target = new URL(req.originalUrl, originBase).href;
      const originForProxy = new URL(originBase).origin;
      return res.redirect(307,
        `${PREFIX}?url=${encode(target)}&origin=${encode(originForProxy)}`
      );
    } catch {}
  }

  return res.status(400).send("something went wrong.");
});

const server = app.listen(3000, () => console.log("prxy runnin on port 3000 (used for testing)"));

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, PROXY);
    const target = url.searchParams.get("url");
    if (!target) return socket.destroy();

    const parsed = new URL(target);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";

    wsProxy.ws(req, socket, head, { target: parsed.href }, (err) => {
      if (err) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
});

wsProxy.on("error", (err, req, res) => {
  if (res && res.end) res.end();
});