# cdk-local demo GIFs

Source files for the demo GIFs shown in the project README. Three flows are recorded today:

| File | Source | Source orchestrator | Linked from |
|---|---|---|---|
| `assets/cdkl-start-api.gif` | `cdkl-start-api.tape` (vhs) | `run-start-api.sh` | top of README |
| `assets/cdkl-invoke.gif` | `cdkl-invoke.tape` (vhs) | `run.sh` | inside `#### Lambda — invoke` section |
| `assets/cdkl-studio.gif` | `record-studio.mjs` (Playwright) | `record-studio.mjs` (self-contained) | `### cdkl studio` section |

The two CLI GIFs are recorded with [`vhs`](https://github.com/charmbracelet/vhs)
(terminal screencast). The studio GIF is a **browser** screencast — `vhs` can't
record a web UI — so it uses a separate Playwright harness (`record-studio.mjs`).

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

### `cdkl-studio.gif` (inside `### cdkl studio`)

A **browser** screencast of the `cdkl studio` web console, driven end to end by
Playwright (headless Chromium). The captured flow:

1. Expand the **APIs** group in the targets pane and pick the HTTP API.
2. **Start** the serve from the workspace — the per-target request composer
   appears once the backing RIE container is up.
3. Compose a `POST /echo` request: set the method, type the path, add an
   `X-Demo: studio` header, and a JSON body.
4. **Send** — the response renders inline as a Request -> Response pair, and the
   request lands on the timeline.
5. Scroll the workspace to reveal the streamed container logs, then click the
   captured row on the timeline to open its read-only detail.

The harness injects a green cursor dot (Playwright's headless Chromium renders no
OS cursor) so clicks read on the recording. It boots the real `cdkl studio`
against `sample-app` as a child process, drives the UI, then converts the
captured `.webm` to `../cdkl-studio.gif` with ffmpeg (two-pass palette).

This is the GIF most coupled to the UI: the harness uses CSS selectors
(`.req-composer`, `.req-result .req-resp`, `.group-title`, ...) that move when
the studio UI is redesigned. Re-run it after any studio UI change and fix up the
selectors if the flow stalls.

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

### Recording the studio GIF

The studio GIF uses Playwright instead of `vhs`. Playwright is a maintainer-only
recorder dependency, NOT a committed `devDependency` (it would bloat every
contributor's install for a demo tool), so install it on demand first:

```bash
# from the repo root
vp run build                              # so dist/cli.js is current
pnpm add -D playwright                    # maintainer-only, do not commit
npx playwright install chromium           # one-time browser download

node assets/demo-gif/record-studio.mjs    # generates assets/cdkl-studio.gif
```

Docker must be running (Start boots a RIE container behind the API) and `ffmpeg`
must be on PATH (webm -> gif conversion). The harness boots `cdkl studio` on a
fixed port against `sample-app`, drives the UI, and SIGTERMs it when done.

After recording, verify the result by opening it in Chrome
(`open -a "Google Chrome" assets/cdkl-studio.gif`) — macOS Preview / Safari shows
a GIF as a filmstrip rather than animating it.

## Files

| File | Role |
|---|---|
| `cdkl-start-api.tape` | vhs script for the split-pane start-api demo (1800x720, 18pt JetBrains Mono Nerd Font) |
| `run-start-api.sh` | tmux split-pane orchestrator: pre-warms `pnpm install` + `cdk synth` outside the recorded session, then runs `cdkl start-api` (left) + `sleep 6 && curl` (right) |
| `cdkl-invoke.tape` | vhs script for the single-pane invoke demo (1400x720, 22pt JetBrainsMono Nerd Font) |
| `run.sh` | single-pane orchestrator for the invoke demo |
| `record-studio.mjs` | self-contained Playwright recorder for the studio web-UI GIF: boots `cdkl studio` against `sample-app`, drives the API request-composer flow in headless Chromium, and converts the capture to `../cdkl-studio.gif` via ffmpeg |
| `tmux-clean.conf` | strips the tmux status bar so the recording looks polished (shared) |
| `sample-app/` | minimal CDK app both demos drive |
| `sample-app/lib/cdkl-demo-stack.ts` | one `AWS::Lambda::Function` (Node.js 20) + one `AWS::ApiGatewayV2::Api` (HTTP API with GET `/hello`) |
| `sample-app/lambda/index.js` | dual-mode handler: returns API Gateway response shape when invoked via `start-api`, plain `{ message, receivedEvent }` for `cdkl invoke` |
| `sample-app/event.json` | payload `cdkl invoke --event` reads |

## Costs

No AWS resources are provisioned. The only runtime cost is local Docker pulling the `public.ecr.aws/lambda/nodejs:20` base image (cached after the first run).
