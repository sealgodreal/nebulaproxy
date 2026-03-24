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

app.get("/", (req, res) => {
  res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Nebula Proxy | Dead End</title>

<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">

<style>
* { margin: 0; box-sizing: border-box; }

:root {
  --bg: #000;
  --surface: rgba(20,20,20,0.75);
  --border: #222;
  --text: #fff;
  --text-muted: #888;
  --hover: #1e1e1e;
}

body {
  background: black;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  height: 100vh;
  overflow: hidden;
}

#bg {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
}

.wrapper {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.container {
  backdrop-filter: blur(12px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 32px;
  width: 90%;
  max-width: 600px;
  text-align: center;
  box-shadow: 0 0 60px rgba(0,0,0,0.7);
}

h1 {
  font-weight: 500;
  margin-bottom: 10px;
}

p {
  color: var(--text-muted);
  font-size: 14px;
  margin: 10px 0;
  line-height: 1.5;
}

.proxy-box {
  background: #0a0a0a;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  margin: 15px 0;
  font-size: 13px;
  word-break: break-all;
}

.copy-btn {
  margin-top: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  border: none;
  background: var(--hover);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  transition: 0.15s;
}

.copy-btn:hover {
  background: #2a2a2a;
}

.links {
  margin-top: 20px;
}

.link-btn {
  display: block;
  border: 1px solid var(--border);
  padding: 11px;
  margin: 6px 0;
  border-radius: 10px;
  color: var(--text);
  text-decoration: none;
  transition: 0.15s;
}

.link-btn:hover {
  background: var(--hover);
  transform: translateY(-1px);
}
</style>
</head>

<body>

<canvas id="bg"></canvas>

<div class="wrapper">
  <div class="container">
    <h1>Nebula Proxy</h1>

    <p>You've reached a dead end! This endpoint exists for uptime monitoring.</p>

    <p>To use the proxy, append a URL to:</p>

    <div class="proxy-box" id="proxyUrl">
      https://nebulaproxy-j7xn.onrender.com/nebula/proxy?url=
    </div>

    <button class="copy-btn" onclick="copyProxy()">Copy URL</button>

    <p>Or head over to <strong>Nebula Browser</strong>:</p>

    <div class="links">
      <a class="link-btn" href="https://nebulaunblocking.vercel.app" target="_blank">https://nebulaunblocking.vercel.app</a>
    </div>
  </div>
</div>

<script>
function copyProxy() {
  const text = document.getElementById("proxyUrl").innerText;
  navigator.clipboard.writeText(text);
}

const canvas = document.getElementById("bg");
const ctx = canvas.getContext("2d");

let particles = [];

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.onresize = resize;
resize();

for (let i = 0; i < 60; i++) {
  particles.push({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3
  });
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      let dx = particles[i].x - particles[j].x;
      let dy = particles[i].y - particles[j].y;
      let dist = Math.sqrt(dx*dx + dy*dy);

      if (dist < 120) {
        ctx.strokeStyle = "rgba(255,255,255," + (1 - dist/120) * 0.15 + ")";
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.stroke();
      }
    }
  }

  particles.forEach(p => {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();

    p.x += p.vx;
    p.y += p.vy;

    if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
    if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
  });

  requestAnimationFrame(draw);
}

draw();
</script>

</body>
</html>
  `);
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
