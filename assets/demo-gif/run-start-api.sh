#!/usr/bin/env bash
# Split-pane recording: cdkl start-api against the local sample app, with
# a curl loop in the right pane to exercise the route. No AWS account,
# no Docker network plumbing beyond a single Lambda Runtime Interface
# Emulator container.
#
# Pre-warm steps (pnpm install, cdk synth) run OUTSIDE the recorded tmux
# session so the GIF only shows the cdkl + curl lines. `cdkl start-api`
# does its own internal synth via toolkit-lib at boot, but priming the
# cdk.out directory + node_modules keeps the recorded session fast.
#
# Pass --dry-run to print the planned vhs / tmux invocation without
# launching either, so the scaffold can be sanity-checked on a machine
# that does not have vhs or tmux installed yet.

set -e

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
SAMPLE_DIR="$DEMO_DIR/sample-app"
CONF="$DEMO_DIR/tmux-clean.conf"
PORT=8080

# Use the freshly-built cdkl from the repo's dist/, not whatever may be
# installed globally. Shadow `cdkl` on PATH with a symlink to the local
# build so the visible command in the GIF stays plain `cdkl`.
CDKL_BIN="$(cd "$DEMO_DIR/../.." && pwd)/dist/cli.js"
SHADOW_BIN="$(mktemp -d)"
ln -sf "$CDKL_BIN" "$SHADOW_BIN/cdkl"
export PATH="$SHADOW_BIN:$PATH"

# Per-pane bootstrap scripts written into a temp dir so we avoid 3-layer
# shell quoting between this script -> tmux send -> tmux's inner shell.
PANE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$SHADOW_BIN" "$PANE_DIR"
  tmux kill-session -t demo 2>/dev/null || true
}
trap cleanup EXIT

cat > "$PANE_DIR/left.sh" <<EOF
#!/usr/bin/env bash
export PATH="$SHADOW_BIN:\$PATH"
export FORCE_COLOR=1
export COLORTERM=truecolor
cd "$SAMPLE_DIR"
printf '\$ cdkl start-api --no-pull --port $PORT\n\n'
exec cdkl start-api --no-pull --port $PORT
EOF

# Right pane waits out the interactive picker (left pane) + the confirm +
# the server boot before curling. TUNE this sleep against the recorded
# timing — it must exceed (picker keystrokes + Y confirm + RIE boot). The
# selected HTTP API (MyHttpApi) lands on the first port ($PORT) because the
# picker lists HTTP API v2 first.
cat > "$PANE_DIR/right.sh" <<EOF
#!/usr/bin/env bash
sleep 12
printf '\$ curl http://localhost:$PORT/hello\n\n'
curl -s "http://localhost:$PORT/hello"
echo
sleep 9999
EOF

chmod +x "$PANE_DIR/left.sh" "$PANE_DIR/right.sh"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] CDKL_BIN=$CDKL_BIN"
  echo "[dry-run] SAMPLE_DIR=$SAMPLE_DIR"
  echo "[dry-run] tmux conf=$CONF"
  echo "[dry-run] port=$PORT"
  echo "[dry-run] pane scripts: $PANE_DIR/left.sh, $PANE_DIR/right.sh"
  echo "[dry-run] would run:"
  echo "  (pre-warm) cd \"$SAMPLE_DIR\" && pnpm install --silent && pnpm exec cdk synth >/dev/null"
  echo "  tmux -f \"$CONF\" new-session -d -s demo -x 220 -y 35 \"$PANE_DIR/left.sh\""
  echo "  tmux split-window -h -t demo:0 \"$PANE_DIR/right.sh\""
  echo "  tmux attach -t demo"
  exit 0
fi

# --- Pre-warm: install fixture deps + cache cdk.out so the recorded ---
# --- session starts fast. Output is discarded.                       ---
( cd "$SAMPLE_DIR" \
  && pnpm install --silent >/dev/null 2>&1 \
  && pnpm exec cdk synth >/dev/null 2>&1 )

# Kill any stale `demo` session left by an aborted prior run (e.g. a vhs
# SIGKILL that skipped the cleanup trap, or back-to-back re-records) so this
# run never fails with "duplicate session: demo".
tmux kill-session -t demo 2>/dev/null || true

tmux -f "$CONF" new-session -d -s demo -x 220 -y 35 "$PANE_DIR/left.sh"
tmux split-window -h -t demo:0 "$PANE_DIR/right.sh"
# Focus the LEFT pane so vhs's picker keystrokes (space/→/enter/y) drive the
# `cdkl start-api` multi-select, not the right (curl) pane.
tmux select-pane -t demo:0.0
tmux attach -t demo
