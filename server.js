const express = require("express");
const { URL } = require("url");
const zlib = require("zlib");
const WebSocket = require("ws");
const app = express();
const PORT = process.env.PORT || 8080;
const PROXY_PREFIX = "/p/";
const URL_ATTRS_BY_TAG = {
  a: ["href"],
  area: ["href"],
  base: ["href"],
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  iframe: ["src"],
  frame: ["src"],
  form: ["action"],
  button: ["formaction"],
  input: ["src", "formaction"],
  object: ["data"],
  embed: ["src"],
  track: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};
const GENERIC_URL_ATTRS = ["data-src", "data-srcset", "data-href", "data-url"];
const MAX_REDIRECTS = 5;

function toProxyUrl(absoluteUrl) {
  return PROXY_PREFIX + encodeURI(absoluteUrl);
}

function rewriteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();

  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("blob:")
  ) {
    return rawUrl;
  }

  try {
    const absolute = new URL(trimmed, baseUrl).toString();
    return toProxyUrl(absolute);
  } catch (err) {
    return rawUrl;
  }
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(",")
    .map((part) => {
      const seg = part.trim();
      if (!seg) return seg;
      const spaceIdx = seg.search(/\s/);
      if (spaceIdx === -1) return rewriteUrl(seg, baseUrl);
      const url = seg.slice(0, spaceIdx);
      const descriptor = seg.slice(spaceIdx);
      return rewriteUrl(url, baseUrl) + descriptor;
    })
    .join(", ");
}

function rewriteCss(css, baseUrl) {
  let out = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, url) => `url(${quote}${rewriteUrl(url, baseUrl)}${quote})`
  );
  out = out.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote, url) => `@import ${quote}${rewriteUrl(url, baseUrl)}${quote}`
  );
  return out;
}

