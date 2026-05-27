# cdk-local demo GIFs

Source files for the demo GIFs shown in the project README. Two flows are recorded today:

| File | Source tape | Source orchestrator | Linked from |
|---|---|---|---|
| `assets/cdkl-start-api.gif` | `cdkl-start-api.tape` | `run-start-api.sh` | top of README |
| `assets/cdkl-invoke.gif` | `cdkl-invoke.tape` | `run.sh` | inside `#### Lambda — invoke` section |

## What gets recorded

### `cdkl-start-api.gif` (top of README)

A tmux split-pane session:

- **Left pane** — `cdkl start-api CdklDemo/MyApi --no-pull --port 8080` boots a local HTTP server in front of the sample app's HTTP API v2 route.
- **Right pane** — `sleep 6` to let the server come up, then `curl http://localhost:8080/hello` and print the JSON response.

Total recorded time around 16 seconds. The `pnpm install` + `cdk synth` pre-warm steps run BEFORE tmux launches so the GIF only shows the `cdkl` + `curl` lines — `cdkl start-api` does its own internal synth at boot.

### `cdkl-invoke.gif` (inside `#### Lambda — invoke`)

A single terminal pane running:

1. `pnpm install` — install `aws-cdk-lib` / `aws-cdk` for the sample app
2. `pnpm cdk synth` — synthesize `cdk.out/`
3. `cdkl invoke CdklDemo/EchoHandler --event event.json` — run the Lambda locally in Docker via RIE and print the returned JSON

Roughly 3-5 seconds of recorded time. The final JSON includes `"message": "Hello from cdk-local!"` — the punchline.

## Reproducing

Prerequisites:

- [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`)
- `tmux`
- JetBrainsMono Nerd Font (`brew install --cask font-jetbrains-mono-nerd-font`)
- Docker (the Lambda Runtime Interface Emulator runs inside `cdkl invoke` / `cdkl start-api`)
- The cdk-local repo built locally — `vp run build` from the repo root so `dist/cli.js` exists. The PATH shim in each `run-*.sh` points `cdkl` at that build so the recorded command stays plain `cdkl`.

```bash
cd assets/demo-gif

# Record the start-api split-pane demo (top-of-README GIF)
vhs cdkl-start-api.tape   # generates ../cdkl-start-api.gif

# Record the invoke single-pane demo
vhs cdkl-invoke.tape      # generates ../cdkl-invoke.gif
```

Either orchestrator can be dry-run without `vhs` / `tmux` installed:

```bash
bash run-start-api.sh --dry-run    # plans the split-pane tmux invocation
bash run.sh --dry-run              # plans the single-pane tmux invocation
```

That prints the planned `tmux` invocations so the scaffold can be sanity-checked on a CI runner or a fresh laptop.

## Files

| File | Role |
|---|---|
| `cdkl-start-api.tape` | vhs script for the split-pane start-api demo (1800x720, 18pt JetBrains Mono Nerd Font) |
| `run-start-api.sh` | tmux split-pane orchestrator: pre-warms `pnpm install` + `cdk synth` outside the recorded session, then runs `cdkl start-api` (left) + `sleep 6 && curl` (right) |
| `cdkl-invoke.tape` | vhs script for the single-pane invoke demo (1400x720, 22pt JetBrainsMono Nerd Font) |
| `run.sh` | single-pane orchestrator for the invoke demo |
| `tmux-clean.conf` | strips the tmux status bar so the recording looks polished (shared) |
| `sample-app/` | minimal CDK app both demos drive |
| `sample-app/lib/cdkl-demo-stack.ts` | one `AWS::Lambda::Function` (Node.js 20) + one `AWS::ApiGatewayV2::Api` (HTTP API with GET `/hello`) |
| `sample-app/lambda/index.js` | dual-mode handler: returns API Gateway response shape when invoked via `start-api`, plain `{ message, receivedEvent }` for `cdkl invoke` |
| `sample-app/event.json` | payload `cdkl invoke --event` reads |

## Costs

No AWS resources are provisioned. The only runtime cost is local Docker pulling the `public.ecr.aws/lambda/nodejs:20` base image (cached after the first run).
