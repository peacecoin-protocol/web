#!/usr/bin/env python3
"""Dev server for this repo: python3 -m http.server with no-cache headers,
so edited JS/CSS is always picked up on a normal reload (no hard-reload
needed). Usage: python3 serve.py [port]  (default 8123, binds 0.0.0.0)"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
print(f'serving on http://0.0.0.0:{port}/ (no-cache)')
HTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()
