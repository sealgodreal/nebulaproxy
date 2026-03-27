const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { CookieJar } = require("tough-cookie");
const { createProxyServer } = require("http-proxy");

const app = express();

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false
});

const wsProxy = createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true
});

const PREFIX = "/nebula/proxy?url=";
const cookieJarMap = new Map();

function proxify(url, origin) {
  try {
    if (!url || url.includes("/nebula/proxy")) return url;
    const abs = new URL(url, origin).href;
    return PREFIX + encodeURIComponent(abs) + "&origin=" + encodeURIComponent(origin);
  } catch {
    return url;
  }
}

app.get("/nebula/proxy", async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  const origin = req.query.origin || target;

  try {
    let jar = cookieJarMap.get(origin);
    if (!jar) {
      jar = new CookieJar();
      cookieJarMap.set(origin, jar);
    }

    const cookies = await jar.getCookieString(target);

    const response = await fetch(target, {
      agent: target.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": origin,
        "Origin": origin,
        "Cookie": cookies,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...(req.headers.range ? { Range: req.headers.range } : {})
      }
    });

    const setCookie = response.headers.raw()["set-cookie"];
    if (setCookie) setCookie.forEach(c => jar.setCookieSync(c, target));

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (loc) {
        const newUrl = new URL(loc, target).href;
        return res.redirect(proxify(newUrl, origin));
      }
    }

    const type = response.headers.get("content-type") || "";
    res.status(response.status);

    const allowedHeaders = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range"
    ];

    response.headers.forEach((value, key) => {
      if (allowedHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (type.includes("text/html")) {
      let body = await response.text();

      body = body.replace(
        /<head>/i,
        `<head><script>
window.__ORIGIN__="${origin}";
window.__BASE__="${target}";
</script>`
      );

      body = body.replace(/(href|src|action)=["']([^"']+)["']/gi, (m,a,u)=>{
        try{
          return a+'="'+proxify(u, target)+'"';
        }catch{return m;}
      });

      body = body.replace(/<\/body>/i,`
<script>
(function(){
const ORIGIN = window.__ORIGIN__;
let BASE = window.__BASE__;

function proxifyUrl(url){
  try{
    if (!url || url.includes("/nebula/proxy")) return url;
    const abs = new URL(url, BASE).href;
    BASE = abs;
    return "/nebula/proxy?url=" +
      encodeURIComponent(abs) +
      "&origin=" + encodeURIComponent(ORIGIN);
  }catch{
    return url;
  }
}

function fixInline(el){
  try{
    for(const attr of el.attributes || []){
      if(attr.name.startsWith("on") && attr.value){
        attr.value = attr.value.replace(
          /(['"])(.*?)\\1/g,
          (match, quote, url) => {
            try {
              if (
                url.startsWith("javascript:") ||
                url.startsWith("#") ||
                url.startsWith("data:")
              ) return match;
              const abs = new URL(url, BASE).href;
              if (abs.includes("/nebula/proxy")) return match;
              return quote + proxifyUrl(abs) + quote;
            } catch {
              return match;
            }
          }
        );
      }
    }
  }catch{}
}

function fix(el){
  try{
    if(el.href) el.href = proxifyUrl(el.href);
    if(el.src) el.src = proxifyUrl(el.src);
    if(el.action) el.action = proxifyUrl(el.action);
    fixInline(el);
  }catch{}
}

document.querySelectorAll("*").forEach(fix);

new MutationObserver(muts=>{
  muts.forEach(m=>{
    m.addedNodes.forEach(n=>{
      if(n.nodeType===1){
        fix(n);
        n.querySelectorAll && n.querySelectorAll("*").forEach(fix);
      }
    });
  });
}).observe(document,{childList:true,subtree:true});

setInterval(()=>{
  document.querySelectorAll("*").forEach(fixInline);
},1000);

function hookLaunch(){
  if(window.launch && !window.launch.__nebula){
    const orig = window.launch;
    window.launch = function(url,...args){
      return orig(proxifyUrl(url),...args);
    };
    window.launch.__nebula = true;
  }
}
setInterval(hookLaunch, 500);

document.addEventListener("click", e=>{
  const a = e.target.closest("a");
  if(a && a.href){
    e.preventDefault();
    location.href = proxifyUrl(a.href);
  }
});

document.addEventListener("submit", e=>{
  e.preventDefault();
  const f = e.target;
  const data = new FormData(f);
  const q = new URLSearchParams(data).toString();
  location.href = proxifyUrl(f.action + (q?"?"+q:""));
});

const oldFetch = fetch;
fetch = (u,...a)=>oldFetch(proxifyUrl(u),...a);

const oldOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){
  return oldOpen.call(this,m,proxifyUrl(u),...r);
};

const OldWebSocket = window.WebSocket;
window.WebSocket = function(url, protocols){
  try {
    return new OldWebSocket(proxifyUrl(url), protocols);
  } catch {
    return new OldWebSocket(url, protocols);
  }
};

const push = history.pushState;
history.pushState = function(s,t,u){
  if(u && !u.includes("/nebula/proxy")){
    location.href = proxifyUrl(u);
  }
  return push.apply(this, arguments);
};

})();
</script>
</body>`);

      res.send(body);

    } else {
      if (response.body) {
        response.body.pipe(res);
      } else {
        res.end();
      }
    }

  } catch (e) {
    res.status(500).send("Proxy error: "+e.message);
  }
});

const server = app.listen(3000, () => {
  console.log("server runnin on port 3000");
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "https://nebulaproxy-j7xn.onrender.com");
    const target = url.searchParams.get("url");
    if (target) {
      wsProxy.ws(req, socket, head, { target });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

app.use((req,res)=>{
  if(req.path.startsWith("/nebula/proxy"))
    return res.status(404).send("Not found");

  try{
    const origin = req.protocol + "://" + req.get("host");
    const target = new URL(req.originalUrl, origin).href;

    if (target.includes("/nebula/proxy")) {
      return res.status(400).send("uhh something went wrong idk");
    }

    return res.redirect("/nebula/proxy?url="+encodeURIComponent(target)+"&origin="+encodeURIComponent(origin));

  }catch{
    res.status(404).send("Bad request");
  }
});
