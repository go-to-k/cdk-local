import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '../../../src/cli/commands');
const read = (file: string): string => readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');

/**
 * Site-level binding test (per `feedback_site_level_binding_test.md`).
 *
 * `resolveHostGatewayExtraHosts()` (memoized in `docker-version.ts`) gives a
 * container `host.docker.internal` reachability so it can hit a server on the
 * host (an `AWS_ENDPOINT_URL_*` local endpoint / tunneled VPC resource) on
 * Linux native dockerd — where the alias is not auto-resolved. Three command
 * run sites must each resolve it AND thread the result into the docker run:
 * `cdkl invoke` (Lambda RIE container -> `runDetached`'s `extraHosts`),
 * `cdkl run-task` (-> `runOpts.hostGatewayExtraHosts`), and the ECS service
 * emulator behind `start-service` / `start-alb` (-> `taskOpts.hostGatewayExtraHosts`).
 *
 * The reachability only differs on Linux, so the integ suite (run on Docker
 * Desktop, which resolves the name natively regardless) cannot distinguish a
 * dropped wiring. This source-level binding pins each call site so a refactor
 * that silently drops the resolve / thread is caught.
 */
describe('host.docker.internal reachability wired at every container run site', () => {
  it('cdkl invoke resolves the mapping and passes it to runDetached as extraHosts', () => {
    const src = read('local-invoke.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts\(\)/);
    expect(src).toMatch(/extraHosts:\s*hostGatewayExtraHosts/);
  });

  it('cdkl run-task resolves the mapping and sets it on the runEcsTask options', () => {
    const src = read('local-run-task.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts\(\)/);
    expect(src).toMatch(/runOpts\.hostGatewayExtraHosts\s*=/);
    // ...and the option is threaded into the run, not resolved-then-dropped.
    expect(src).toMatch(/runEcsTask\(/);
  });

  it('the ECS service emulator (start-service / start-alb) resolves and sets it on taskOpts', () => {
    const src = read('ecs-service-emulator.ts');
    expect(src).toMatch(/resolveHostGatewayExtraHosts\(\)/);
    expect(src).toMatch(/taskOpts\.hostGatewayExtraHosts\s*=/);
  });
});
