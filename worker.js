export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
          },
        });
      }

      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response("Missing ?url= parameter", { status: 400 });
      }

      const reqHeaders = new Headers({ "User-Agent": "Mozilla/5.0" });
      if (request.headers.has("Range")) {
        reqHeaders.set("Range", request.headers.get("Range"));
      }

      let upstream = await fetch(targetUrl, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow",
      });

      // Some geospatial file servers (like DLR) reject HEAD with 404/405; probe with 1-byte GET
      if (request.method === "HEAD" && !upstream.ok) {
        reqHeaders.set("Range", "bytes=0-0");
        upstream = await fetch(targetUrl, {
          method: "GET",
          headers: reqHeaders,
          redirect: "follow",
        });
      }

      const respHeaders = new Headers(upstream.headers);
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

      // Expose full file size in Content-Length if probed via Content-Range: bytes 0-0/TOTAL
      const contentRange = upstream.headers.get("Content-Range");
      if (request.method === "HEAD" && contentRange && contentRange.includes("/")) {
        const totalSize = contentRange.split("/")[1];
        if (totalSize && totalSize !== "*") {
          respHeaders.set("Content-Length", totalSize);
        }
      }

      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: request.method === "HEAD" && upstream.status === 206 ? 200 : upstream.status,
        headers: respHeaders,
      });
    }

    return env.ASSETS.fetch(request);
  },
};