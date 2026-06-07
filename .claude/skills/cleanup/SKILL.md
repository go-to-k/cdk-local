---
name: cleanup
description: Detect and delete leftovers from interrupted cdk-local runs — Docker containers / networks, AND orphaned vitest forks worker processes that failed to terminate (issue #402, e.g. a worker spinning at 100% CPU after its parent died).
argument-hint: "[--detect-only]"
---

# Leftover Resource Cleanup

Detect and optionally delete leftovers from an interrupted cdk-local run
(SIGKILL, crash, a killed test run) before its own cleanup could fire:

- **Docker** containers / networks / built images from a `cdkl` serve or integ run.
- **Orphaned vitest forks worker processes** — a tinypool fork worker that
  failed to terminate and was reparented when its parent (the `vp test`
  process) died, often spinning at 100% CPU. This is the externally-visible
  tail of issue #402's hang variant: the in-worker SIGTERM/SIGINT guard only
  fires when the parent SIGTERMs the worker, so a worker orphaned by a dead
  parent (no signal sent) can spin forever and must be swept from outside.

## Safety

- **Docker**: ONLY targets containers / networks whose names match the
  cdk-local prefix conventions (`cdkl-*`, `cdk-local-*`). NEVER touches
  non-matching containers.
- **Processes**: ONLY targets node processes running the tinypool fork-worker
  entry (`tinypool/dist/entry/process.js`) WHOSE working directory is under a
  cdk-local checkout. The DEFAULT auto-kill set is further narrowed to
  **orphaned** workers (parent pid `1` — the original parent is gone, so the
  worker is provably abandoned). A still-parented worker (even at high CPU)
  could be an active test run, so it is LISTED separately and only killed on
  explicit `AskUserQuestion` confirmation. A worker whose cwd is NOT under a
  cdk-local checkout (another repo's tests, an editor LSP's own tinypool pool
  elsewhere) is never touched.
- Default mode is detect-only (no deletion / no kill).
- Uses `AskUserQuestion` to confirm before any actual `docker rm -f` /
  `docker network rm` / `kill`.

## Arguments

- `--detect-only`: Only list leftover resources, don't delete (this is the default).

## Steps

1. **Scan containers**:

   ```bash
   docker ps -a --filter name=cdkl- --format '{{.ID}}\t{{.Names}}\t{{.Status}}'
   docker ps -a --filter name=cdk-local- --format '{{.ID}}\t{{.Names}}\t{{.Status}}'
   ```

2. **Scan networks**:

   ```bash
   docker network ls --filter name=cdkl-task- --format '{{.ID}}\t{{.Name}}\t{{.Driver}}'
   docker network ls --filter name=cdkl-svc- --format '{{.ID}}\t{{.Name}}\t{{.Driver}}'
   docker network ls --filter name=cdk-local-task- --format '{{.ID}}\t{{.Name}}\t{{.Driver}}'
   ```

3. **Scan ephemeral cdkl-built images** (optional — only if the user passed an argument hinting at image cleanup):

   ```bash
   docker images --filter reference='cdkl-built:*' --format '{{.ID}}\t{{.Repository}}:{{.Tag}}'
   ```

4. **Scan orphaned vitest forks worker processes** (issue #402): find node
   processes running the tinypool fork-worker entry, then classify each by
   parent pid + CPU + working directory.

   ```bash
   # Candidate workers (pid, ppid, %cpu, elapsed, command).
   ps -axo pid=,ppid=,pcpu=,etime=,command= \
     | grep 'tinypool/dist/entry/process\.js' | grep -v grep
   ```

   For EACH candidate pid, resolve its working directory (macOS has no
   `/proc`, so use `lsof`) and keep only those under a cdk-local checkout:

   ```bash
   cwd=$(lsof -a -p "<pid>" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
   case "$cwd" in */cdk-local|*/cdk-local/*) : ;; *) continue ;; esac
   ```

   Bucket the cdk-local workers:
   - **Orphaned** (`ppid == 1`): the parent `vp test` process is gone, so the
     worker is provably abandoned — the DEFAULT auto-kill set.
   - **Parented + high CPU** (`ppid != 1` AND `%cpu` sustained high, e.g.
     `>= 50`): possibly an active test run, possibly a runaway. LIST it but do
     NOT auto-kill; ask before touching.
   - Everything else (parented, low CPU): a live, healthy run — never touched.

5. **Report findings**: Show a table of detected resources grouped by type
   (containers / networks / images / orphaned workers / suspect workers). If
   everything is empty, confirm "no orphans" and stop.

6. **If deletion / kill requested** (not `--detect-only`):
   - Use `AskUserQuestion` to show the full list and confirm. For the
     **parented high-CPU** workers, call them out as "possibly an active test
     run" so the user can opt out per-pid.
   - Docker, in this order:
     1. Containers first (`docker rm -f <id>` — works even if running).
     2. Networks next (`docker network rm <id>` — must come after containers that use them are gone).
     3. Built images last (`docker rmi <id>` — only if image cleanup was requested AND the image is not referenced by any remaining container).
   - Orphaned worker processes: `kill <pid>` (SIGTERM) first, then re-check;
     a spinning orphan that ignores SIGTERM gets `kill -9 <pid>`. Parented
     high-CPU workers are killed ONLY for the pids the user confirmed.
   - Report each result.

## Important

- This skill cleans up LOCAL state from cdk-local runs only — Docker resources
  and orphaned vitest forks worker PROCESSES.
- cdk-local itself does NOT deploy AWS resources, so there is no AWS-side orphan scan here — use the upstream `cdk destroy` (or the host's deploy tool) for AWS resources created by a `--from-cfn-stack` deploy.
- The `cdkl-*` / `cdk-local-*` name prefix is the contract for Docker:
  anything not matching that prefix is presumed external and is never touched.
- For processes the contract is: tinypool fork-worker entry + cwd under a
  cdk-local checkout + (orphaned OR user-confirmed). A worker outside a
  cdk-local checkout, or a healthy parented low-CPU worker, is never touched.
