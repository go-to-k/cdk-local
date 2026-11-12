// Loopback-forwarding sidecar for workload containers.
//
// A local AWS endpoint on the host (`https://127.0.0.1:<port>`) is not
// reachable from a container: `127.0.0.1` inside the container is the
// container. Rewriting the URL to a host name or a bridge address breaks two
// things at once — the endpoint's TLS certificate names only loopback, and an
// AWS SDK given a host NAME switches S3 to virtual-hosted addressing.
//
// Instead, a tiny TCP forwarder runs in a second container that SHARES the
// workload's network namespace (`--network container:<id>`). It listens on
// `127.0.0.1:<port>` (and `[::1]:<port>`) inside that namespace and pipes each
// connection to the endpoint as reachable from the Docker network, so the
// workload keeps the unchanged `https://127.0.0.1:<port>` URL: certificate
// verification and S3 path-style addressing both hold. TLS is end to end; the
// forwarder only moves bytes.
//
// It also shares the workload's PID namespace (`--pid container:<id>`), so the
// kernel kills it when the workload's init exits, and `--rm` removes it — no
// separate cleanup path is needed for any of the commands that start
// workloads.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { describeExitWithoutArgv } from '../utils/docker-argv-redaction.js';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { getLogger } from '../utils/logger.js';
import { pullImage } from './docker-runner.js';
import { getEmbedConfig } from './embed-config.js';

const execFileAsync = promisify(execFile);

/**
 * The forwarder's image: the official Node.js image from the ECR Public
 * mirror of the Docker library, pinned by its multi-arch index digest so the
 * script always runs on the same bits. Node is already the runtime every
 * cdk-local install has on the host, and the forwarder is a dozen lines of
 * `node:net`; no other tool is needed.
 */
export const LOOPBACK_FORWARDER_IMAGE =
  'public.ecr.aws/docker/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a';

/** Path of the CA bundle inside the forwarder, used only by the health probe. */
const FORWARDER_CA_PATH = '/cdkl-forwarder/ca.pem';

/** Prefix of every status line the forwarder prints. */
const STATUS_PREFIX = 'CDKL-FWD';

/**
 * The forwarder script (run with `node -e`). argv: `<ports csv> <tcp|health>
 * [<ca path>]`.
 *
 * Upstream: `host.docker.internal` when it resolves (Docker Desktop resolves
 * it on every network; on Linux the workload's `/etc/hosts` carries it when
 * the workload was started with the host-gateway mapping), else the default
 * gateway of the shared namespace, read from `/proc/net/route` (the Docker
 * network's gateway, which is the host on native Linux).
 *
 * It prints exactly one result line: `CDKL-FWD READY <upstream>` or
 * `CDKL-FWD FAIL <port> <reason> <upstream>`. The `health` probe sends
 * `GET /__admin/health` THROUGH its own loopback listener, verifying the
 * certificate against `127.0.0.1` with the mounted CA, so a READY proves the
 * exact path the workload will use.
 */
export const LOOPBACK_FORWARDER_SCRIPT = `
const net=require('net'),dns=require('dns'),fs=require('fs'),https=require('https');
const ports=process.argv[1].split(',').map(Number),mode=process.argv[2],ca=process.argv[3];
const out=(s)=>process.stdout.write('${STATUS_PREFIX} '+s+'\\n');
function gateway(){try{for(const l of fs.readFileSync('/proc/net/route','utf8').split('\\n').slice(1)){const f=l.trim().split(/\\s+/);if(f[1]==='00000000'&&f[2]&&f[2]!=='00000000'){return [3,2,1,0].map(i=>parseInt(f[2].substr(i*2,2),16)).join('.');}}}catch(e){}return undefined;}
function listen(port,host,up){return new Promise((res)=>{const s=net.createServer((c)=>{const u=net.connect(port,up);c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy());});s.once('error',(e)=>res(e.code||'ERROR'));s.listen(port,host,()=>res(undefined));});}
function tcpProbe(port,up){return new Promise((res)=>{const c=net.connect(port,up);c.setTimeout(5000,()=>{c.destroy();res('ETIMEDOUT');});c.once('connect',()=>{c.destroy();res(undefined);});c.once('error',(e)=>res(e.code||'ERROR'));});}
function healthProbe(port){return new Promise((res)=>{const r=https.get({host:'127.0.0.1',port,path:'/__admin/health',ca:fs.readFileSync(ca),timeout:5000},(m)=>{m.resume();res(m.statusCode===200?undefined:'HTTP_'+m.statusCode);});r.on('timeout',()=>{r.destroy();res('ETIMEDOUT');});r.on('error',(e)=>res(e.code||'ERROR'));});}
dns.lookup('host.docker.internal',{family:4},async(err,addr)=>{
const up=err?gateway():addr;
if(!up){out('FAIL '+ports[0]+' NO_UPSTREAM none');return;}
for(const p of ports){const e=await listen(p,'127.0.0.1',up);if(e){out('FAIL '+p+' LISTEN_'+e+' '+up);return;}await listen(p,'::1',up);}
for(const p of ports){const e=await tcpProbe(p,up);if(e){out('FAIL '+p+' '+e+' '+up);return;}}
if(mode==='health'&&ca){const e=await healthProbe(ports[0]);if(e){out('FAIL '+ports[0]+' '+e+' '+up);return;}}
out('READY '+up);
});
`;

