#!/usr/bin/env bash
# Single-pane recording: cdkl invoke against the local sample app.
# No AWS account, no Docker network plumbing — just `cdk synth` followed
# by `cdkl invoke`, ending in the JSON returned by the Lambda handler.
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
trap 'rm -rf "$SHADOW_BIN"' EXIT

# FORCE_COLOR=1 keeps chalk/picocolors output colored even though tmux's
# pseudo-TTY would otherwise be detected as non-color.
# COLORTERM=truecolor lets ANSI 24-bit colors render in the recording.
ENV='FORCE_COLOR=1 COLORTERM=truecolor'

# The recorded command sequence: install -> synth -> invoke.
# Each line is echoed first so the typed prompt is visible in the GIF
# before the command output starts.
DEMO_CMD="\
cd '$SAMPLE_DIR' && \
echo '\$ pnpm install' && pnpm install --silent && echo && \
echo '\$ pnpm cdk synth' && pnpm exec cdk synth >/dev/null && echo 'Synth succeeded.' && echo && \
echo '\$ cdkl invoke CdklDemo/EchoHandler --event event.json' && echo && \
$ENV cdkl invoke CdklDemo/EchoHandler --event event.json"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] CDKL_BIN=$CDKL_BIN"
  echo "[dry-run] SAMPLE_DIR=$SAMPLE_DIR"
  echo "[dry-run] tmux conf=$CONF"
  echo "[dry-run] would run:"
  echo "  tmux -f $CONF new-session -d -s demo -x 180 -y 40 \"bash -c \\\"\$DEMO_CMD; sleep 9999\\\"\""
  echo "  tmux select-pane -t demo:0.0 -T ' cdkl - cdkl invoke '"
  echo "  tmux attach -t demo"
  exit 0
fi

tmux -f "$CONF" new-session -d -s demo -x 180 -y 40 "bash -c \"$DEMO_CMD; sleep 9999\""
tmux select-pane -t demo:0.0 -T '#[fg=#a6e3a1,bold]  cdkl ─  cdkl invoke '
tmux attach -t demo
