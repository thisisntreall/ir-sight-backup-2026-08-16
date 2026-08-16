/**
 * Cloudflare Worker route (attach to drughelp.co):
 *   drughelp.co/hidden-camera-detector*
 *
 * Proxies that path to the Vercel origin. Rest of the site stays on nginx.
 * Set ORIGIN after the first Vercel deploy, then wrangler deploy.
 */
const PREFIX = "/hidden-camera-detector";
const ORIGIN = "https://hidden-camera-detector.vercel.app";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === PREFIX) {
      url.pathname = `${PREFIX}/`;
      return Response.redirect(url.toString(), 308);
    }

    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      return new Response("Not found", { status: 404 });
    }

    const dest = new URL(url.pathname + url.search, ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("host", new URL(ORIGIN).host);
    headers.delete("cf-connecting-ip");

    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    const upstream = await fetch(dest, init);
    const out = new Headers(upstream.headers);
    out.set("x-proxied-by", "drughelp-ir-sight-worker");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};
