// ts code so beautiful twin
const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { CookieJar } = require("tough-cookie");
const { createProxyServer } = require("http-proxy");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

const wsProxy = createProxyServer({ changeOrigin: true, secure: false, ws: true });

const PREFIX = "/lessons/math";
const PROXY = "https://onlinehomeworkhelper.onrender.com"; // http://localhost:3000 - for testin
const cookieJarMap = new Map();

const blockedKeywords = [ "porn", "gore", ];
const blockedLinks = [ "pornhub.com", "brazzers.com",  "rule34.xxx", "xvideos.com", ];

function isBlocked(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const origin = parsed.origin.toLowerCase();

    if (blockedLinks.some(link => hostname === link.toLowerCase())) { return true; }
    if (blockedKeywords.some(k => hostname.includes(k))) { return true; }

    return false;
  } catch {
    return false;
  }
}

function encode(url) { return encodeURIComponent(url); }

function proxify(url, base) {
  try {
    if (!url || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("#")) return url;
    if (url.includes(PREFIX)) return url;
    const abs = new URL(url, base).href;
    if (isBlocked(abs)) { return `/assets/link-restricted.html?link=${encode(abs)}`; }
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

  body = body.replace(/(launch)\s*=\s*(['"])([^'"]+)\2/gi, (m, attr, q, u) => {
    return `${attr}=${q}${proxify(u, base)}${q}`;
  });

  body = body.replace(/(\bon\w+)\s*=\s*(['"])([^'"]+)\2/gi, (m, attr, q, u) => {
    return `${attr}=${q}${u.replace(/(https?:\/\/[^\s"'<>]+)/gi, (_, aq, url) => proxify(url, base))}${q}`;
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
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.startsWith("javascript:") ||
        url.startsWith("#") ||
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

      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        let value = attr.value;
        if (!value) continue;

        if (["href", "src", "action", "launch"].includes(name)) {
          if (!value.includes("/lessons/math?url=")) {
            el.setAttribute(attr.name, proxify(value));
          }
        } else if (/^on/.test(name)) {
          const rewritten = value.replace(/(https?:\\/\\/[^\\s"'<>]+)/g, proxify);
          if (rewritten !== value) el.setAttribute(attr.name, rewritten);
        }
      }

      if (el.hasAttribute("style")) {
        const css = el.getAttribute("style");
        const rewritten = css.replace(/url\\((['"]?)([^'")]+)\\1\\)/gi, (_, q, u) => "url(" + q + proxify(u) + q + ")");
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
      url = typeof url === 'string' ? proxify(url) : new Request(proxify(url.url), url);
    } catch {}
    return origFetch(url, ...args);
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
    if (!a) return;
    const raw = a.getAttribute("href");
    if (!raw || raw.startsWith("/lessons/math")) return;
    e.preventDefault();
    location.href = proxify(raw);
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

app.get("/lessons/algebra", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --bg:        #000000;
      --surface:   #0f0f0f;
      --surface-2: #1a1a1a;
      --border:    #2a2a2a;
      --border-2:  #333333;
      --text:      #ffffff;
      --muted:     #888888;
      --accent:    #222222;
      --accent-dim:#333333;
      --btn-bg:    #111111;
      --btn-hover: #222222;
      --btn-text:  #f0f0f0;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      gap: 28px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 320px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.35);
    }

    .card-header {
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--border);
    }

    .card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: 0.01em;
    }

    .card-subtitle {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }

    .fields {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    label {
      font-size: 11px;
      font-weight: 500;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    input {
      width: 100%;
      padding: 9px 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text);
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }

    input::placeholder {
      color: var(--muted);
      opacity: 0.5;
    }

    input:focus {
      border-color: var(--border-2);
      background: var(--surface-2);
    }

    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }
    input[type=number] { -moz-appearance: textfield; }

    .card-footer {
      padding: 4px 20px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    button {
      width: 100%;
      padding: 10px;
      background: var(--accent);
      color: var(--btn-text);
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: none;
      border-radius: 7px;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }

    button:hover  { opacity: 0.88; }
    button:active { opacity: 0.72; transform: scale(0.99); }

    #log {
      display: none;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 10px 12px;
      max-height: 120px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border-2) transparent;
    }

    #log.visible { display: block; }

    #log .entry {
      font-family: 'DM Mono', monospace;
      font-size: 11px;
      line-height: 1.7;
      color: var(--muted);
    }

    #log .entry::before {
      content: '› ';
      color: var(--border-2);
    }

    #log .entry.done {
      color: var(--accent);
    }

    #log .entry.done::before {
      content: '✓ ';
      color: var(--accent-dim);
    }
  </style>
</head>
<body>

  <div class="card">
    <div class="card-header">
      <div class="card-title">Nebula | Blooket Flooder</div>
      <div class="card-subtitle">floods any blooket game with bots.</div>
    </div>

    <div class="fields">
      <div class="field">
        <label for="code">id</label>
        <input id="code" placeholder="0000000" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="count">amount</label>
        <input id="count" type="number" value="2" min="1" max="100">
      </div>
    </div>

    <div class="card-footer">
      <button onclick="start()">flood</button>
      <div id="log"></div>
    </div>
  </div>

  <script>
    const logEl = document.getElementById("log");

    function log(msg, done = false) {
      logEl.classList.add("visible");
      const line = document.createElement("div");
      line.className = "entry" + (done ? " done" : "");
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function start() {
      const code  = document.getElementById("code").value.trim(); 
      const count = parseInt(document.getElementById("count").value);

      logEl.innerHTML = "";
      logEl.classList.remove("visible");

      if (!code) return log("please enter a game id.");

      log("launching " + count + " bot" + (count !== 1 ? "s" : "") + ", please wait...");

      const res  = await fetch("/lessons/algebra/helping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, count })
      });

      const data = await res.json();
      data.forEach(r => log(r));
      log("finished flood attack!", true);
    }
  </script>

</body>
</html>
  `);
});

let browser;

async function getBrowser() {
  if (!browser) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        timeout: 60000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage"
        ]
      });
    } catch (err) {
      console.error("Failed to launch browser:", err);
      browser = null;
      throw err;
    }
  }
  return browser;
}

async function joinBot(code, name, index = 0) {
  const browser = await getBrowser();

  await new Promise(r => setTimeout(r, (index + 1) * 100));

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", req => {
    if (["image", "font", "media"].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    await page.setViewport({ width: 1280, height: 720 });

    await page.goto("https://play.blooket.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    page.click(".cky-btn-accept").catch(() => {});

    await page.waitForSelector('input[name="join-code"]', { timeout: 20000 });
    await page.type('input[name="join-code"]', code, { delay: 5 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.click('button[aria-label="Submit"]')
    ]);

    await new Promise(r => setTimeout(r, 1000));

    const nickSelectors = [
      'input[placeholder="Nickname"]',
      'input[placeholder*="name" i]',
      'input[placeholder="Enter Nickname"]',
      'input[type="text"]'
    ];

    let typed = false;
    for (const sel of nickSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.type(sel, name, { delay: 5 });
        typed = true;
        break;
      } catch {}
    }

    if (!typed) throw new Error(`${name}: could not find nickname field`);

    const joinSelectors = [
      '[class*="joinButton"]',
      '[aria-label*="join" i]',
      'button[type="submit"]'
    ];

    let clicked = false;
    for (const sel of joinSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.click(sel);
        clicked = true;
        break;
      } catch {}
    }

    if (!clicked) throw new Error(`${name}: could not find join button`);

    setInterval(async () => {
      try {
        await page.mouse.move(
          300 + Math.random() * 10,
          300 + Math.random() * 10
        );
      } catch {}
    }, 3000);

    return `joined as \"${name}\"`;
  } catch (e) {
    console.error(`[${name}] error:`, e.message.toLowerCase());
    await page.close();
    return `failed: ${name} — ${e.message.toLowerCase()}`;
  }
}

async function runLimited(tasks, limit) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = task().then(r => {
      results.push(r);
      executing.splice(executing.indexOf(p), 1);
    });
    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

app.post("/lessons/algebra/helping", async (req, res) => {
  const { code, count } = req.body;

  if (!code || !count) {
    return res.json(["Missing code or count"]);
  }

  const tasks = [];

  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const usedNames = new Set();

  for (let i = 1; i <= count; i++) {
    let name;
    do {
      name = "";
      for (let j = 0; j < 8; j++) {
        name += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (usedNames.has(name) && usedNames.size < Math.pow(chars.length, 8));
    usedNames.add(name);

    const index = i - 1;
    tasks.push(() => joinBot(code, name, index));
  }

  const concurrency = Math.min(count, 8);
  const results = await runLimited(tasks, concurrency);

  res.json(results);
});

app.get(PREFIX, async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  if (isBlocked(target)) { return res.redirect(`/assets/link-restricted.html?link=${encode(target)}`); }

  const origin = req.query.origin || target;
  const classroom = req.query.classroom;

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
    res.setHeader("Service-Worker-Allowed", "/");
    res.removeHeader("content-security-policy");
    res.removeHeader("x-frame-options");

    if (contentType.includes("text/html")) {
      let body = await response.text();

      const script = clientScript(origin, target);
      if (/<\/head>/i.test(body)) body = body.replace(/<\/head>/i, `${script}</head>`);
      else body = script + body;

    if (classroom) {
const classroomScript = `
<script>
window.addEventListener('load', () => {
  try {
    if (window.__DEVTOOLS_SCRIPT_LOADED__) return;
    window.__DEVTOOLS_SCRIPT_LOADED__ = true;
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.id = "devtools-script";
    if (!document.getElementById("devtools-script")) {
      script.text = decodeURIComponent("${encodeURIComponent(classroom)}");
      document.body.appendChild(script);
    }
  } catch(e) {
    console.error('devtools error: ', e);
  }
});
</script>
`;

      if (/<\/body>/i.test(body)) {
        body = body.replace(/<\/body>/i, `${classroomScript}</body>`);
      } else {
        body = body + classroomScript;
      }
    }

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

app.use("/assets", express.static(require("path").join(__dirname, "assets")));

app.use((req, res) => {
  if (req.path.startsWith("/assets")) { return res.status(404).send("Not found"); }
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