function rewriteHtml(html, baseUrl) {
  let out = html.replace(
    /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (fullTag, tagName, attrs) => {
      const lowerTag = tagName.toLowerCase();
      const urlAttrs = URL_ATTRS_BY_TAG[lowerTag];

      let newAttrs = attrs;

      const attrsToRewrite = (urlAttrs || []).concat(GENERIC_URL_ATTRS);
      for (const attrName of attrsToRewrite) {
        const re = new RegExp(
          `(${attrName.replace(":", "\\:")}\\s*=\\s*)(["'])(.*?)\\2`,
          "i"
        );
        newAttrs = newAttrs.replace(re, (m, prefix, quote, value) => {
          const rewritten = /srcset/i.test(attrName)
            ? rewriteSrcset(value, baseUrl)
            : rewriteUrl(value, baseUrl);
          return `${prefix}${quote}${rewritten}${quote}`;
        });
      }

      newAttrs = newAttrs.replace(
        /(style\s*=\s*)(["'])(.*?)\2/i,
        (m, prefix, quote, value) => {
          return `${prefix}${quote}${rewriteCss(value, baseUrl)}${quote}`;
        }
      );

      return `<${tagName}${newAttrs}>`;
    }
  );

  out = out.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (m, attrs, css) => `<style${attrs}>${rewriteCss(css, baseUrl)}</style>`
  );

  out = out.replace(
    /(<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=)([^"'>]+)/gi,
    (m, prefix, url) => prefix + rewriteUrl(url, baseUrl)
  );

  const shim = buildClientShim(baseUrl);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${shim}`);
  } else {
    out = shim + out;
  }

  return out;
}

function buildClientShim(baseUrl) {
  return `
<script>
(function () {
  var PROXY_PREFIX = ${JSON.stringify(PROXY_PREFIX)};
  var BASE_URL = ${JSON.stringify(baseUrl)};
  var ORIGIN = window.location.origin;

  function isSkippable(url) {
    return !url || /^(#|data:|mailto:|tel:|javascript:|blob:|about:)/i.test(url);
  }

  var AD_NAV_HOST_PATTERNS = [
    /(^|\.)safeframe\.googlesyndication\.com$/i,
    /(^|\.)googlesyndication\.com$/i,
    /(^|\.)doubleclick\.net$/i,
    /(^|\.)googleadservices\.com$/i,
    /(^|\.)adservice\.google\.com$/i
  ];

  function isAdNavHost(hostname) {
    return AD_NAV_HOST_PATTERNS.some(function (re) { return re.test(hostname); });
  }

  function isAdNavigation(url) {
    if (isSkippable(url)) return false;
    try {
      var parsed = new URL(url, BASE_URL);
      return isAdNavHost(parsed.hostname);
    } catch (e) {
      return false;
    }
  }

  var pendingNav = null;
  var pendingNavTimer = null;
  function queueNavigation(apply, url) {
    var ad = isAdNavigation(url);
    if (ad && pendingNav && !pendingNav.isAd) return;
    pendingNav = { apply: apply, url: url, isAd: ad };
    if (pendingNavTimer) clearTimeout(pendingNavTimer);
    pendingNavTimer = setTimeout(function () {
      var nav = pendingNav;
      pendingNav = null;
      pendingNavTimer = null;
      if (nav) {
        if (nav.isAd) {
          console.warn("[proxy] blocked ad-redirect navigation to", nav.url);
        } else {
          nav.apply(nav.url);
        }
      }
    }, 0);
  }

  function toProxyUrl(url) {
    if (url == null) return url;
    if (typeof url !== "string") {
      try { url = String(url); } catch (e) { return url; }
    }
    if (isSkippable(url)) return url;
    if (url.indexOf(PROXY_PREFIX) === 0) return url;
    try {
      var parsed = new URL(url, BASE_URL);
      if (
        parsed.hostname === window.location.hostname &&
        parsed.port !== window.location.port
      ) {
        parsed = new URL(parsed.pathname + parsed.search + parsed.hash, BASE_URL);
      }
      var abs = parsed.toString();
      if (abs.indexOf(ORIGIN + PROXY_PREFIX) === 0) return abs;
      return ORIGIN + PROXY_PREFIX + encodeURI(abs);
    } catch (e) {
      return url;
    }
  }

  function toProxySrcset(value) {
    if (value == null) return value;
    if (typeof value !== "string") {
      try { value = String(value); } catch (e) { return value; }
    }
    try {
      return value
        .split(",")
        .map(function (part) {
          var seg = part.trim();
          if (!seg) return seg;
          var spaceIdx = seg.search(/\\s/);
          if (spaceIdx === -1) return toProxyUrl(seg);
          return toProxyUrl(seg.slice(0, spaceIdx)) + seg.slice(spaceIdx);
        })
        .join(", ");
    } catch (e) {
      return value;
    }
  }

  var URL_ATTRS = {
    A: ["href"], AREA: ["href"], BASE: ["href"], LINK: ["href"],
    SCRIPT: ["src"], IMG: ["src", "srcset"], SOURCE: ["src", "srcset"],
    VIDEO: ["src", "poster"], AUDIO: ["src"], IFRAME: ["src"],
    FRAME: ["src"], FORM: ["action"], BUTTON: ["formaction"],
    INPUT: ["src", "formaction"], OBJECT: ["data"], EMBED: ["src"],
    TRACK: ["src"], IMAGE: ["href"], USE: ["href"]
  };

  function patchProp(proto, prop) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set || !desc.get || desc.__proxyPatched) return;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return desc.get.call(this);
        },
        set: function (value) {
          return desc.set.call(this, prop === "srcset" ? toProxySrcset(value) : toProxyUrl(value));
        },
        __proxyPatched: true
      });
    } catch (e) {
      console.warn("[proxy] could not patch property", prop, e);
    }
  }
  [
    [HTMLAnchorElement, ["href"]],
    [HTMLAreaElement, ["href"]],
    [HTMLBaseElement, ["href"]],
    [HTMLLinkElement, ["href"]],
    [HTMLScriptElement, ["src"]],
    [HTMLImageElement, ["src", "srcset"]],
    [window.HTMLSourceElement, ["src", "srcset"]],
    [HTMLMediaElement, ["src"]],
    [HTMLIFrameElement, ["src"]],
    [HTMLFormElement, ["action"]],
    [HTMLEmbedElement, ["src"]],
    [HTMLObjectElement, ["data"]]
  ].forEach(function (pair) {
    var ctor = pair[0], props = pair[1];
    if (!ctor || !ctor.prototype) return;
    props.forEach(function (p) { patchProp(ctor.prototype, p); });
  });

  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var tagAttrs = URL_ATTRS[this.tagName];
    var lname = String(name).toLowerCase();
    if (tagAttrs && tagAttrs.indexOf(lname) !== -1) {
      value = lname === "srcset" ? toProxySrcset(value) : toProxyUrl(value);
    } else if (lname === "xlink:href" || lname === "href") {
      value = toProxyUrl(value);
    }
    return origSetAttribute.call(this, name, value);
  };
  var origSetAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (/href$/i.test(name)) value = toProxyUrl(value);
    return origSetAttributeNS.call(this, ns, name, value);
  };

  function rewriteElementInPlace(el) {
    if (!el || el.nodeType !== 1) return;
    var attrs = URL_ATTRS[el.tagName];
    if (attrs) {
      attrs.forEach(function (attr) {
        if (el.hasAttribute(attr)) {
          var current = el.getAttribute(attr);
          var proxied = attr === "srcset" ? toProxySrcset(current) : toProxyUrl(current);
          if (proxied !== current) origSetAttribute.call(el, attr, proxied);
        }
      });
    }
    if (el.hasAttribute && el.hasAttribute("style") && /url\\(/i.test(el.getAttribute("style"))) {
      var currentStyle = el.getAttribute("style");
      var rewrittenStyle = currentStyle.replace(
        /url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/gi,
        function (m, q, u) { return "url(" + q + toProxyUrl(u) + q + ")"; }
      );
      if (rewrittenStyle !== currentStyle) {
        origSetAttribute.call(el, "style", rewrittenStyle);
      }
    }
  }
  function rewriteTree(root) {
    rewriteElementInPlace(root);
    if (root.querySelectorAll) {
      root.querySelectorAll(Object.keys(URL_ATTRS).join(",") + ",[style]").forEach(rewriteElementInPlace);
    }
  }
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes && m.addedNodes.forEach(function (n) { rewriteTree(n); });
      if (m.type === "attributes" && m.target) rewriteElementInPlace(m.target);
    });
  });
  function startObserving() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["href", "src", "srcset", "action", "poster", "data", "style", "formaction"]
    });
  }
  if (document.documentElement) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving);

  function toWsProxyUrl(url) {
    if (isSkippable(url)) return url;
    try {
      var wsBase = BASE_URL.replace(/^http/i, function (m) {
        return m.toLowerCase() === "https" ? "wss" : "ws";
      });
      var parsed = new URL(url, wsBase);
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      else if (parsed.protocol === "https:") parsed.protocol = "wss:";
      var abs = parsed.toString();
      var ourScheme = window.location.protocol === "https:" ? "wss://" : "ws://";
      return ourScheme + window.location.host + PROXY_PREFIX + encodeURI(abs);
    } catch (e) {
      return url;
    }
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      if (typeof input === "string") input = toProxyUrl(input);
      else if (input && input.url) input = new Request(toProxyUrl(input.url), input);
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toProxyUrl(url);
    return origOpen.apply(this, args);
  };
  if (window.WebSocket) {
    var OrigWebSocket = window.WebSocket;
    var PatchedWebSocket = function (url, protocols) {
      var proxied = toWsProxyUrl(url);
      return protocols === undefined
        ? new OrigWebSocket(proxied)
        : new OrigWebSocket(proxied, protocols);
    };
    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    try {
      Object.defineProperty(window, "WebSocket", {
        configurable: false,
        writable: false,
        value: PatchedWebSocket
      });
    } catch (e) {
      window.WebSocket = PatchedWebSocket;
    }
  }
  if (window.Worker) {
    var OrigWorker = window.Worker;
    window.Worker = function (url, opts) { return new OrigWorker(toProxyUrl(url), opts); };
    window.Worker.prototype = OrigWorker.prototype;
  }

  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function (state, title, url) {
      if (url) url = toProxyUrl(url);
      return orig.call(this, state, title, url);
    };
  });
  var origOpenWindow = window.open;
  try {
    Object.defineProperty(window, "open", {
      configurable: false,
      writable: false,
      value: function (url, target, features) {
        if (isAdNavigation(url)) {
          console.warn("[proxy] blocked ad-redirect popup to", url);
          return null;
        }
        return origOpenWindow.call(this, toProxyUrl(url), target, features);
      }
    });
  } catch (e) {
    window.open = function (url, target, features) {
      if (isAdNavigation(url)) {
        console.warn("[proxy] blocked ad-redirect popup to", url);
        return null;
      }
      return origOpenWindow.call(this, toProxyUrl(url), target, features);
    };
  }

  try {
    var locProto = Object.getPrototypeOf(window.location);
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");
    if (hrefDesc && hrefDesc.configurable && hrefDesc.set && hrefDesc.get) {
      Object.defineProperty(locProto, "href", {
        configurable: false,
        enumerable: hrefDesc.enumerable,
        get: function () { return hrefDesc.get.call(this); },
        set: function (url) {
          var self = this;
          queueNavigation(function (u) { hrefDesc.set.call(self, toProxyUrl(u)); }, url);
        }
      });
    }
  } catch (e) { }

  ["assign", "replace"].forEach(function (fn) {
    try {
      var locProto2 = Object.getPrototypeOf(window.location);
      var origFn = locProto2[fn];
      if (typeof origFn === "function" && !origFn.__proxyPatched) {
        var patched = function (url) {
          var self = this;
          queueNavigation(function (u) { origFn.call(self, toProxyUrl(u)); }, url);
        };
        patched.__proxyPatched = true;
        Object.defineProperty(locProto2, fn, {
          value: patched,
          writable: false,
          configurable: false,
          enumerable: false
        });
      }
    } catch (e) { }
  });
})();
</script>`;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch (e) {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

const UPSTREAM_TIMEOUT_MS = 20000;

async function fetchFollowingRedirects(targetUrl, headers, redirectsLeft, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(targetUrl, {
      headers,
      method,
      body,
      redirect: "manual",
      signal: controller.signal,
      ...(body ? { duplex: "half" } : {}),
    });
  } finally {
    clearTimeout(timer);
  }

  if (
    [301, 302, 303, 307, 308].includes(res.status) &&
    redirectsLeft > 0 &&
    res.headers.get("location")
  ) {
    const nextUrl = new URL(res.headers.get("location"), targetUrl).toString();
    const preserveBody = res.status === 307 || res.status === 308;
    return fetchFollowingRedirects(
      nextUrl,
      headers,
      redirectsLeft - 1,
      preserveBody ? method : "GET",
      preserveBody ? body : undefined
    );
  }

  return { res, finalUrl: targetUrl };
}

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

const PROXY_ROUTE = new RegExp(
  "^" + PROXY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.*)$"
);

app.all(
  PROXY_ROUTE,
  express.raw({ type: "*/*", limit: "100mb" }),
  async (req, res) => {
    const target = req.params[0] + (req.url.split("?")[1] ? "?" + req.url.split("?")[1] : "");

    if (!target) {
      return res.status(400).send("Usage: /p/<full target URL>");
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (err) {
      return res.status(400).send("Invalid target URL: " + target);
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return res.status(400).send("Only http/https targets are supported.");
    }

    try {
      const forwardHeaders = {
        "User-Agent":
          req.headers["user-agent"] ||
          "Mozilla/5.0 (compatible; Nebula/1.0)",
        Accept: req.headers["accept"] || "*/*",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      };
      if (req.headers["content-type"]) {
        forwardHeaders["Content-Type"] = req.headers["content-type"];
      }

      const hasBody =
        !["GET", "HEAD"].includes(req.method) &&
        Buffer.isBuffer(req.body) &&
        req.body.length > 0;

      const { res: upstream, finalUrl } = await fetchFollowingRedirects(
        targetUrl.toString(),
        forwardHeaders,
        MAX_REDIRECTS,
        req.method,
        hasBody ? req.body : undefined
      );

      const contentType = upstream.headers.get("content-type") || "";

      const isTopLevelNavigation =
        req.headers["sec-fetch-dest"] === "document" ||
        (!req.headers["sec-fetch-dest"] && !req.headers["x-requested-with"]);
      if (isTopLevelNavigation) {
        res.cookie("proxy_last_origin", new URL(finalUrl).origin, {
          httpOnly: false,
          sameSite: "Lax",
          path: "/",
        });
      }

      const skipHeaders = new Set([
        "content-encoding",
        "content-length",
        "content-security-policy",
        "content-security-policy-report-only",
        "x-frame-options",
        "strict-transport-security",
        "cache-control",
        "etag",
        "last-modified",
        "expires",
        "age",
        "pragma",
        "alt-svc"
      ]);
      upstream.headers.forEach((value, key) => {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");

      if (contentType.includes("text/html")) {
        const html = await upstream.text();
        const rewritten = rewriteHtml(html, finalUrl);
        res.status(upstream.status).send(rewritten);
      } else if (contentType.includes("text/css")) {
        const css = await upstream.text();
        const rewritten = rewriteCss(css, finalUrl);
        res.status(upstream.status).send(rewritten);
      } else {
        res.status(upstream.status);
        if (upstream.body) {
          const { Readable } = require("stream");
          Readable.fromWeb(upstream.body).pipe(res);
        } else {
          res.end();
        }
      }
    } catch (err) {
      console.error("Proxy error for", target, err);
      if (err.name === "AbortError") {
        res.status(504).send(
          `Proxy fetch timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s fetching: ` + target
        );
      } else {
        res.status(502).send("Proxy fetch failed: " + err.message);
      }
    }
  }
);

app.use((req, res) => {
  let lastOrigin = null;
  const referer = req.headers["referer"];
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
        const embedded = refUrl.pathname.slice(PROXY_PREFIX.length) + refUrl.search;
        lastOrigin = new URL(decodeURIComponent(embedded)).origin;
      }
    } catch (err) {
    }
  }
  if (!lastOrigin) lastOrigin = getCookie(req, "proxy_last_origin");

  if (lastOrigin) {
    const reconstructed = lastOrigin + req.originalUrl;
    return res.redirect(307, PROXY_PREFIX + encodeURI(reconstructed));
  }
  res.status(404).send(`Not found. Try ${PROXY_PREFIX}<full target URL>`);
});

const server = app.listen(PORT, () => {
  console.log(`prxy running on http://localhost:${PORT}`);
});

const wsProxyServer = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const match = req.url.match(PROXY_ROUTE);
  const target = match && match[1];

  if (!target) {
    socket.destroy();
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (err) {
    socket.destroy();
    return;
  }

  if (!["ws:", "wss:"].includes(targetUrl.protocol)) {
    socket.destroy();
    return;
  }

  wsProxyServer.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamWs = new WebSocket(targetUrl.toString(), {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (compatible; Nebula/1.0)",
        Origin: targetUrl.origin,
      },
    });

    const cleanup = () => {
      try { clientWs.close(); } catch (e) { }
      try { upstreamWs.close(); } catch (e) { }
    };

    let upstreamOpen = false;
    const pending = [];
    clientWs.on("message", (data, isBinary) => {
      if (upstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });

    upstreamWs.on("open", () => {
      upstreamOpen = true;
      for (const { data, isBinary } of pending) upstreamWs.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstreamWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });

    upstreamWs.on("error", (err) => {
      console.error("WS upstream error for", targetUrl.toString(), err.message);
      cleanup();
    });
    clientWs.on("error", cleanup);
    upstreamWs.on("close", cleanup);
    clientWs.on("close", cleanup);
  });
});
