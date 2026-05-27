---
name: cleanup
description: Detect and delete leftover Docker containers / networks left by interrupted cdk-local integ runs.
argument-hint: "[--detect-only]"
---

# Leftover Docker Resource Cleanup

Detect and optionally delete Docker resources left behind when a `cdkl` run is interrupted (SIGKILL, crash, etc.) before its own cleanup hook fires.

## Safety

- ONLY targets Docker containers / networks whose names match the cdk-local prefix conventions (`cdkl-*`, `cdk-local-*`).
- NEVER touches non-matching containers — random unrelated containers on the host are out of scope.
- Default mode is detect-only (no deletion).
- Uses `AskUserQuestion` to confirm before any actual `docker rm -f` / `docker network rm`.

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

4. **Report findings**: Show a table of detected resources grouped by type. If everything is empty, confirm "no orphans" and stop.

5. **If deletion requested** (not `--detect-only`):
   - Use `AskUserQuestion` to show the full list and confirm deletion.
   - Delete in this order:
     1. Containers first (`docker rm -f <id>` — works even if running).
     2. Networks next (`docker network rm <id>` — must come after containers that use them are gone).
     3. Built images last (`docker rmi <id>` — only if image cleanup was requested AND the image is not referenced by any remaining container).
   - Report each deletion result.

## Important

- This skill is for cleaning up LOCAL DOCKER state from cdk-local runs only.
- cdk-local itself does NOT deploy AWS resources, so there is no AWS-side orphan scan here — use the upstream `cdk destroy` (or the host's deploy tool) for AWS resources created by a `--from-cfn-stack` deploy.
- The `cdkl-*` / `cdk-local-*` name prefix is the contract: anything not matching that prefix is presumed external and is never touched.