/** What {@link startLoopbackForwarder} found once the forwarder settled. */
export interface LoopbackForwarderResult {
  /** The forwarder container's name. */
  name: string;
  /** True when every port listened and the probe passed. */
  ok: boolean;
  /** Port the failure concerns (undefined when `ok`). */
  failedPort?: number;
  /** Short machine-readable reason (`ECONNREFUSED`, `HTTP_503`, ...). */
  reason?: string;
  /** The upstream host the forwarder dials (`host.docker.internal` / an IP). */
  upstream?: string;
}

export interface StartLoopbackForwarderOptions {
  /** ID or name of the RUNNING workload container whose namespaces it joins. */
  workloadContainer: string;
  /** Loopback ports to forward (each to the same port upstream). */
  ports: readonly number[];
  /**
   * `health` probes `GET /__admin/health` over verified TLS through the
   * forwarder (needs {@link caHostPath}); `tcp` only checks the upstream
   * accepts a connection.
   */
  probe: 'tcp' | 'health';
  /** Host path of a CA bundle the health probe trusts. */
  caHostPath?: string;
  /** How long to wait for the result line. Default 20 s. */
  timeoutMs?: number;
}

/** Parse one forwarder status line. Exported for unit tests. */
export function parseForwarderStatus(
  logs: string
): Omit<LoopbackForwarderResult, 'name'> | undefined {
  for (const raw of logs.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${STATUS_PREFIX} `)) continue;
    const parts = line.slice(STATUS_PREFIX.length + 1).split(' ');
    if (parts[0] === 'READY') {
      return { ok: true, ...(parts[1] ? { upstream: parts[1] } : {}) };
    }
    if (parts[0] === 'FAIL') {
      const port = Number(parts[1]);
      return {
        ok: false,
        ...(Number.isInteger(port) ? { failedPort: port } : {}),
        ...(parts[2] ? { reason: parts[2] } : {}),
        ...(parts[3] && parts[3] !== 'none' ? { upstream: parts[3] } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Build the `docker run` argv for a forwarder joined to `workloadContainer`.
 * Exported for unit tests and for a host that runs its own docker client.
 * The argv carries no secret: ports, a probe mode and a CA path.
 */
export function buildLoopbackForwarderDockerArgs(
  opts: Pick<
    StartLoopbackForwarderOptions,
    'workloadContainer' | 'ports' | 'probe' | 'caHostPath'
  > & {
    name: string;
  }
): string[] {
  const ns = `container:${opts.workloadContainer}`;
  const args = ['run', '-d', '--rm', '--name', opts.name, '--network', ns, '--pid', ns];
  if (opts.caHostPath) args.push('-v', `${opts.caHostPath}:${FORWARDER_CA_PATH}:ro`);
  args.push(
    '--entrypoint',
    'node',
    LOOPBACK_FORWARDER_IMAGE,
    '-e',
    LOOPBACK_FORWARDER_SCRIPT,
    opts.ports.join(','),
    opts.probe === 'health' && opts.caHostPath ? 'health' : 'tcp',
    ...(opts.caHostPath ? [FORWARDER_CA_PATH] : [])
  );
  return args;
}

let imageReady: Promise<void> | undefined;

/** Pull the forwarder image once per process when it is not present yet. */
async function ensureForwarderImage(): Promise<void> {
  imageReady ??= (async () => {
    try {
      await execFileAsync(getDockerCmd(), ['image', 'inspect', LOOPBACK_FORWARDER_IMAGE]);
    } catch {
      await pullImage(LOOPBACK_FORWARDER_IMAGE, false);
    }
  })().catch((err: unknown) => {
    imageReady = undefined;
    throw err;
  });
  return imageReady;
}

/** Test hook: forget the memoized image check. */
export function resetLoopbackForwarderForTest(): void {
  imageReady = undefined;
}

/**
 * Start a forwarder in `workloadContainer`'s network + PID namespaces and wait
 * until it reports READY or FAIL. Resolves with the result either way (the
 * caller decides whether a FAIL is fatal); rejects only when docker itself
 * fails or the forwarder never reports.
 *
 * Host-side use case: a host CLI that starts its own workload containers
 * calls this right after `docker run` and before the workload's first AWS
 * request, so the workload reaches a loopback endpoint on the host unchanged.
 */
export async function startLoopbackForwarder(
  opts: StartLoopbackForwarderOptions
): Promise<LoopbackForwarderResult> {
  const logger = getLogger().child('forwarder');
  await ensureForwarderImage();
  const name = `${getEmbedConfig().resourceNamePrefix}-awsfwd-${process.pid}-${randomBytes(4).toString('hex')}`;
  const args = buildLoopbackForwarderDockerArgs({ ...opts, name });
  logger.debug(`Starting loopback forwarder ${name} for ports ${opts.ports.join(',')}`);
  try {
    await execFileAsync(getDockerCmd(), args);
  } catch (error) {
    const err = error as { stderr?: string };
    throw new Error(
      `Could not start the loopback forwarder container: ${displayToolOutput(err.stderr?.trim() || describeExitWithoutArgv(error))}`
    );
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (;;) {
    let logs = '';
    try {
      const r = await execFileAsync(getDockerCmd(), ['logs', name]);
      logs = `${r.stdout}\n${r.stderr}`;
    } catch (error) {
      // The forwarder is gone (`--rm` after an exit): its namespaces' owner
      // stopped, or node crashed before printing.
      const err = error as { stderr?: string };
      throw new Error(
        `The loopback forwarder container exited before reporting: ${displayToolOutput(err.stderr?.trim() || describeExitWithoutArgv(error))}`
      );
    }
    const status = parseForwarderStatus(logs);
    if (status) {
      logger.debug(
        status.ok
          ? `Loopback forwarder ${name} ready (upstream ${status.upstream ?? '?'})`
          : `Loopback forwarder ${name} failed: port ${status.failedPort} ${status.reason}`
      );
      return { name, ...status };
    }
    if (Date.now() > deadline) {
      await execFileAsync(getDockerCmd(), ['rm', '-f', name]).catch(() => undefined);
      throw new Error('The loopback forwarder container did not report readiness in time.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The actionable message for a forwarder FAIL: the endpoint the host can
 * reach is not reachable from the Docker network.
 */
export function describeForwarderFailure(
  result: LoopbackForwarderResult,
  endpointLabel: string
): string {
  const port = result.failedPort ?? 0;
  const via = result.upstream ? ` via ${result.upstream}:${port}` : '';
  const reason = result.reason ?? 'unknown';
  if (reason.startsWith('LISTEN_')) {
    return (
      `${endpointLabel}: the workload container already uses port ${port} on its loopback, so ` +
      `cdk-local cannot forward 127.0.0.1:${port} to the host. Run the endpoint on another port.`
    );
  }
  if (
    reason.startsWith('HTTP_') ||
    reason.includes('CERT') ||
    reason === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return (
      `${endpointLabel}: containers reach port ${port}${via}, but its health check failed (${reason}). ` +
      `Check that the endpoint on port ${port} is the one whose CA cdk-local mounted (a restart issues a new certificate).`
    );
  }
  return (
    `${endpointLabel}: containers cannot reach port ${port} on the host${via} (${reason}). ` +
    `cdk-local forwards 127.0.0.1:${port} inside each workload container to the host, so the endpoint ` +
    `must accept connections from the Docker network: on Docker Desktop publish it on the host's ` +
    `127.0.0.1 (\`-p 127.0.0.1:${port}:${port}\`); on Linux bind it to an address containers can reach ` +
    `(\`aws-emulator -b 0.0.0.0\`, or publish its container port on the Docker bridge gateway as well).`
  );
}
