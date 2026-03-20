const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");
const https = require("https");

const app = express();

const agent = new https.Agent({ rejectUnauthorized: false });

function getHeaders(base) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua":
      '"Chromium";v="122", "Google Chrome";v="122", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Referer": base.origin,
    "Origin": base.origin,
    "Host": base.host
  };
}

app.get("/nebula/proxy", async (req, res) => {
  const targetUrl = req.query.url || Object.keys(req.query)[0];
  if (!targetUrl) return res.status(400).send("Missing ?url=");

  try {
    const base = new URL(targetUrl);

    const response = await fetch(targetUrl, {
      method: "GET",
      agent,
      redirect: "manual",
      headers: getHeaders(base)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const newUrl = new URL(location, base).href;
        return res.redirect(
          "/nebula/proxy?url=" + encodeURIComponent(newUrl)
        );
      }
    }

    const contentType = response.headers.get("content-type") || "";
    res.status(response.status);

    res.removeHeader("content-security-policy");
    res.removeHeader("x-frame-options");

    if (contentType.includes("text/html")) {
      let body = await response.text();

      body = body.replace(
        /<head>/i,
        `<head><base href="${base.origin}/">`
      );

      body = body.replace(/(href|src|action)="(.*?)"/gi, (match, attr, link) => {
        try {
          const newUrl = new URL(link, base).href;
          return `${attr}="/nebula/proxy?url=${encodeURIComponent(newUrl)}"`;
        } catch {
          return match;
        }
      });

      body = body.replace(/url\((.*?)\)/gi, (match, url) => {
        try {
          const clean = url.replace(/['"]/g, "");
          const newUrl = new URL(clean, base).href;
          return `url("/nebula/proxy?url=${encodeURIComponent(newUrl)}")`;
        } catch {
          return match;
        }
      });

      body = body.replace(/fetch\((.*?)\)/g, (match, url) => {
        return `fetch("/nebula/proxy?url=" + encodeURIComponent(${url}))`;
      });

      body = body.replace(
        /<\/body>/i,
        `
<script>
(function(){
function proxifyUrl(url){
  try{return"/nebula/proxy?url="+encodeURIComponent(new URL(url,location.href).href)}
  catch{return url}
}
const oldFetch=window.fetch;
window.fetch=function(url,...args){
  return oldFetch(proxifyUrl(url),...args)
}
const oldOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,...r){
  return oldOpen.call(this,m,proxifyUrl(u),...r)
}
const oldImage=window.Image;
window.Image=function(w,h){
  const i=new oldImage(w,h);
  const d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
  Object.defineProperty(i,"src",{
    set(v){d.set.call(this,proxifyUrl(v))},
    get(){return d.get.call(this)}
  });
  return i;
}
const origAppend=Element.prototype.appendChild;
Element.prototype.appendChild=function(el){
  if(el.tagName==="SCRIPT"||el.tagName==="LINK"||el.tagName==="IMG"){
    if(el.src)el.src=proxifyUrl(el.src);
    if(el.href)el.href=proxifyUrl(el.href);
  }
  return origAppend.call(this,el)
}
})();
</script>
</body>`
      );

      res.send(body);
    } else {
      const buffer = await response.buffer();
      res.set("Content-Type", contentType);
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

app.listen(3000, () =>
  console.log("Proxy running at http://localhost:3000")
);