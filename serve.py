from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import urllib.request


class CorsProxyHandler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_HEAD(self):
        if self.path.startswith("/proxy?"):
            self._handle_proxy(method="HEAD")
        else:
            super().do_HEAD()

    def do_GET(self):
        if self.path.startswith("/proxy?"):
            self._handle_proxy(method="GET")
        else:
            super().do_GET()

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def _handle_proxy(self, method: str):
        qs = parse_qs(urlparse(self.path).query)
        target_url = qs.get("url", [None])[0]
        if not target_url:
            self.send_error(400, "Missing 'url' query parameter")
            return

        headers = {"User-Agent": "Mozilla/5.0"}
        if "Range" in self.headers:
            headers["Range"] = self.headers["Range"]

        req = urllib.request.Request(target_url, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                self._send_cors_headers()
                for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                    val = resp.headers.get(h)
                    if val:
                        self.send_header(h, val)
                self.end_headers()
                if method == "GET":
                    while chunk := resp.read(256 * 1024):
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self._send_cors_headers()
            self.end_headers()
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8000), CorsProxyHandler)
    print("Serving GeoData Fetcher at http://localhost:8000")
    server.serve_forever()