import { describe, it, expect, vi } from 'vite-plus/test';

// go-to-k/cdk-local#761: an assembly-chosen identifier in cdk-local's own prose
// renders bare when plain and as ONE JSON string literal when it could forge a
// boundary. The expected strings below are computed by hand, never by calling
// the display helper.

vi.mock('../../../src/local/docker-runner.js', () => ({
  runDetached: vi.fn(),
  pickFreePort: vi.fn(),
  removeContainer: vi.fn(),
  streamLogs: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/local/rie-client.js', () => ({ waitForRieReady: vi.fn() }));

const { buildCloudMapIndex } = await import('../../../src/local/cloud-map-resolver.js');
const { resolveAlbFrontDoor } = await import('../../../src/local/elb-front-door-resolver.js');
const { resolveRuntimeFileExtension } = await import('../../../src/local/runtime-image.js');
const { createContainerPool } = await import('../../../src/local/container-pool.js');
const { pullEcrImage } = await import('../../../src/local/ecr-puller.js');

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
}

function cloudMapStack(stackName: string, logicalId: string) {
  return {
    stackName,
    template: {
      Resources: { [logicalId]: { Type: 'AWS::ServiceDiscovery::PublicDnsNamespace' } },
    },
  } as never;
}

describe('cloud-map-resolver renders the stack name and logical id (#761)', () => {
  it('prints plain values bare', () => {
    const msg = messageOf(() => buildCloudMapIndex(cloudMapStack('MyStack', 'Ns')));
    expect(msg).toContain('Stack MyStack: AWS::ServiceDiscovery::PublicDnsNamespace Ns is not');
  });

  it('prints a forging logical id and a control-char stack name as JSON literals', () => {
    const msg = messageOf(() => buildCloudMapIndex(cloudMapStack('S\u001b[2Kx', "a' b")));
    expect(msg).toContain(`Stack "S [2Kx": AWS::ServiceDiscovery::PublicDnsNamespace "a' b" is not`);
  });
});

describe('elb-front-door-resolver renders the unsupported condition field (#761)', () => {
  function warningsFor(field: string): string {
    const stack = {
      stackName: 'AlbStack',
      template: {
        Resources: {
          Lb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
          Tg: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
          },
          L: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: 'Lb' },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg' } }],
            },
          },
          Svc: {
            Type: 'AWS::ECS::Service',
            Properties: {
              LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg' } }],
            },
          },
          R: {
            Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
            Properties: {
              ListenerArn: { Ref: 'L' },
              Priority: 10,
              Conditions: [{ Field: field, Values: ['x'] }],
              Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg' } }],
            },
          },
        },
      },
    } as never;
    return resolveAlbFrontDoor(stack, 'Lb').warnings.join('\n');
  }

  it('prints a plain field bare', () => {
    expect(warningsFor('no-such-field')).toContain('uses unsupported condition field no-such-field.');
  });

  it('prints a forging field as a JSON literal', () => {
    expect(warningsFor("a' b")).toContain(`uses unsupported condition field "a' b".`);
  });
});

describe('runtime-image renders the runtime token (#761)', () => {
  it('prints a plain unknown runtime bare', () => {
    expect(messageOf(() => resolveRuntimeFileExtension('nodejs9.x'))).toContain(
      'Unknown runtime nodejs9.x.'
    );
  });

  it('prints a control-char runtime as a JSON literal', () => {
    expect(messageOf(() => resolveRuntimeFileExtension('nodejs9\u001b[2Kx'))).toContain(
      'Unknown runtime "nodejs9 [2Kx".'
    );
  });
});

describe('container-pool renders the unregistered Lambda logical id (#761)', () => {
  const pool = createContainerPool(new Map(), { perLambdaConcurrency: 1, streamLogs: false });

  it('prints a plain id bare', async () => {
    await expect(pool.acquire('Fn')).rejects.toThrow('no spec registered for Lambda Fn. This is');
  });

  it('prints a forging id as a JSON literal', async () => {
    await expect(pool.acquire("a' b")).rejects.toThrow(
      `no spec registered for Lambda "a' b". This is`
    );
  });
});

describe('ecr-puller renders a non-ECR image URI (#761)', () => {
  it('prints a plain URI bare and a forging one as a JSON literal', async () => {
    await expect(pullEcrImage('docker.io/lib/x:1', {} as never)).rejects.toThrow(
      'Image URI docker.io/lib/x:1 is not an ECR URI.'
    );
    await expect(pullEcrImage("a' b", {} as never)).rejects.toThrow(
      `Image URI "a' b" is not an ECR URI.`
    );
  });
});
