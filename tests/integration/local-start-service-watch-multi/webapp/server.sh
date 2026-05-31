#!/bin/sh
# server.sh — webapp server for the local-start-service-watch-multi
# integ fixture. verify.sh rewrites this whole file mid-run to bump
# the `VERSION` marker (v1 -> v2) and asserts a continuous curl-loop
# probe (on the shared cdkl-svc network, resolving `srv` via Service
# Connect DNS alias) sees a v1 → v2 transition with zero connection
# refusals across the rolling deploy. Keep the script trivial so the
# asset re-stages quickly on re-synth.
set -eu
VERSION=v1
mkdir -p /www
printf '%s' "${VERSION}" > /www/index.html
exec httpd -f -p 8080 -h /www
