const express = require("express");
const { URL } = require("url");
const zlib = require("zlib");
const WebSocket = require("ws");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Expose-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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
  body: ["background"],
  table: ["background"],
  td: ["background"],
  th: ["background"],
  tr: ["background"],
  div: ["background"],
  span: ["background"],
};

const GENERIC_URL_ATTRS = ["data-src", "data-srcset", "data-href", "data-url", "data-icon", "data-bg", "data-background", "data-poster", "data-video", "data-audio"];
const MAX_REDIRECTS = 10;
const UPSTREAM_TIMEOUT_MS = 30000;

const cookieJar = new Map();

function toProxyUrl(absoluteUrl) {
  if (!absoluteUrl) return absoluteUrl;
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
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("chrome-extension:") ||
    trimmed.startsWith("moz-extension:") ||
    trimmed.startsWith(PROXY_PREFIX)
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
  if (!value) return value;
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
  if (!css) return css;
  let out = css;
  out = out.replace(
    /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,
    (match, quote, url) => `url(${quote}${rewriteUrl(url, baseUrl)}${quote})`
  );
  out = out.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote, url) => `@import ${quote}${rewriteUrl(url, baseUrl)}${quote}`
  );
  out = out.replace(
    /src:\s*([^;]+)/gi,
    (match, src) => {
      return 'src: ' + src.replace(
        /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,
        (m, q, u) => `url(${q}${rewriteUrl(u, baseUrl)}${q})`
      );
    }
  );
  out = out.replace(
    /(--[^:]+):\s*url\(\s*(['"]?)([^'"\)]+)\2\s*\)/gi,
    (match, prop, quote, url) => `${prop}: url(${quote}${rewriteUrl(url, baseUrl)}${quote})`
  );
  return out;
}

function rewriteHtml(html, baseUrl) {
  let out = html;

  out = out.replace(
    /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (fullTag, tagName, attrs) => {
      const lowerTag = tagName.toLowerCase();
      const urlAttrs = URL_ATTRS_BY_TAG[lowerTag];
      let newAttrs = attrs;
      const attrsToRewrite = (urlAttrs || []).concat(GENERIC_URL_ATTRS);

      for (const attrName of attrsToRewrite) {
        const escaped = attrName.replace(":", "\\:");
        const re = new RegExp(
          "(" + escaped + "\\s*=\\s*)([\"'])(.*?)\\2",
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

  out = out.replace(
    /(<link[^>]*rel=["']stylesheet["'][^>]*)\s+integrity=["'][^"']*["']/gi,
    "$1"
  );
  out = out.replace(
    /(<link[^>]*rel=["']stylesheet["'][^>]*)\s+crossorigin=["'][^"']*["']/gi,
    "$1"
  );

  out = out.replace(
    /(<base\b[^>]*href\s*=\s*)(["'])([^"']*)\2/i,
    (m, prefix, quote, url) => `${prefix}${quote}${rewriteUrl(url, baseUrl)}${quote}`
  );

  const shim = buildClientShim(baseUrl);
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, shim + "</body>");
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${shim}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (m, attrs) => `<html${attrs}><head>${shim}</head>`);
  } else {
    out = out + shim;
  }

  return out;
}

function buildClientShim(baseUrl) {
  return String.raw`<script>
(function () {
  var PROXY_PREFIX = ` + JSON.stringify(PROXY_PREFIX) + String.raw`;
  var BASE_URL = ` + JSON.stringify(baseUrl) + String.raw`;
  var ORIGIN = window.location.origin;
  var PROXY_ORIGIN = ORIGIN;
  var PROXY_HOSTNAME = window.location.hostname;

  function isSkippable(url) {
    if (!url) return true;
    var s = String(url);
    if (/^(#|data:|mailto:|tel:|javascript:|blob:|about:|chrome-extension:|moz-extension:)/i.test(s)) return true;
    if (s.indexOf(PROXY_PREFIX) === 0) return true;
    if (s.indexOf(PROXY_ORIGIN + PROXY_PREFIX) === 0) return true;
    return false;
  }

  var AD_NAV_HOST_PATTERNS = [
    /(^|\.)safeframe\.googlesyndication\.com$/i,
    /(^|\.)googlesyndication\.com$/i,
    /(^|\.)doubleclick\.net$/i,
    /(^|\.)googleadservices\.com$/i,
    /(^|\.)adservice\.google\.com$/i,
    /(^|\.)google-analytics\.com$/i,
    /(^|\.)googletagmanager\.com$/i
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
    if (!ad && isSameBaseDomain(url)) {
      apply(url);
      return;
    }
    if (ad && pendingNav && !pendingNav.isAd) return;
    pendingNav = { apply: apply, url: url, isAd: ad };
    if (pendingNavTimer) clearTimeout(pendingNavTimer);
    pendingNavTimer = setTimeout(function () {
      var nav = pendingNav;
      pendingNav = null;
      pendingNavTimer = null;
      if (nav) {
        if (nav.isAd) {
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
    url = url.trim();
    if (isSkippable(url)) return url;
    if (url.indexOf(PROXY_PREFIX) === 0) return url;
    if (url.indexOf(PROXY_ORIGIN + PROXY_PREFIX) === 0) return url;
    try {
      var parsed = new URL(url, BASE_URL);
      if (
        parsed.hostname === window.location.hostname &&
        parsed.port !== window.location.port
      ) {
        parsed = new URL(parsed.pathname + parsed.search + parsed.hash, BASE_URL);
      }
      var abs = parsed.toString();
      if (abs.indexOf(PROXY_ORIGIN + PROXY_PREFIX) === 0) return abs;
      return PROXY_ORIGIN + PROXY_PREFIX + encodeURI(abs);
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
          var spaceIdx = seg.search(/\s/);
          if (spaceIdx === -1) return toProxyUrl(seg);
          return toProxyUrl(seg.slice(0, spaceIdx)) + seg.slice(spaceIdx);
        })
        .join(", ");
    } catch (e) {
      return value;
    }
  }

  function rewriteCss(css) {
    if (!css || typeof css !== "string") return css;
    css = css.replace(
      /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,
      function(m, q, u) { return "url(" + q + toProxyUrl(u) + q + ")"; }
    );
    css = css.replace(
      /@import\s+(['"])([^'"]+)\1/gi,
      function(m, q, u) { return "@import " + q + toProxyUrl(u) + q; }
    );
    return css;
  }

  try {
    if (window.RTCPeerConnection) {
      var OrigRTCPeerConnection = window.RTCPeerConnection;
      var PatchedRTCPeerConnection = function(config) {
        if (config && config.iceServers) {
          config.iceServers = config.iceServers.filter(function(server) {
            var url = server.urls || server.url;
            if (typeof url === "string") {
              return !/stun:/i.test(url);
            }
            if (Array.isArray(url)) {
              return !url.some(function(u) { return /stun:/i.test(u); });
            }
            return true;
          });
        }
        var pc = new OrigRTCPeerConnection(config);
        var origAddIceCandidate = pc.addIceCandidate;
        pc.addIceCandidate = function(candidate) {
          if (candidate && candidate.candidate) {
            var c = candidate.candidate;
            if (/typ\s+host/i.test(c) || /typ\s+srflx/i.test(c)) {
              return Promise.resolve();
            }
          }
          return origAddIceCandidate.call(this, candidate);
        };
        return pc;
      };
      PatchedRTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
      window.RTCPeerConnection = PatchedRTCPeerConnection;
    }
  } catch (e) {}

  try {
    Object.defineProperty(document, "domain", {
      get: function() { return new URL(BASE_URL).hostname; },
      set: function() {},
      configurable: false
    });
  } catch (e) {}

  var URL_ATTRS = {
    A: ["href"], AREA: ["href"], BASE: ["href"], LINK: ["href"],
    SCRIPT: ["src"], IMG: ["src", "srcset"], SOURCE: ["src", "srcset"],
    VIDEO: ["src", "poster"], AUDIO: ["src"], IFRAME: ["src"],
    FRAME: ["src"], FORM: ["action"], BUTTON: ["formaction"],
    INPUT: ["src", "formaction"], OBJECT: ["data"], EMBED: ["src"],
    TRACK: ["src"], IMAGE: ["href"], USE: ["href"],
    BODY: ["background"], TABLE: ["background"], TD: ["background"],
    TH: ["background"], TR: ["background"], DIV: ["background"], SPAN: ["background"]
  };

  function patchProp(proto, prop) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set || !desc.get || desc.__proxyPatched) return;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () { return desc.get.call(this); },
        set: function (value) {
          return desc.set.call(this, prop === "srcset" ? toProxySrcset(value) : toProxyUrl(value));
        },
        __proxyPatched: true
      });
    } catch {
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
    [HTMLObjectElement, ["data"]],
    [HTMLBodyElement, ["background"]],
    [HTMLTableElement, ["background"]],
    [HTMLTableCellElement, ["background"]],
    [HTMLTableRowElement, ["background"]]
  ].forEach(function (pair) {
    var ctor = pair[0], props = pair[1];
    if (!ctor || !ctor.prototype) return;
    props.forEach(function (p) { patchProp(ctor.prototype, p); });
  });

  try {
    var cssProto = CSSStyleDeclaration.prototype;
    var cssProps = ["backgroundImage", "background", "listStyleImage", "cursor", "filter", "maskImage", "mask"];
    cssProps.forEach(function(prop) {
      var desc = Object.getOwnPropertyDescriptor(cssProto, prop);
      if (desc && desc.set && desc.get && !desc.__proxyPatched) {
        Object.defineProperty(cssProto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: function() { return desc.get.call(this); },
          set: function(value) {
            if (typeof value === "string" && /url\(/i.test(value)) {
              value = value.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, function(m, q, u) {
                return "url(" + q + toProxyUrl(u) + q + ")";
              });
            }
            return desc.set.call(this, value);
          },
          __proxyPatched: true
        });
      }
    });
  } catch (e) {}

  try {
    var origInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function(rule, index) {
      if (typeof rule === "string") rule = rewriteCss(rule);
      return origInsertRule.call(this, rule, index);
    };
  } catch (e) {}

  try {
    var styleProto = HTMLStyleElement.prototype;
    var textDesc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (textDesc && textDesc.set) {
      Object.defineProperty(styleProto, "textContent", {
        configurable: true,
        enumerable: textDesc.enumerable,
        get: function() { return textDesc.get.call(this); },
        set: function(value) {
          if (typeof value === "string") value = rewriteCss(value);
          return textDesc.set.call(this, value);
        }
      });
    }
  } catch (e) {}

  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var tagAttrs = URL_ATTRS[this.tagName];
    var lname = String(name).toLowerCase();
    if (tagAttrs && tagAttrs.indexOf(lname) !== -1) {
      value = lname === "srcset" ? toProxySrcset(value) : toProxyUrl(value);
    } else if (lname === "xlink:href" || lname === "href") {
      value = toProxyUrl(value);
    } else if (lname === "style") {
      if (typeof value === "string" && /url\(/i.test(value)) {
        value = value.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, function(m, q, u) {
          return "url(" + q + toProxyUrl(u) + q + ")";
        });
      }
    }
    return origSetAttribute.call(this, name, value);
  };

  var origSetAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (/href$/i.test(name)) value = toProxyUrl(value);
    return origSetAttributeNS.call(this, ns, name, value);
  };

  var origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function(tagName, options) {
    var el = origCreateElement.call(this, tagName, options);
    if (el.tagName === "LINK") {
      var origHrefDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");
      if (origHrefDesc && origHrefDesc.set) {
        Object.defineProperty(el, "href", {
          configurable: true,
          enumerable: true,
          get: function() { return origHrefDesc.get.call(this); },
          set: function(v) { return origHrefDesc.set.call(this, toProxyUrl(v)); }
        });
      }
    }
    if (el.tagName === "STYLE") {
      var origSet = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;
      Object.defineProperty(el, "textContent", {
        configurable: true,
        enumerable: true,
        get: function() { return Object.getOwnPropertyDescriptor(Node.prototype, "textContent").get.call(this); },
        set: function(v) {
          if (typeof v === "string") v = rewriteCss(v);
          return origSet.call(this, v);
        }
      });
    }
    return el;
  };

  var origCreateElementNS = Document.prototype.createElementNS;
  Document.prototype.createElementNS = function(ns, tagName) {
    var el = origCreateElementNS.call(this, ns, tagName);
    if (el.tagName === "image" || el.tagName === "use") {
      var origHrefDesc = Object.getOwnPropertyDescriptor(SVGElement.prototype, "href");
      if (origHrefDesc && origHrefDesc.set) {
        Object.defineProperty(el, "href", {
          configurable: true,
          enumerable: true,
          get: function() { return origHrefDesc.get.call(this); },
          set: function(v) { return origHrefDesc.set.call(this, toProxyUrl(v)); }
        });
      }
    }
    return el;
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
    if (el.hasAttribute && el.hasAttribute("style")) {
      var currentStyle = el.getAttribute("style");
      if (/url\(/i.test(currentStyle)) {
        var rewrittenStyle = currentStyle.replace(
          /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,
          function (m, q, u) { return "url(" + q + toProxyUrl(u) + q + ")"; }
        );
        if (rewrittenStyle !== currentStyle) {
          origSetAttribute.call(el, "style", rewrittenStyle);
        }
      }
    }
    if (el.tagName === "STYLE" && el.textContent) {
      var rewritten = rewriteCss(el.textContent);
      if (rewritten !== el.textContent) {
        el.textContent = rewritten;
      }
    }
  }

  function rewriteTree(root) {
    rewriteElementInPlace(root);
    if (root.querySelectorAll) {
      var selectors = Object.keys(URL_ATTRS).join(",") + ",style,[style]";
      root.querySelectorAll(selectors).forEach(rewriteElementInPlace);
    }
    if (root.shadowRoot) {
      rewriteTree(root.shadowRoot);
    }
  }

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes && m.addedNodes.forEach(function (n) {
        rewriteTree(n);
        if (n.nodeType === 1 && n.shadowRoot) {
          rewriteTree(n.shadowRoot);
        }
      });
      if (m.type === "attributes" && m.target) rewriteElementInPlace(m.target);
    });
  });

  function startObserving(root) {
    root = root || document.documentElement;
    if (!root) return;
    observer.observe(root, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["href", "src", "srcset", "action", "poster", "data", "style", "formaction", "background"]
    });
  }

  if (document.documentElement) startObserving();
  else document.addEventListener("DOMContentLoaded", function() { startObserving(); });

  var origAttachShadow = Element.prototype.attachShadow;
  if (origAttachShadow) {
    Element.prototype.attachShadow = function(init) {
      var shadow = origAttachShadow.call(this, init);
      startObserving(shadow);
      return shadow;
    };
  }

  if (navigator.serviceWorker) {
    var origRegister = navigator.serviceWorker.register;
    navigator.serviceWorker.register = function(url, options) {
      return Promise.reject(new Error("Service workers are disabled in proxy mode"))
    };
    navigator.serviceWorker.ready = Promise.reject(new Error("Service workers are disabled"));
  }

  if (window.caches) {
    var origOpen = window.caches.open;
    window.caches.open = function() {
      return Promise.reject(new Error("Cache API is disabled in proxy mode"));
    };
  }

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
      if (typeof input === "string") {
        input = toProxyUrl(input);
      } else if (input && input.url) {
        input = new Request(toProxyUrl(input.url), input);
      }
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

  if (window.SharedWorker) {
    var OrigSharedWorker = window.SharedWorker;
    window.SharedWorker = function (url, name) { return new OrigSharedWorker(toProxyUrl(url), name); };
  }

  if (window.importScripts) {
    var origImportScripts = window.importScripts;
    window.importScripts = function() {
      var args = Array.prototype.slice.call(arguments);
      for (var i = 0; i < args.length; i++) {
        args[i] = toProxyUrl(args[i]);
      }
      return origImportScripts.apply(this, args);
    };
  }

  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function (state, title, url) {
      if (typeof url === "string") {
        url = fixNowGgUrl(url);
        url = toProxyUrl(url);
      }
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
          return null;
        }
        return origOpenWindow.call(this, toProxyUrl(url), target, features);
      }
    });
  } catch (e) {
    window.open = function (url, target, features) {
      if (isAdNavigation(url)) {
        return null;
      }
      return origOpenWindow.call(this, toProxyUrl(url), target, features);
    };
  }

  function isSameBaseDomain(url) {
    try {
      var parsed = new URL(url, BASE_URL);
      var baseHost = new URL(BASE_URL).hostname;
      var urlHost = parsed.hostname;
      return urlHost === baseHost || urlHost.endsWith("." + baseHost) || baseHost.endsWith("." + urlHost);
    } catch (e) {
      return false;
    }
  }

  function fixNowGgUrl(url) {
    if (typeof url !== "string") return url;
    try {
      var urlObj = new URL(url);
      var proxyHostname = window.location.hostname;
      if (urlObj.pathname.indexOf(PROXY_PREFIX) === 0) {
        var embedded = decodeURIComponent(urlObj.pathname.slice(PROXY_PREFIX.length) + urlObj.search + urlObj.hash);
        var embeddedUrl = new URL(embedded, BASE_URL);
        var hostParts = urlObj.hostname.split(".");
        var proxyParts = proxyHostname.split(".");
        if (hostParts.length > proxyParts.length) {
          var suffix = hostParts.slice(-proxyParts.length).join(".");
          if (suffix === proxyHostname) {
            var subdomain = hostParts.slice(0, hostParts.length - proxyParts.length).join(".");
            var newTarget = embeddedUrl.protocol + "//" + subdomain + "." + embeddedUrl.hostname + embeddedUrl.pathname + embeddedUrl.search + embeddedUrl.hash;
            return PROXY_ORIGIN + PROXY_PREFIX + encodeURI(newTarget);
          }
        }
      }
    } catch (e) {}
    return url;
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
          if (typeof url === "string") {
            url = fixNowGgUrl(url);
          }
          if (isSameBaseDomain(url)) {
            hrefDesc.set.call(self, toProxyUrl(url));
          } else {
            queueNavigation(function (u) { hrefDesc.set.call(self, toProxyUrl(u)); }, url);
          }
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
          if (typeof url === "string") {
            url = fixNowGgUrl(url);
          }
          if (isSameBaseDomain(url)) {
            origFn.call(self, toProxyUrl(url));
          } else {
            queueNavigation(function (u) { origFn.call(self, toProxyUrl(u)); }, url);
          }
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

  try {
    Object.defineProperty(document, "baseURI", {
      get: function() { return BASE_URL; },
      configurable: false
    });
  } catch (e) {}

  try {
    var baseUrlObj = new URL(BASE_URL);
    var targetHost = baseUrlObj.host;
    var targetHostname = baseUrlObj.hostname;
    var targetOrigin = baseUrlObj.origin;
    var targetProtocol = baseUrlObj.protocol;

    var locProto3 = Object.getPrototypeOf(window.location);

    var hostnameDesc = Object.getOwnPropertyDescriptor(locProto3, "hostname");
    if (hostnameDesc && hostnameDesc.configurable) {
      Object.defineProperty(locProto3, "hostname", {
        get: function() { return targetHostname; },
        configurable: false
      });
    }

    var hostDesc = Object.getOwnPropertyDescriptor(locProto3, "host");
    if (hostDesc && hostDesc.configurable) {
      Object.defineProperty(locProto3, "host", {
        get: function() { return targetHost; },
        configurable: false
      });
    }

    var originDesc = Object.getOwnPropertyDescriptor(locProto3, "origin");
    if (originDesc && originDesc.configurable) {
      Object.defineProperty(locProto3, "origin", {
        get: function() { return targetOrigin; },
        configurable: false
      });
    }

    var protocolDesc = Object.getOwnPropertyDescriptor(locProto3, "protocol");
    if (protocolDesc && protocolDesc.configurable) {
      Object.defineProperty(locProto3, "protocol", {
        get: function() { return targetProtocol; },
        set: function() {},
        configurable: false
      });
    }
  } catch {
  }

  document.addEventListener("submit", function(e) {
    var form = e.target;
    if (form && form.tagName === "FORM") {
      var action = form.getAttribute("action");
      if (action && !isSameBaseDomain(action)) {
        form.setAttribute("action", toProxyUrl(action));
      }
    }
  }, true);

  document.addEventListener("click", function(e) {
    var el = e.target;
    while (el && el.tagName !== "A") el = el.parentElement;
    if (el && el.tagName === "A") {
      var href = el.getAttribute("href");
      if (href && !isSkippable(href) && !isSameBaseDomain(href)) {
        el.setAttribute("href", toProxyUrl(href));
      }
    }
  }, true);

  var CURRENT_URL = BASE_URL;
  var lastReportedUrl = BASE_URL;
  var urlPollInterval = null;

  function decodeProxiedUrl(url) {
    if (!url || typeof url !== "string") return url;
    try {
      var clean = url;
      if (clean.indexOf(PROXY_ORIGIN + PROXY_PREFIX) === 0) {
        clean = decodeURIComponent(clean.slice((PROXY_ORIGIN + PROXY_PREFIX).length));
      } else if (clean.indexOf(PROXY_PREFIX) === 0) {
        clean = decodeURIComponent(clean.slice(PROXY_PREFIX.length));
      }
      return clean;
    } catch (e) {
      return url;
    }
  }

  function reportUrlToParent(force) {
    try {
      if (window.parent !== window) {
        var urlToReport = decodeProxiedUrl(CURRENT_URL);
        if (force || urlToReport !== lastReportedUrl) {
          lastReportedUrl = urlToReport;
          window.parent.postMessage({ type: "nebula-url-update", url: urlToReport }, "*");
        }
      }
    } catch (e) {}
  }

  function updateCurrentUrl(url) {
    if (typeof url === "string") {
      try {
        var parsed = new URL(url, CURRENT_URL);
        CURRENT_URL = parsed.toString();
        reportUrlToParent(true);
      } catch (e) {}
    }
  }

  function syncCurrentUrlFromLocation() {
    try {
      var raw = window.location.href;
      var clean = decodeProxiedUrl(raw);
      if (clean !== CURRENT_URL) {
        CURRENT_URL = clean;
        reportUrlToParent(true);
      }
    } catch (e) {}
  }

  function startUrlPolling() {
    if (urlPollInterval) return;
    urlPollInterval = setInterval(syncCurrentUrlFromLocation, 400);
  }

  function stopUrlPolling() {
    if (urlPollInterval) {
      clearInterval(urlPollInterval);
      urlPollInterval = null;
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    reportUrlToParent(true);
    startUrlPolling();
  } else {
    document.addEventListener("DOMContentLoaded", function() {
      reportUrlToParent(true);
      startUrlPolling();
    });
  }

  window.addEventListener("hashchange", function() {
    syncCurrentUrlFromLocation();
  });

  window.addEventListener("popstate", function() {
    syncCurrentUrlFromLocation();
  });

  var origPushState2 = history.pushState;
  history.pushState = function(state, title, url) {
    var result = origPushState2.apply(this, arguments);
    setTimeout(syncCurrentUrlFromLocation, 0);
    return result;
  };

  var origReplaceState2 = history.replaceState;
  history.replaceState = function(state, title, url) {
    var result = origReplaceState2.apply(this, arguments);
    setTimeout(syncCurrentUrlFromLocation, 0);
    return result;
  };

  try {
    var locProto4 = Object.getPrototypeOf(window.location);
    var hrefDesc2 = Object.getOwnPropertyDescriptor(locProto4, "href");
    if (hrefDesc2 && hrefDesc2.set) {
      var origHrefSet = hrefDesc2.set;
      Object.defineProperty(locProto4, "href", {
        configurable: true,
        enumerable: hrefDesc2.enumerable,
        get: function() { return hrefDesc2.get.call(this); },
        set: function(url) {
          var result = origHrefSet.call(this, url);
          setTimeout(syncCurrentUrlFromLocation, 0);
          return result;
        }
      });
    }
  } catch (e) {}

  ["assign", "replace"].forEach(function(fn) {
    try {
      var locProto5 = Object.getPrototypeOf(window.location);
      var origFn2 = locProto5[fn];
      if (typeof origFn2 === "function") {
        locProto5[fn] = function(url) {
          var result = origFn2.call(this, url);
          setTimeout(syncCurrentUrlFromLocation, 0);
          return result;
        };
      }
    } catch (e) {}
  });

  var titleObserver = new MutationObserver(function() {
    setTimeout(syncCurrentUrlFromLocation, 50);
  });
  if (document.querySelector("title")) {
    titleObserver.observe(document.querySelector("title"), { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", function() {
      var t = document.querySelector("title");
      if (t) titleObserver.observe(t, { childList: true, subtree: true });
    });
  }

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

function rewriteCookies(setCookieHeader, targetOrigin, proxyOrigin) {
  if (!setCookieHeader) return setCookieHeader;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return cookies.map(cookie => {
    let rewritten = cookie
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*Path=[^;]+/gi, "; Path=/")
      .replace(/;\s*SameSite=[^;]+/gi, "; SameSite=None")
      .replace(/;\s*Secure/gi, "");
    if (!/Secure/i.test(rewritten)) {
      rewritten += "; Secure";
    }
    return rewritten;
  });
}

async function fetchFollowingRedirects(targetUrl, headers, redirectsLeft, method, body, cookieStore) {
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

  const setCookie = res.headers.get("set-cookie");
  if (setCookie && cookieStore) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookies.forEach(c => cookieStore.push(c));
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
      preserveBody ? body : undefined,
      cookieStore
    );
  }

  return { res, finalUrl: targetUrl };
}

app.get("/", (req, res) => {
  res.json({ status: "ok", proxy: "nebula-v2" });
});

const PROXY_ROUTE = new RegExp(
  "^" + PROXY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.*)$"
);

app.use((req, res, next) => {
  const host = req.headers.host || "";
  const hostname = host.split(":")[0];

  if (!req.path.startsWith(PROXY_PREFIX)) {
    return next();
  }

  try {
    const embedded = decodeURIComponent(req.path.slice(PROXY_PREFIX.length));
    const embeddedUrl = new URL(embedded);

    const hostParts = hostname.split(".");

    const ipIndex = hostname.indexOf(".ip.");
    if (ipIndex !== -1 && hostParts.length >= 3) {
      const prefix = hostname.substring(0, ipIndex);
      const proxyHostOnly = hostname.substring(ipIndex + 4);
      const proxyHostWithPort = proxyHostOnly + (host.includes(":") ? ":" + host.split(":")[1] : "");

      const newTarget = embeddedUrl.protocol + "//" + prefix + ".ip." + embeddedUrl.hostname + embeddedUrl.pathname + embeddedUrl.search + embeddedUrl.hash;
      const redirectUrl = req.protocol + "://" + proxyHostWithPort + PROXY_PREFIX + encodeURI(newTarget) + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");

      return res.redirect(307, redirectUrl);
    }

    const targetParts = embeddedUrl.hostname.split(".");
    if (hostParts.length > targetParts.length + 1) {
      for (let splitAt = 1; splitAt < hostParts.length - 1; splitAt++) {
        const extraSubdomains = hostParts.slice(0, splitAt).join(".");
        const possibleProxyHost = hostParts.slice(splitAt).join(".");

        const isLocalhost = possibleProxyHost === "localhost";
        const looksLikeDomain = hostParts[hostParts.length - 1].length >= 2 && hostParts.length - splitAt >= 2;

        if (isLocalhost || looksLikeDomain) {
          const newTarget = embeddedUrl.protocol + "//" + extraSubdomains + "." + embeddedUrl.hostname + embeddedUrl.pathname + embeddedUrl.search + embeddedUrl.hash;
          const redirectUrl = req.protocol + "://" + possibleProxyHost + (host.includes(":") ? ":" + host.split(":")[1] : "") + PROXY_PREFIX + encodeURI(newTarget) + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");

          return res.redirect(307, redirectUrl);
        }
      }
    }
  } catch (e) {}

  next();
});

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
      targetUrl = new URL(decodeURIComponent(target));
    } catch (err) {
      return res.status(400).send("Invalid target URL: " + target);
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return res.status(400).send("Only http/https targets are supported.");
    }

    const HTTPS_ONLY_DOMAINS = [
      "googlevideo.com",
      "googleapis.com",
      "gstatic.com",
      "google.com", "www.google.com",
      "doubleclick.net",
      "googlesyndication.com"
    ];
    if (targetUrl.protocol === "http:" && HTTPS_ONLY_DOMAINS.some(d => targetUrl.hostname === d || targetUrl.hostname.endsWith("." + d))) {
      const httpsUrl = targetUrl.toString().replace(/^http:/, "https:");
      return res.redirect(307, PROXY_PREFIX + encodeURI(httpsUrl));
    }

    try {
      const isTopLevelNavigation =
        req.headers["sec-fetch-dest"] === "document" ||
        (!req.headers["sec-fetch-dest"] && !req.headers["x-requested-with"]);

      const forwardHeaders = {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": req.headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
        "Accept-Encoding": req.headers["accept-encoding"] || "gzip, deflate, br",
        "Cache-Control": req.headers["cache-control"] || "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": req.headers["sec-fetch-dest"] || "document",
        "Sec-Fetch-Mode": req.headers["sec-fetch-mode"] || "navigate",
        "Sec-Fetch-Site": req.headers["sec-fetch-site"] || "none",
        "Sec-Fetch-User": req.headers["sec-fetch-user"] || "?1",
        "Sec-Ch-Ua": req.headers["sec-ch-ua"] || '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "Sec-Ch-Ua-Mobile": req.headers["sec-ch-ua-mobile"] || "?0",
        "Sec-Ch-Ua-Platform": req.headers["sec-ch-ua-platform"] || '"Windows"',
        "Sec-Ch-Ua-Platform-Version": req.headers["sec-ch-ua-platform-version"] || '"10.0.0"',
        "Sec-Ch-Ua-Arch": req.headers["sec-ch-ua-arch"] || '"x86"',
        "Sec-Ch-Ua-Bitness": req.headers["sec-ch-ua-bitness"] || '"64"',
        "Sec-Ch-Ua-Full-Version": req.headers["sec-ch-ua-full-version"] || '"126.0.0.0"',
        "Sec-Ch-Ua-Full-Version-List": req.headers["sec-ch-ua-full-version-list"] || '"Not/A)Brand";v="8.0.0.0", "Chromium";v="126.0.0.0", "Google Chrome";v="126.0.0.0"',
        "DNT": req.headers["dnt"] || "1",
        "Connection": "keep-alive",
        "Priority": req.headers["priority"] || "u=0, i",
      };

      if (req.headers["content-type"]) {
        forwardHeaders["Content-Type"] = req.headers["content-type"];
      }

      const referer = req.headers["referer"];
      if (referer) {
        try {
          const refUrl = new URL(referer);
          if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
            const embedded = decodeURIComponent(refUrl.pathname.slice(PROXY_PREFIX.length));
            forwardHeaders["Referer"] = embedded;
          } else {
            forwardHeaders["Referer"] = referer;
          }
        } catch (e) {
          forwardHeaders["Referer"] = referer;
        }
      } else if (!isTopLevelNavigation) {
        forwardHeaders["Referer"] = targetUrl.origin + "/";
      }

      if (req.headers["origin"]) {
        try {
          const origUrl = new URL(req.headers["origin"]);
          if (origUrl.pathname.startsWith(PROXY_PREFIX)) {
            const embedded = decodeURIComponent(origUrl.pathname.slice(PROXY_PREFIX.length));
            forwardHeaders["Origin"] = new URL(embedded).origin;
          } else {
            forwardHeaders["Origin"] = req.headers["origin"];
          }
        } catch (e) {
          forwardHeaders["Origin"] = req.headers["origin"];
        }
      } else if (!isTopLevelNavigation) {
        forwardHeaders["Origin"] = targetUrl.origin;
      }

      const cookieKey = targetUrl.hostname;
      if (cookieJar.has(cookieKey)) {
        forwardHeaders["Cookie"] = cookieJar.get(cookieKey);
      }
      if (req.headers["cookie"]) {
        const existing = forwardHeaders["Cookie"] || "";
        forwardHeaders["Cookie"] = existing ? existing + "; " + req.headers["cookie"] : req.headers["cookie"];
      }

      const hasBody =
        !["GET", "HEAD"].includes(req.method) &&
        Buffer.isBuffer(req.body) &&
        req.body.length > 0;

      const cookieStore = [];
      const { res: upstream, finalUrl } = await fetchFollowingRedirects(
        targetUrl.toString(),
        forwardHeaders,
        MAX_REDIRECTS,
        req.method,
        hasBody ? req.body : undefined,
        cookieStore
      );

      const contentType = upstream.headers.get("content-type") || "";

      if (cookieStore.length > 0) {
        const existing = cookieJar.get(cookieKey) || "";
        const newCookies = cookieStore.map(c => c.split(";")[0]).join("; ");
        cookieJar.set(cookieKey, existing ? existing + "; " + newCookies : newCookies);
      }

      if (isTopLevelNavigation) {
        res.cookie("proxy_last_origin", new URL(finalUrl).origin, {
          httpOnly: false,
          sameSite: "Lax",
          path: "/",
          maxAge: 86400000
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
        "alt-svc",
        "report-to",
        "nel",
        "permissions-policy",
        "feature-policy",
        "cross-origin-embedder-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
        "origin-trial"
      ]);

      upstream.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!skipHeaders.has(lowerKey)) {
          if (lowerKey === "set-cookie") {
            const rewritten = rewriteCookies(value, targetUrl.origin, req.headers.host);
            rewritten.forEach(c => res.appendHeader("Set-Cookie", c));
          } else {
            res.setHeader(key, value);
          }
        }
      });

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Expose-Headers", "*");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      if (contentType.includes("text/html")) {
        const html = await upstream.text();
        const rewritten = rewriteHtml(html, finalUrl);
        res.status(upstream.status).send(rewritten);
      } else if (contentType.includes("text/css") || contentType.includes("stylesheet")) {
        const css = await upstream.text();
        const rewritten = rewriteCss(css, finalUrl);
        res.status(upstream.status).send(rewritten);
      } else if (contentType.includes("javascript") || contentType.includes("js") || targetUrl.pathname.endsWith(".js")) {
        let js = await upstream.text();
        const jsBase = finalUrl;
        js = js.replace(
          /import\s*\(\s*["']([^"']+)["']\s*\)/g,
          (m, url) => `import("${rewriteUrl(url, jsBase)}")`
        );
        js = js.replace(
          /new\s+URL\s*\(\s*["']([^"']+)["']/g,
          (m, url) => `new URL("${rewriteUrl(url, jsBase)}"`
        );
        res.status(upstream.status).type(contentType || "application/javascript").send(js);
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
  console.log(`NebulaProxy running on :${PORT}`);
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
    targetUrl = new URL(decodeURIComponent(target));
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
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
