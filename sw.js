app.get("/nebula/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");

  res.send(`
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/nebula/proxy")) {
    event.respondWith(
      fetch("/nebula/proxy?url=" + encodeURIComponent(url.href))
    );
  }
});
`);
});
