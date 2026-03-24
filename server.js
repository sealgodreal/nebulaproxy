const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { CookieJar } = require("tough-cookie");

const app = express();

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const PREFIX = "/nebula/proxy?url=";
const cookieJarMap = new Map();

function proxify(url, origin) {
  return PREFIX +
    encodeURIComponent(url) +
    "&origin=" + encodeURIComponent(origin || url);
}

app.head("/nebula/health", (req, res) => {
  res.status(200).end();
});

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
        "Cookie": cookies
      }
    });

    const setCookie = response.headers.raw()["set-cookie"];
    if (setCookie) setCookie.forEach(c => jar.setCookieSync(c, target));

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (loc) {
        const newUrl = new URL(loc, target).href;
        return res.redirect(proxify(newUrl, origin));
      }
    }

    const type = response.headers.get("content-type") || "";
    res.status(response.status);
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
          const abs = new URL(u, target).href;
          return a+'="'+proxify(abs, origin)+'"';
        }catch{return m;}
      });

      body = body.replace(/url\\((.*?)\\)/gi,(m,u)=>{
        try{
          const clean=u.replace(/['"]/g,"");
          const abs=new URL(clean,target).href;
          return 'url("'+proxify(abs,origin)+'")';
        }catch{return m;}
      });

      body = body.replace(/<\/body>/i,`
<script>
(function(){
const ORIGIN = window.__ORIGIN__;
let BASE = window.__BASE__;

function proxifyUrl(url){
  try{
    const abs = new URL(url, BASE).href;
    BASE = abs;
    return "/nebula/proxy?url="+encodeURIComponent(abs)+"&origin="+encodeURIComponent(ORIGIN);
  }catch{return url;}
}

function load(url){
  let frame = document.querySelector("#nebula-frame");
  if(!frame){
    frame = document.createElement("iframe");
    frame.id = "nebula-frame";
    frame.style.position="absolute";
    frame.style.top="0";
    frame.style.left="0";
    frame.style.width="100%";
    frame.style.height="100%";
    frame.style.border="none";
    document.body.appendChild(frame);
  }
  frame.src = proxifyUrl(url);
}

document.addEventListener("click", e=>{
  const a = e.target.closest("a");
  if(a && a.href){
    e.preventDefault();
    load(a.href);
  }
});

document.addEventListener("submit", e=>{
  e.preventDefault();
  const f = e.target;
  const data = new FormData(f);
  const q = new URLSearchParams(data).toString();
  load(f.action + (q?"?"+q:""));
});

const oldFetch = fetch;
fetch = (u,...a)=>oldFetch(proxifyUrl(u),...a);
const oldOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){ return oldOpen.call(this,m,proxifyUrl(u),...r); };

const push = history.pushState;
history.pushState=function(s,t,u){ if(u) load(u); return push.apply(this,arguments); };

function hookFunctions(){
  if(window.launch){
    const orig = window.launch;
    window.launch = function(url,...args){ return orig(proxifyUrl(url),...args); };
  }
}
setInterval(hookFunctions,500);

function fixInline(el){
  try{
    for(const attr of el.attributes||[]){
      if(attr.name.startsWith("on")){
        attr.value = attr.value.replace(/(['"])(\\/[^'"]+)['"]/g,(m,q,u)=>'"'+proxifyUrl(u)+'"');
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

})();
</script>
</body>`);

      res.send(body);

    } else {
      res.setHeader("Content-Type", type);
      response.body.pipe(res);
    }

  } catch (e) {
    res.status(500).send("Proxy error: "+e.message);
  }
});

app.use((req,res)=>{
  if(req.path.startsWith("/nebula/proxy"))
    return res.status(404).send("Not found");

  try{
    let origin;
    if(req.headers.referer){
      const ref = new URL(req.headers.referer);
      origin = new URLSearchParams(ref.search).get("origin") || ref.origin;
    } else {
      origin = req.protocol + "://" + req.get("host");
    }

    const target = new URL(req.originalUrl, origin).href;
    return res.redirect("/nebula/proxy?url="+encodeURIComponent(target)+"&origin="+encodeURIComponent(origin));

  }catch{
    res.status(404).send("Bad request");
  }
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`server runnin on port 3000`);
});
