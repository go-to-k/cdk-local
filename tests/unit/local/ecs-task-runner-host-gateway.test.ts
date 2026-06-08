import { describe, it, expect } from 'vite-plus/test';
import { mergeHostGatewayAddHostFlags } from '../../../src/local/ecs-task-runner.js';

const GATEWAY = { host: 'host.docker.internal', ip: 'host-gateway' };

describe('mergeHostGatewayAddHostFlags (ECS run-task / start-service / start-alb)', () => {
  it('returns [] when neither Cloud Map peer flags nor a host-gateway entry are present', () => {
    expect(mergeHostGatewayAddHostFlags(undefined, undefined)).toEqual([]);
    expect(mergeHostGatewayAddHostFlags([], [])).toEqual([]);
  });

  it('passes Cloud Map peer flags through unchanged when there is no host-gateway entry', () => {
    expect(mergeHostGatewayAddHostFlags(['--add-host', 'svc.cdkl.local:10.0.0.5'], undefined)).toEqual([
      '--add-host',
      'svc.cdkl.local:10.0.0.5',
    ]);
    expect(mergeHostGatewayAddHostFlags(['--add-host', 'svc.cdkl.local:10.0.0.5'], [])).toEqual([
      '--add-host',
      'svc.cdkl.local:10.0.0.5',
    ]);
  });

  it('emits the host.docker.internal:host-gateway pair when only the gateway entry is present', () => {
    expect(mergeHostGatewayAddHostFlags(undefined, [GATEWAY])).toEqual([
      '--add-host',
      'host.docker.internal:host-gateway',
    ]);
  });

  it('merges peer flags AND the host-gateway pair (peers first; distinct names so order is irrelevant)', () => {
    expect(
      mergeHostGatewayAddHostFlags(['--add-host', 'svc.cdkl.local:10.0.0.5'], [GATEWAY])
    ).toEqual([
      '--add-host',
      'svc.cdkl.local:10.0.0.5',
      '--add-host',
      'host.docker.internal:host-gateway',
    ]);
  });
});
