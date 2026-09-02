# cdk-local Troubleshooting

Common errors and fixes. Skim the headings, find your symptom, follow the recipe.

If your problem isn't here, open an issue with the full command + output:
<https://github.com/go-to-k/cdk-local/issues>.

## Docker

### `Cannot connect to the Docker daemon`

cdk-local needs a running Docker daemon to start Lambda RIE containers and ECS task containers.

```bash
docker info
```

- **Exits non-zero with "connection refused"** — Docker Desktop is not running (macOS / Windows) or `dockerd` is not started (Linux). Launch Docker Desktop or `sudo systemctl start docker`.
- **Exits non-zero with "permission denied"** — your user is not in the `docker` group (Linux). `sudo usermod -aG docker $USER` and re-login.

### `docker pull` is slow or fails

The first run pulls `public.ecr.aws/lambda/<runtime>:<version>` (~200-400 MB depending on runtime). Subsequent runs reuse the cached image.

- **Slow pull** — pre-pull explicitly before the integ run:
  `docker pull public.ecr.aws/lambda/nodejs:20`.
- **Pull fails with `manifest unknown`** — your CDK code's `lambda.Runtime.X` references an image tag AWS no longer publishes (rare; usually retired runtimes). Upgrade the CDK runtime version.
- **Behind a corporate proxy** — set `HTTPS_PROXY` / `HTTP_PROXY` in the Docker Desktop "Resources -> Proxies" pane, then restart Docker.

### Orphan containers / networks from a previous run

```bash
docker ps --filter name=cdkl- -q | wc -l         # should be 0
docker network ls --filter name=cdkl-task- -q | wc -l   # should be 0
docker network ls --filter name=cdkl-svc- -q  | wc -l   # should be 0
```

Any non-zero count = a previous `cdkl` run was interrupted and left state behind. Either:

- Re-run the same command — cdk-local will reap the orphan name collision and continue. For `cdkl start-service` specifically, the next run automatically reclaims any leaked `cdkl-svc-*` shared network that has no live owner before it re-creates its own, so the fixed-subnet "Pool overlaps" failure no longer requires a manual `docker network rm`.
- Or sweep manually:
  ```bash
  docker ps --filter name=cdkl- -q | xargs -r docker rm -f
  docker network ls --filter name=cdkl-task- -q | xargs -r docker network rm
  docker network ls --filter name=cdkl-svc-  -q | xargs -r docker network rm
  ```

## Synth / CDK app discovery

### `Cannot find 'cdk.json'`

cdk-local reads `cdk.json` from the current directory by default. Either:

- `cd` to the directory that contains `cdk.json` and re-run, or
- Pass `--app <path-to-cdk.json>` explicitly.

### `cdk synth` fails when cdk-local invokes it

cdk-local re-synths your app on every invoke / start-api / run-task / start-service call. If the synth itself fails (TypeScript error, CDK runtime mismatch, etc.) the cdk-local invocation fails with the same error. Run `npx cdk synth` standalone first to confirm your app builds cleanly.

### `target not found`

The target argument (`MyStack/MyFunction`) is a CDK construct display path. It must match exactly what `cdk synth` emits. Two common traps:

- **Case-sensitive** — `MyStack/myFunction` and `MyStack/MyFunction` are different.
- **Nested stacks** — for a function in a nested stack, the path is `MyStack/MyNestedStack/MyFunction`, not `MyStack/MyFunction`.

List the visible targets:

```bash
cdkl invoke --help                  # shows the construct-path format
npx cdk synth --quiet | grep AWS::  # raw template; logical IDs are the alternative key
```

The stack-qualified logical ID form (`MyStack:MyFunctionLogicalId`) is also accepted, but display path is preferred.

## Runtime errors

### Lambda returns 502 / Runtime image fails to start

- **`Runtime exited with error: exit status 1`** — your handler code threw on cold start. Add `console.log` inside the handler to confirm reach, then look at the container's stderr in the cdk-local output above the response.
- **`No exports found in handler file`** — the `handler:` in your CDK code does not match an exported function in your handler module. Cross-check `lambda.Function({ handler: 'index.handler' })` against `exports.handler = ...` in `index.js`.
- **Layers not found** — Lambda Layers are extracted into the container at startup. If the layer was added via `.fromCfnStack()` style without a corresponding asset, the layer is not local-available. Use `lambda.LayerVersion.fromLayerVersionArn(...)` carefully — cdk-local needs the layer's code to be locally addressable.

