export async function onRequest(context) {
  const { request } = context;

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

  const targetUrl = new URL(request.url).searchParams.get("url");
  if (!targetUrl) {
    return new Response("Missing ?url= parameter", { status: 400 });
  }

  const reqHeaders = new Headers({ "User-Agent": "Mozilla/5.0" });
  if (request.headers.has("Range")) {
    reqHeaders.set("Range", request.headers.get("Range"));
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: reqHeaders,
    redirect: "follow",
  });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}