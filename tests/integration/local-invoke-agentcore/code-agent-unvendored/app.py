# Unvendored-dependency AgentCore CodeConfiguration agent for the cdkl
# invoke-agentcore integ test. It declares a third-party dependency
# (requirements.txt: requests) but does NOT vendor it into the bundle.
#
# The AgentCore managed runtime does not install requirements.txt at runtime —
# dependencies must be vendored into the bundle at deploy time. So cdkl builds
# and runs this bundle AS-IS (no install): the top-level import below fails
# with ModuleNotFoundError exactly as it would on a real deploy, and cdkl warns
# up-front with the vendoring recipe. This is the regression guard for the
# false-green where the from-source build used to pip-install requirements.txt
# locally (issue #455) — making a non-vendored bundle pass locally but fail
# deployed.
import requests  # noqa: F401  (intentionally unvendored — must fail at runtime)
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


# Never reached: the import above raises ModuleNotFoundError before the server
# can start. Kept so the bundle is a well-formed agent absent the missing dep.
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    print("unvendored code agent listening on 0.0.0.0:8080", file=sys.stderr, flush=True)
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