### API Gateway: 403 / 404 from a route that exists

- **403 from an authorizer** — for REST v1 Cognito User Pool authorizers, cdk-local validates the JWT against the configured user pool. The token must be a real JWT issued for that pool; SAM-local-style "anything works" tokens are NOT accepted. See the `cognito-jwt-verify` flow notes in the README.
- **403 from a Lambda authorizer** — your authorizer Lambda returned `Deny` or did not return the expected `Allow` shape. Add `console.log(event)` inside the authorizer + re-run.
- **404 for a route you wrote** — the route was registered after the API Gateway resource and is not in the synth output yet. Run `npx cdk synth` and confirm the route appears in the template.

### ECS run-task / start-service: container exits immediately

- **`container exited with code 137`** — out of memory. Either bump `memoryLimitMiB` in the task definition or close other Docker workloads.
- **`could not bind to port`** — host port collision. cdk-local maps the container's exposed port to a random host port by default; if you pinned a port via `cdkl start-service --port <N>`, that port is already used.
- **`network <name> already exists`** — orphan network from a previous run. See the "Orphan containers / networks" section above.

## Binding to AWS

### `--from-cfn-stack <StackName>` injects nothing

The flag reads CloudFormation Outputs and resolves resource ARNs into env vars on the local container. If env injection seems missing:

