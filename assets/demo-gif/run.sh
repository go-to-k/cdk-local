#!/usr/bin/env bash
# Single-pane recording: cdkl invoke against the local sample app.
#
# Pre-warm steps (pnpm install, cdk synth) run OUTSIDE the recorded
# tmux session so the GIF only shows the cdkl invoke line — cdkl
# invoke does its own internal synth via toolkit-lib, but priming the
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

# Use the freshly-built cdkl from the repo's dist/, not whatever may be
# installed globally. Shadow `cdkl` on PATH with a symlink to the local
# build so the visible command in the GIF stays plain `cdkl`.
CDKL_BIN="$(cd "$DEMO_DIR/../.." && pwd)/dist/cli.js"
SHADOW_BIN="$(mktemp -d)"
ln -sf "$CDKL_BIN" "$SHADOW_BIN/cdkl"
export PATH="$SHADOW_BIN:$PATH"

# Pane bootstrap script written into a temp dir so we avoid 2-layer
# shell quoting between this script -> tmux's inner shell.
PANE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$SHADOW_BIN" "$PANE_DIR"
  tmux kill-session -t demo 2>/dev/null || true
}
trap cleanup EXIT

cat > "$PANE_DIR/invoke.sh" <<EOF
#!/usr/bin/env bash
export PATH="$SHADOW_BIN:\$PATH"
export FORCE_COLOR=1
export COLORTERM=truecolor
cd "$SAMPLE_DIR"
printf '\$ cdkl invoke --event event.json\n\n'
cdkl invoke --event event.json
sleep 9999
EOF
chmod +x "$PANE_DIR/invoke.sh"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] CDKL_BIN=$CDKL_BIN"
  echo "[dry-run] SAMPLE_DIR=$SAMPLE_DIR"
  echo "[dry-run] tmux conf=$CONF"
  echo "[dry-run] pane script: $PANE_DIR/invoke.sh"
  echo "[dry-run] would run:"
  echo "  (pre-warm) cd \"$SAMPLE_DIR\" && pnpm install --silent && pnpm exec cdk synth >/dev/null"
  echo "  tmux -f \"$CONF\" new-session -d -s demo -x 180 -y 35 \"$PANE_DIR/invoke.sh\""
  echo "  tmux attach -t demo"
  exit 0
fi

# --- Pre-warm: install fixture deps + cache cdk.out so the recorded ---
# --- session starts fast. Output is discarded.                       ---
( cd "$SAMPLE_DIR" \
  && pnpm install --silent >/dev/null 2>&1 \
  && pnpm exec cdk synth >/dev/null 2>&1 )

tmux -f "$CONF" new-session -d -s demo -x 180 -y 35 "$PANE_DIR/invoke.sh"
tmux attach -t demo
