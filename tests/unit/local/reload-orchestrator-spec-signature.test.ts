import { describe, expect, it } from 'vite-plus/test';
import type { ContainerSpec } from '../../../src/local/container-pool.js';
import { specSignature } from '../../../src/local/reload-orchestrator.js';

/**
 * #867: a reload where the Lambda RIE became obtainable changes only the
 * spec's `rieMount` (and with it entryPoint / command); the signature must
 * differ so the pool entry restarts under the mounted RIE.
 */
describe('specSignature IMAGE branch', () => {
  const base = {
    kind: 'image',
    lambda: { logicalId: 'Fn' },
    image: 'img:1',
    platform: 'linux/amd64',
    command: ['/app'],
    env: {},
    containerHost: '127.0.0.1',
  } as unknown as ContainerSpec;
  const mount = {
    hostPath: '/cache/aws-lambda-rie',
    containerPath: '/var/rapid/aws-lambda-rie',
    readOnly: true as const,
  };

  it('differs when only rieMount differs', () => {
    expect(specSignature({ ...base, rieMount: mount } as ContainerSpec)).not.toBe(
      specSignature(base)
    );
  });

  it('is stable for equal specs', () => {
    expect(specSignature({ ...base, rieMount: { ...mount } } as ContainerSpec)).toBe(
      specSignature({ ...base, rieMount: mount } as ContainerSpec)
    );
  });
});
