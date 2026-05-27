# cdkl-invoke demo GIF

Source files for `assets/cdkl-invoke.gif` — the `cdkl invoke` demo shown in the project README.

## What gets recorded

A single terminal pane running the no-AWS-account headline flow end-to-end:

1. `pnpm install` — install `aws-cdk-lib` / `aws-cdk` for the sample app
2. `pnpm cdk synth` — synthesize `cdk.out/`
3. `cdkl invoke CdklDemo/EchoHandler --event event.json` — run the Lambda locally in Docker via the Lambda Runtime Interface Emulator and print the returned JSON

The full sequence completes in roughly 3-5 seconds of recorded time. The final JSON visible in the GIF includes `"message": "Hello from cdk-local!"` — the punchline.

## Why this angle

The default chosen here is **standalone `cdkl invoke`** rather than `start-api` + `curl` or `--from-cfn-stack`. Rationale:

- No AWS account / IAM credentials / deployed stack needed to reproduce.
- Single pane, no `tmux` split, no second process spawning `curl`.
- Demonstrates the headline value (CDK app -> running locally in Docker -> JSON back) in the fewest seconds.

`start-api` + `--from-cfn-stack` are the obvious follow-ups; ship them as separate GIFs in later PRs once this first one is stable.

## Reproducing

Prerequisites:

- [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`)
- `tmux`
- JetBrainsMono Nerd Font (`brew install --cask font-jetbrains-mono-nerd-font`)
- Docker (for the actual Lambda Runtime Interface Emulator run inside `cdkl invoke`)
- The cdk-local repo built locally — `vp run build` from the repo root so `dist/cli.js` exists. The PATH shim in `run.sh` points `cdkl` at that build so the recorded command stays plain `cdkl`.

```bash
cd assets/demo-gif
vhs cdkl-invoke.tape   # generates ../cdkl-invoke.gif
```

To dry-run the orchestration without `vhs` or `tmux` installed:

```bash
bash run.sh --dry-run
```

That prints the planned `tmux` invocation so the scaffold can be sanity-checked on a CI runner or a fresh laptop.

## Files

- `cdkl-invoke.tape` — vhs script (theme, font, layout, timing)
- `run.sh` — orchestrator. Sets up a PATH shim so `cdkl` resolves to `<repo>/dist/cli.js`, then drives `pnpm install` / `cdk synth` / `cdkl invoke` inside a single tmux pane
- `tmux-clean.conf` — strips the tmux status bar so the recording looks polished
- `sample-app/` — minimal CDK app the demo invokes
  - `bin/app.ts` + `lib/cdkl-demo-stack.ts` — single `AWS::Lambda::Function` (Node.js 20, asset-backed)
  - `lambda/index.js` — handler that returns `{ message, receivedEvent }`
  - `event.json` — the payload passed via `--event`

## Costs

No AWS resources are provisioned. The only runtime cost is local Docker pulling the `public.ecr.aws/lambda/nodejs:20` base image (cached after the first run).
