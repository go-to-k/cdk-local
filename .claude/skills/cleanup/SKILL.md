---
name: cleanup
description: Detect and delete leftovers from interrupted cdk-local runs — Docker containers / networks, and orphaned vitest tinypool worker processes that failed to terminate (issue go-to-k/cdk-local#402).
argument-hint: "[--detect-only]"
---

# Leftover Resource Cleanup

Detect and optionally delete leftovers from an interrupted cdk-local run
(SIGKILL, crash, killed test run): Docker containers / networks / built images
from a `cdkl` serve or integ run, and orphaned tinypool fork workers. The
in-worker SIGTERM/SIGINT guard only fires when the parent SIGTERMs the worker,
so a worker orphaned by a dead parent can spin forever and must be swept from
outside.

## Safety

- **Docker**: ONLY containers / networks whose names match the cdk-local prefix
  conventions (`cdkl-*`, `cdk-local-*`). Anything not matching that prefix is
  presumed external and is NEVER touched.
- **Processes**: ONLY node processes running the tinypool fork-worker entry
  (`tinypool/dist/entry/process.js`) WHOSE cwd is under a cdk-local checkout.
  The default auto-kill set is narrowed further to **orphaned** workers (parent
  pid `1` — provably abandoned). A still-parented worker, even at high CPU,
  could be an active test run: LIST it, kill it only on explicit
  `AskUserQuestion` confirmation. A worker outside a cdk-local checkout, or a
  parented low-CPU one, is never touched.
- Default mode is detect-only. `AskUserQuestion` confirms before any
  `docker rm -f` / `docker network rm` / `kill`.

## Arguments

- `--detect-only`: list only, don't delete (the default).

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

3. **Scan ephemeral cdkl-built images** (optional — only if the user asked for image cleanup):

   ```bash
   docker images --filter reference='cdkl-built:*' --format '{{.ID}}\t{{.Repository}}:{{.Tag}}'
   ```

4. **Scan orphaned vitest worker processes**, then classify by ppid + CPU + cwd.

   ```bash
   # Candidate workers (pid, ppid, %cpu, elapsed, command).
   ps -axo pid=,ppid=,pcpu=,etime=,command= \
     | grep 'tinypool/dist/entry/process\.js' | grep -v grep
   ```

   For EACH candidate pid, resolve its cwd (macOS has no `/proc`, so `lsof`)
   and keep only those under a cdk-local checkout:

   ```bash
   cwd=$(lsof -a -p "<pid>" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
   case "$cwd" in */cdk-local|*/cdk-local/*) : ;; *) continue ;; esac
   ```

   Bucket the cdk-local workers:
   - **Orphaned** (`ppid == 1`): the parent `vp test` process is gone — the
     DEFAULT auto-kill set.
   - **Parented + high CPU** (`ppid != 1` AND `%cpu` sustained `>= 50`):
     possibly an active test run, possibly a runaway. LIST it, do NOT auto-kill.
   - Everything else (parented, low CPU): a live run — never touched.

5. **Report findings**: a table grouped by type (containers / networks / images
   / orphaned workers / suspect workers). If empty, confirm "no orphans" and stop.

6. **If deletion / kill requested** (not `--detect-only`):
   - `AskUserQuestion` with the full list. Call the **parented high-CPU**
     workers out as "possibly an active test run" so the user can opt out per-pid.
   - Docker, in this order:
     1. Containers (`docker rm -f <id>` — works even if running).
     2. Networks (`docker network rm <id>` — must come after the containers using them are gone).
     3. Built images (`docker rmi <id>` — only if requested AND not referenced by any remaining container).
   - Orphaned workers: `kill <pid>` (SIGTERM), then re-check; one that ignores
     SIGTERM gets `kill -9 <pid>`. Parented high-CPU workers are killed ONLY for
     the pids the user confirmed.
   - Report each result.

## AWS-side orphans

cdk-local itself deploys no AWS resources. For AWS resources a fixture's
`--from-cfn-stack` deploy created, run the sweep and require exit 0 — it derives
the lane-unique names, so it alone can tell an orphan from a peer's live stack:

```bash
bash tests/integration/_lib/aws-orphan-sweep.sh <fixture-name>; rc=$?
```

**Do NOT reach for `cdk destroy` here.** Run by hand from outside the fixture,
where `INTEG_STACK_SUFFIX` is unset, the app builds UN-suffixed names, your
suffixed argument matches nothing, and it **exits 0 SILENTLY with the stack
still deployed**. The sweep's remediation plan uses
`aws cloudformation delete-stack`, which needs neither app context nor the
suffix. A fixture's OWN cleanup trap using `cdk destroy` is correct — it runs
from the fixture directory with the suffix exported.