- Confirm the stack name matches a deployed stack (`aws cloudformation describe-stacks --stack-name <name>`).
- Confirm your IAM credentials have `cloudformation:ListStackResources`, `cloudformation:DescribeStacks`, and `cloudformation:ListExports`.
- Confirm the stack has the Outputs / resources your CDK code expects (the local synth's expectations must match the deployed state).

### An STS warn says the message was withheld

A warn line ending in `N-character message withheld, logged at debug level under --verbose` means the STS call (`GetCallerIdentity` for `${AWS::AccountId}`, `AssumeRole` for `--assume-role`) failed **before the request reached AWS** — the local credential chain could not produce credentials. Re-run with `--verbose` (or `CDKL_LOG_LEVEL=debug`) to see the full message; the usual causes are an expired SSO session (`aws sso login`), a `--profile` that does not exist, no credentials configured at all, or no region resolved (`--region`, `AWS_REGION`, or `env.region` on the stack).

The class name in front of the count is the discriminator. When the failure carries a system-error code the line names it too — `Error ENOTFOUND; ...` is an unreachable STS endpoint, `Error ETIMEDOUT; ...` a blocked one, `CredentialsProviderError; ...` a chain that found nothing.

The message is withheld from the default-level line rather than printed there because it is the AWS SDK's text, not cdk-local's: the SDK's `credential_process` provider copies the failed command's own command line into the error it raises, and a `credential_process` command line is an ordinary place to keep a passphrase. Since `cdkl studio` mirrors these lines into a log ring it serves over HTTP, a default-level line is the wrong place to relay a string cdk-local does not control. The character count is kept because it is what tells you whether your `credential_process` ran at all.

When STS itself answers — `ExpiredTokenException`, `AccessDenied` — the message **is** printed in full at warn level, because that message is the diagnosis and it never went near your credential command. Such a message is flattened onto one line and capped at 512 characters.

**One caveat if you use `cdkl studio`.** The debug line goes to the same stdout studio mirrors into the log panel it serves over HTTP, so running a studio-spawned child with `--verbose` (or `CDKL_LOG_LEVEL=debug` in studio's environment) puts the withheld text into that panel. Prefer `--verbose` on a direct `cdkl invoke` / `cdkl start-api` run when the message might carry anything you would not put on a shared screen.

### AWS calls fail behind a corporate proxy

`self-signed certificate in certificate chain` (or `ETIMEDOUT` / `ECONNREFUSED` against `*.amazonaws.com`) on a machine whose only egress is a forward proxy means the AWS call went direct instead of through the proxy. cdk-local honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (lowercase spellings win) with `NO_PROXY` exemptions for every AWS-bound request it makes — the SDK calls and the non-SDK reads alike (a `fromLayerVersionArn` layer's ZIP download from its presigned URL, and the JWKS / OIDC discovery documents a JWT authorizer verifies against). Set them in the shell that runs `cdkl`. Five things to check:

- **A scheme-less value means TLS *to the proxy*** — `HTTPS_PROXY=proxy.internal:3128` looks like a plain host:port, but the scheme of the *request* is prepended, not `http:`, so it resolves to `https://proxy.internal:3128` and the connection to the proxy itself is TLS. A plain HTTP forward proxy cannot answer a TLS handshake, and the failure looks exactly like the one this section opens with. (Both spellings tunnel with `CONNECT` either way — what differs is whether that tunnel is wrapped in TLS to the proxy.) Write `HTTPS_PROXY=http://proxy.internal:3128` unless your proxy really does terminate TLS.
- **`NO_PROXY` entries are exact-match** unless they start with `.` or `*` — `NO_PROXY=example.com` does not exempt `api.example.com`. The `.` / `*` forms are a suffix match on that suffix ALONE, so `NO_PROXY=*.example.com` exempts `api.example.com` but NOT the apex `example.com`, which does not end in `.example.com`; list both when you mean the whole domain.
- **Only `http://` and `https://` proxies are supported** — a `socks5://` / `socks4://` value (usually in `ALL_PROXY`) cannot be spoken by cdk-local, so that request connects DIRECT and a one-time `Unsupported proxy scheme "socks5"` warning says so. If your only egress is a SOCKS proxy, front it with an HTTP proxy and point these variables at that.
- **A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`** pointing at its CA bundle — routing fixes the path, not the certificate chain.
- **Traffic cdk-local sends *as* the emulated service is deliberately not routed** — a REST API `HTTP` / `HTTP_PROXY` integration forwards to your backend directly, as the deployed API Gateway would, and so does cdk-local's own traffic to the containers on this host. If your backend is only reachable through the proxy, point the integration at a reachable URL instead.

A related failure worth naming, because it is silent: a JWT authorizer whose issuer is on a **private, non-loopback** address (an internal IdP) is proxied like any other host, and a proxy that cannot reach it makes the JWKS read fail — which does not deny requests, it degrades the verifier to accept every token with a warn (see "JWKS / OIDC discovery unreachable" in the CLI reference). Add the issuer's host to `NO_PROXY`. Loopback issuers need no entry: an issuer WRITTEN as `localhost`, `127.x.x.x`, `::1` or the wildcard is never proxied. That is a check on the spelling, not on where a name resolves — a hosts-file alias pointing at `127.0.0.1` still needs a `NO_PROXY` entry.

The Docker daemon's own pulls are separate egress — see the "Behind a corporate proxy" note under Docker above. Full semantics: the "Corporate proxy" section in the README.

### `--env-vars <file>` not applying overrides

- **Wrong key format** — the file is a JSON object keyed by Lambda **logical ID** (the synthesized CloudFormation ID like `MyFn1234ABCD`). CDK display path keys are tracked as a future enhancement in [issue #27](https://github.com/go-to-k/cdk-local/issues/27).
- **Mixed `Parameters` and function-specific keys** — function-specific keys override `Parameters` for that function. If both look set but only `Parameters` applies, the function-specific entry's logical ID probably doesn't match.

## Performance

### First invoke is very slow

The Lambda RIE base image pull is one-time. After the first run on a given Docker daemon, subsequent invokes start in 1-3 seconds (cold) / sub-second (warm). If you see consistent multi-second cold starts on a warmed daemon:

- Check Docker Desktop's CPU / memory allocation (Settings -> Resources). Lambda RIE containers default to a low cgroup limit; bump CPU to 4 cores + memory to 4 GB for smoother iteration.
- Confirm your handler is not re-resolving large dependencies on every call (top-level `require` / `import` is the convention).

### `start-service` / `run-task` ECS scale isn't realistic

cdk-local runs ECS tasks as plain Docker containers. There is no autoscaling, no placement strategy, no health-check-based replacement. If you need production-shape ECS behavior, deploy to a real cluster.

## When to file an issue

Open an issue at <https://github.com/go-to-k/cdk-local/issues> if:

- The error message is not in this doc and `--help` / `cdkl <subcmd> --help` doesn't explain it.
- A flag's documented behavior doesn't match what you observe.
- You hit a Docker / cdk-local interaction that the daemon's own troubleshooting docs don't cover.

Include the full command, full output (or a reproducible minimal CDK app), `node --version`, `docker version`, and your platform (macOS / Linux distro + version).
