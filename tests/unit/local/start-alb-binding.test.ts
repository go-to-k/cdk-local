import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAlbTarget,
  parseLbPortOverrides,
  albStrategy,
  createLocalStartAlbCommand,
  addAlbSpecificOptions,
} from '../../../src/cli/commands/local-start-alb.js';
import { serviceStrategy } from '../../../src/cli/commands/local-start-service.js';
import {
  buildFrontDoor,
  addCommonEcsServiceOptions,
} from '../../../src/cli/commands/ecs-service-emulator.js';
import { resolveFrontDoorTlsMaterials } from '../../../src/local/front-door-tls.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const ALB = 'WebLB';
const TG = 'WebTargetGroup';
const SERVICE = 'WebService';

function albStack(): StackInfo {
  return {
    stackName: 'AlbStack',
    template: {
      Resources: {
        [ALB]: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Type: 'application' },
          Metadata: { 'aws:cdk:path': 'AlbStack/Web/LB/Resource' },
        },
        [TG]: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
        },
        WebListener: {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: ALB },
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
          },
        },
        [SERVICE]: {
          Type: 'AWS::ECS::Service',
          Properties: {
            LoadBalancers: [
              { ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: TG } },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

/**
 * An ALB whose single HTTP:80 listener default action forwards to a
 * `TargetType: lambda` target group backed by an inline ZIP Lambda (#123).
 * Inline code keeps the function resolvable without a cdk.out asset dir.
 */
function albLambdaStack(): StackInfo {
  return {
    stackName: 'AlbStack',
    template: {
      Resources: {
        [ALB]: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Type: 'application' },
        },
        [TG]: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: {
            TargetType: 'lambda',
            Targets: [{ Id: { 'Fn::GetAtt': ['EchoFn', 'Arn'] } }],
          },
        },
        WebListener: {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: ALB },
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
          },
        },
        EchoFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = async () => ({ statusCode: 200 });' },
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('resolveAlbTarget', () => {
  it('resolves an ALB by stack-qualified logical id', () => {
    const { stack, albLogicalId } = resolveAlbTarget('AlbStack:WebLB', [albStack()]);
    expect(stack.stackName).toBe('AlbStack');
    expect(albLogicalId).toBe(ALB);
  });

  it('resolves an ALB by CDK display path', () => {
    const { albLogicalId } = resolveAlbTarget('AlbStack/Web/LB', [albStack()]);
    expect(albLogicalId).toBe(ALB);
  });

  it('errors when the target is not an application load balancer', () => {
    expect(() => resolveAlbTarget('AlbStack:WebService', [albStack()])).toThrow(
      /did not match an application Load Balancer/
    );
  });

  it('errors when a display path resolves to more than one ALB (ambiguous)', () => {
    // Two ALBs share the `AlbStack/Shared` construct-path prefix, so the path
    // `AlbStack/Shared` resolves to both -> the user must disambiguate.
    const twoAlbStack = {
      stackName: 'AlbStack',
      template: {
        Resources: {
          AlbA: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
            Metadata: { 'aws:cdk:path': 'AlbStack/Shared/AlbA/Resource' },
          },
          AlbB: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
            Metadata: { 'aws:cdk:path': 'AlbStack/Shared/AlbB/Resource' },
          },
        },
      },
    } as unknown as StackInfo;
    expect(() => resolveAlbTarget('AlbStack/Shared', [twoAlbStack])).toThrow(
      /matches 2 load balancers/
    );
  });
});

/** Two ALBs; `wiring` decides whether they front the same service or two. */
function twoAlbStack(wiring: 'same-service' | 'two-services'): StackInfo {
  const resources: Record<string, unknown> = {
    Alb1: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
    Alb2: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
    Tg1: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
    },
    L1: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb1' },
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg1' } }],
      },
    },
    Svc1: {
      Type: 'AWS::ECS::Service',
      Properties: {
        LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg1' } }],
      },
    },
  };
  if (wiring === 'same-service') {
    // Alb2's listener (port 8080) ALSO forwards to Tg1 -> same Svc1.
    resources['L2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb2' },
        Port: 8080,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg1' } }],
      },
    };
  } else {
    resources['Tg2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
    };
    resources['L2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb2' },
        Port: 8080,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg2' } }],
      },
    };
    resources['Svc2'] = {
      Type: 'AWS::ECS::Service',
      Properties: {
        LoadBalancers: [{ ContainerName: 'api', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg2' } }],
      },
    };
  }
  return { stackName: 'Multi', template: { Resources: resources } } as unknown as StackInfo;
}

describe('albStrategy.resolveBoots multi-service', () => {
  it('boots one service but stands up both listeners when two ALBs front the SAME service', () => {
    // Alb1 listener (port 80) and Alb2 listener (port 8080) both forward to
    // Svc1 -> one boot, two listeners on distinct host ports (no collision).
    const { boots, frontDoor } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('same-service')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots).toEqual([{ target: 'Multi:Svc1' }]);
    expect(frontDoor!.listeners.map((l) => l.listenerPort).sort((a, b) => a - b)).toEqual([
      80, 8080,
    ]);
    for (const l of frontDoor!.listeners) {
      const action = l.defaultAction;
      expect(action?.kind).toBe('forward');
      if (action?.kind === 'forward') {
        const target = action.targets[0]!;
        expect(target.kind).toBe('ecs');
        if (target.kind === 'ecs') expect(target.serviceTarget).toBe('Multi:Svc1');
      }
    }
  });

  it('produces two boots when two ALBs front two different services', () => {
    const { boots } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('two-services')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots.map((b) => b.target).sort()).toEqual(['Multi:Svc1', 'Multi:Svc2']);
  });

  it('keeps only the first listener when two listeners claim the same host port', () => {
    // Both ALBs expose a listener on port 80 (no --lb-port remap), so they
    // would bind the same host port -> the second is skipped with a warning.
    const collisionStack = {
      stackName: 'Multi',
      template: {
        Resources: {
          Alb1: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
          Alb2: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
          Tg1: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
          },
          Tg2: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
          },
          L1: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: 'Alb1' },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg1' } }],
            },
          },
          L2: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: 'Alb2' },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg2' } }],
            },
          },
          Svc1: {
            Type: 'AWS::ECS::Service',
            Properties: {
              LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg1' } }],
            },
          },
          Svc2: {
            Type: 'AWS::ECS::Service',
            Properties: {
              LoadBalancers: [{ ContainerName: 'api', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg2' } }],
            },
          },
        },
      },
    } as unknown as StackInfo;

    const { boots, frontDoor, warnings } = albStrategy({} as never).resolveBoots(
      [collisionStack],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    // Only the first listener is fronted -> only its backing service is booted.
    expect(frontDoor!.listeners).toHaveLength(1);
    expect(boots).toEqual([{ target: 'Multi:Svc1' }]);
    expect(warnings.join('\n')).toMatch(/already.*claimed by listener port 80/);
  });
});

describe('albStrategy --lb-port no-match warning', () => {
  it('warns when a --lb-port override matches no resolved listener', () => {
    const { warnings } = albStrategy({ lbPort: ['9999=8080'] } as never).resolveBoots(
      [albStack()],
      ['AlbStack:WebLB']
    );
    expect(warnings.join('\n')).toMatch(/--lb-port override for listener port 9999 matched no/);
  });

  it('does not warn when the --lb-port override matches a resolved listener', () => {
    const { warnings } = albStrategy({ lbPort: ['80=8080'] } as never).resolveBoots(
      [albStack()],
      ['AlbStack:WebLB']
    );
    expect(warnings.join('\n')).not.toMatch(/--lb-port override/);
  });
});

describe('start-alb / start-service strategy binding', () => {
  it('start-alb resolves an ALB target into a service boot + a front-door plan', () => {
    const strategy = albStrategy({ lbPort: ['80=8080'] } as never);
    const { boots, frontDoor, warnings } = strategy.resolveBoots([albStack()], ['AlbStack:WebLB']);
    expect(warnings).toEqual([]);
    expect(boots).toEqual([{ target: 'AlbStack:WebService' }]);
    expect(frontDoor!.listeners).toEqual([
      {
        listenerPort: 80,
        hostPort: 8080, // remapped by --lb-port 80=8080
        protocol: 'HTTP',
        defaultAction: {
          kind: 'forward',
          targets: [
            {
              kind: 'ecs',
              serviceTarget: 'AlbStack:WebService',
              targetContainerName: 'web',
              targetContainerPort: 80,
              weight: 1,
            },
          ],
        },
        rules: [],
      },
    ]);
    // --lb-port is parsed by the ALB strategy (start-service has no such flag).
    expect(strategy.lbPortOverrides).toEqual({ 80: 8080 });
  });

  it('start-service produces pure-compute boots with NO front-door plan', () => {
    const strategy = serviceStrategy();
    const { boots, frontDoor } = strategy.resolveBoots([albStack()], ['AlbStack:WebService']);
    expect(boots).toEqual([{ target: 'AlbStack:WebService' }]);
    expect(frontDoor).toBeUndefined();
    expect(strategy.lbPortOverrides).toEqual({});
  });

  it('start-alb threads an authenticate-cognito guard from the template into the planned listener', () => {
    const COGNITO_ARN = 'arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_abcDEF';
    const stack = {
      stackName: 'AlbStack',
      template: {
        Resources: {
          WebLB: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
          },
          WebTargetGroup: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
          },
          WebListener: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: 'WebLB' },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [
                {
                  Type: 'authenticate-cognito',
                  AuthenticateCognitoConfig: {
                    UserPoolArn: COGNITO_ARN,
                    UserPoolClientId: 'client-abc',
                    UserPoolDomain: 'auth.example.com',
                  },
                },
                { Type: 'forward', TargetGroupArn: { Ref: 'WebTargetGroup' } },
              ],
            },
          },
          WebService: {
            Type: 'AWS::ECS::Service',
            Properties: {
              LoadBalancers: [
                { ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'WebTargetGroup' } },
              ],
            },
          },
        },
      },
    } as unknown as StackInfo;

    const { frontDoor, warnings } = albStrategy({} as never).resolveBoots([stack], ['AlbStack:WebLB']);
    expect(warnings).toEqual([]);
    expect(frontDoor!.listeners).toHaveLength(1);
    expect(frontDoor!.listeners[0]!.defaultAuthGuard).toEqual({
      kind: 'authenticate-cognito',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abcDEF',
      audience: 'client-abc',
      region: 'us-east-1',
      userPoolId: 'us-east-1_abcDEF',
      sessionCookieName: 'AWSELBAuthSessionCookie',
      label: 'authenticate-cognito (UserPool=us-east-1_abcDEF)',
    });
  });

  it('start-alb resolves a Lambda target group into a front-door Lambda target with NO ECS boot (#123)', () => {
    const strategy = albStrategy({} as never);
    const { boots, frontDoor, warnings } = strategy.resolveBoots(
      [albLambdaStack()],
      ['AlbStack:WebLB']
    );
    expect(warnings).toEqual([]);
    // A Lambda-only ALB boots no ECS services.
    expect(boots).toEqual([]);
    expect(frontDoor!.listeners).toHaveLength(1);
    const action = frontDoor!.listeners[0]!.defaultAction;
    expect(action?.kind).toBe('forward');
    if (action?.kind !== 'forward') throw new Error('expected a forward action');
    const target = action.targets[0]!;
    expect(target.kind).toBe('lambda');
    if (target.kind !== 'lambda') throw new Error('expected a lambda target');
    expect(target.lambda.logicalId).toBe('EchoFn');
    expect(target.targetGroupArn).toBe('AlbStack:WebTargetGroup');
    expect(target.multiValueHeaders).toBe(false);
    expect(target.weight).toBe(1);
  });
});

describe('buildFrontDoor', () => {
  const fdOptions = { containerHost: '127.0.0.1', pull: true } as never;

  it('binds one server per listener and groups pools by service target', async () => {
    const logger = { info: () => {}, warn: () => {} } as never;
    const { servers, frontDoorByService, lambdaRunners } = await buildFrontDoor(
      {
        listeners: [
          {
            listenerPort: 80,
            hostPort: 0, // ephemeral: avoid privileged-port binding in the unit test
            protocol: 'HTTP',
            defaultAction: {
              kind: 'forward',
              targets: [
                {
                  kind: 'ecs',
                  serviceTarget: 'S:Web',
                  targetContainerName: 'web',
                  targetContainerPort: 80,
                  weight: 1,
                },
              ],
            },
            rules: [
              {
                priority: 10,
                pathPatterns: ['/api/*'],
                hostPatterns: [],
                httpHeaderConditions: [],
                httpRequestMethods: [],
                queryStringConditions: [],
                sourceIpCidrs: [],
                action: {
                  kind: 'forward',
                  targets: [
                    {
                      kind: 'ecs',
                      serviceTarget: 'S:Api',
                      targetContainerName: 'api',
                      targetContainerPort: 8080,
                      weight: 1,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      fdOptions,
      logger
    );
    try {
      expect(servers).toHaveLength(1);
      expect(lambdaRunners).toEqual([]);
      // One pool per (service, container, port); grouped by service target.
      expect([...frontDoorByService.keys()].sort()).toEqual(['S:Api', 'S:Web']);
      expect(frontDoorByService.get('S:Web')).toEqual([
        expect.objectContaining({ targetContainerName: 'web', targetContainerPort: 80 }),
      ]);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  it('builds one pool per weighted forward target and groups them by service', async () => {
    const logger = { info: () => {}, warn: () => {} } as never;
    const { servers, frontDoorByService } = await buildFrontDoor(
      {
        listeners: [
          {
            listenerPort: 80,
            hostPort: 0,
            protocol: 'HTTP',
            defaultAction: {
              kind: 'forward',
              targets: [
                { serviceTarget: 'S:Blue', targetContainerName: 'app', targetContainerPort: 80, weight: 80 },
                { serviceTarget: 'S:Green', targetContainerName: 'app', targetContainerPort: 80, weight: 20 },
              ],
            },
            rules: [],
          },
        ],
      },
      '127.0.0.1',
      logger
    );
    try {
      // Each weighted target group gets its own pool, grouped by service target.
      expect([...frontDoorByService.keys()].sort()).toEqual(['S:Blue', 'S:Green']);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  describe('HTTPS listener binding (--tls-cert / --tls-key + auto self-signed)', () => {
    let tlsTmpDir: string;
    let certPath: string;
    let keyPath: string;

    beforeAll(async () => {
      // Pre-bake a real self-signed cert/key pair so the BYO path executes
      // inside `buildFrontDoor` -> `resolveFrontDoorTlsMaterials` without
      // invoking openssl a second time.
      tlsTmpDir = mkdtempSync(join(tmpdir(), 'cdkl-start-alb-binding-tls-'));
      const mats = await resolveFrontDoorTlsMaterials({
        certPath: undefined,
        keyPath: undefined,
        cacheDir: tlsTmpDir,
      });
      certPath = join(tlsTmpDir, 'byo-cert.pem');
      keyPath = join(tlsTmpDir, 'byo-key.pem');
      writeFileSync(certPath, mats.certPem);
      writeFileSync(keyPath, mats.keyPem);
    });

    afterAll(() => {
      rmSync(tlsTmpDir, { recursive: true, force: true });
    });

    it('threads HTTPS protocol into a server with scheme=https when --tls-cert / --tls-key are set', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      const { servers } = await buildFrontDoor(
        {
          listeners: [
            {
              listenerPort: 443,
              hostPort: 0,
              protocol: 'HTTPS',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
          ],
        },
        { containerHost: '127.0.0.1', pull: true, tlsCert: certPath, tlsKey: keyPath } as never,
        logger
      );
      try {
        expect(servers).toHaveLength(1);
        expect(servers[0]!.scheme).toBe('https');
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('shares one cert across multiple HTTPS listeners (pre-resolved once)', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      const { servers } = await buildFrontDoor(
        {
          listeners: [
            {
              listenerPort: 443,
              hostPort: 0,
              protocol: 'HTTPS',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
            {
              listenerPort: 8443,
              hostPort: 0,
              protocol: 'HTTPS',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
          ],
        },
        { containerHost: '127.0.0.1', pull: true, tlsCert: certPath, tlsKey: keyPath } as never,
        logger
      );
      try {
        expect(servers).toHaveLength(2);
        expect(servers.every((s) => s.scheme === 'https')).toBe(true);
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('mixes HTTP + HTTPS listeners on the same ALB', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      const { servers } = await buildFrontDoor(
        {
          listeners: [
            {
              listenerPort: 80,
              hostPort: 0,
              protocol: 'HTTP',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
            {
              listenerPort: 443,
              hostPort: 0,
              protocol: 'HTTPS',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
          ],
        },
        { containerHost: '127.0.0.1', pull: true, tlsCert: certPath, tlsKey: keyPath } as never,
        logger
      );
      try {
        const schemes = servers.map((s) => s.scheme).sort();
        expect(schemes).toEqual(['http', 'https']);
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('surfaces a TLS pairing failure cleanly (not wrapped in the --lb-port port-bind envelope)', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      // Set only --tls-cert (key missing) -> resolveFrontDoorTlsMaterials throws
      // its own pairing error before any server tries to bind. The buildFrontDoor
      // try/catch must NOT re-wrap this as a port-bind issue.
      await expect(
        buildFrontDoor(
          {
            listeners: [
              {
                listenerPort: 443,
                hostPort: 0,
                protocol: 'HTTPS',
                defaultAction: { kind: 'fixed-response', statusCode: 204 },
                rules: [],
              },
            ],
          },
          { containerHost: '127.0.0.1', pull: true, tlsCert: certPath } as never, // tlsKey omitted
          logger
        )
      ).rejects.toThrow(/--tls-cert is set but --tls-key is missing/);
    });

    it('serves a cloud-HTTPS listener over plain HTTP by default (no --tls / --tls-cert)', async () => {
      // #198: TLS termination is opt-in. With neither --tls nor --tls-cert /
      // --tls-key the local wire is HTTP — the deployed listener protocol
      // surfaces as X-Forwarded-Proto: https further down the stack (see
      // front-door-server.test.ts), but the bound server is a plain HTTP one
      // so users can curl it without certificate-warning friction.
      const warns: string[] = [];
      const logger = {
        info: () => {},
        warn: (m: string) => warns.push(m),
      } as never;
      const { servers } = await buildFrontDoor(
        {
          listeners: [
            {
              listenerPort: 443,
              hostPort: 0,
              protocol: 'HTTPS',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
          ],
        },
        { containerHost: '127.0.0.1', pull: true } as never, // no --tls anywhere
        logger
      );
      try {
        expect(servers).toHaveLength(1);
        expect(servers[0]!.scheme).toBe('http');
        // The degradation must be logged so it is never silent.
        expect(
          warns.some(
            (m) => m.includes('HTTPS in the cloud') && m.includes('serving HTTP locally')
          )
        ).toBe(true);
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('terminates TLS locally on --tls alone (auto self-signed cert, no --tls-cert / --tls-key)', async () => {
      // The opt-in flag without a BYO cert pair routes through
      // resolveFrontDoorTlsMaterials' self-signed path. The pre-baked cache
      // dir (XDG_CACHE_HOME) avoids invoking openssl a second time.
      const prevXdg = process.env['XDG_CACHE_HOME'];
      process.env['XDG_CACHE_HOME'] = join(tlsTmpDir, 'xdg');
      try {
        const logger = { info: () => {}, warn: () => {} } as never;
        const { servers } = await buildFrontDoor(
          {
            listeners: [
              {
                listenerPort: 443,
                hostPort: 0,
                protocol: 'HTTPS',
                defaultAction: { kind: 'fixed-response', statusCode: 204 },
                rules: [],
              },
            ],
          },
          { containerHost: '127.0.0.1', pull: true, tls: true } as never,
          logger
        );
        try {
          expect(servers).toHaveLength(1);
          expect(servers[0]!.scheme).toBe('https');
        } finally {
          await Promise.all(servers.map((s) => s.close()));
        }
      } finally {
        if (prevXdg === undefined) delete process.env['XDG_CACHE_HOME'];
        else process.env['XDG_CACHE_HOME'] = prevXdg;
      }
    });

    it('does not warn about HTTPS-degraded for an HTTP listener (no false positives)', async () => {
      // Companion guard rail: the degradation warning must fire only when the
      // cloud-side protocol is HTTPS. A pure HTTP listener is the dominant
      // path; spurious warnings here would train users to ignore the signal.
      const warns: string[] = [];
      const logger = {
        info: () => {},
        warn: (m: string) => warns.push(m),
      } as never;
      const { servers } = await buildFrontDoor(
        {
          listeners: [
            {
              listenerPort: 80,
              hostPort: 0,
              protocol: 'HTTP',
              defaultAction: { kind: 'fixed-response', statusCode: 204 },
              rules: [],
            },
          ],
        },
        { containerHost: '127.0.0.1', pull: true } as never,
        logger
      );
      try {
        expect(servers).toHaveLength(1);
        expect(servers[0]!.scheme).toBe('http');
        expect(warns.some((m) => m.includes('HTTPS in the cloud'))).toBe(false);
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });
  });

  it('stands up a fixed-response-default listener with no backing pool', async () => {
    const logger = { info: () => {}, warn: () => {} } as never;
    const { servers, frontDoorByService } = await buildFrontDoor(
      {
        listeners: [
          {
            listenerPort: 80,
            hostPort: 0,
            protocol: 'HTTP',
            defaultAction: { kind: 'fixed-response', statusCode: 404, messageBody: 'nope' },
            rules: [],
          },
        ],
      },
      '127.0.0.1',
      logger
    );
    try {
      expect(servers).toHaveLength(1);
      // A fixed-response action has no forward target -> no service pools.
      expect(frontDoorByService.size).toBe(0);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  describe('authenticate-* gate threading (verifyAuth / bearerToken options)', () => {
    /**
     * Build a 1-listener plan with a fixed-response default action wrapped
     * by an authGuard. The terminal action is fixed-response so the test
     * does not need a real Lambda / ECS pool — the auth gate either denies
     * before the action runs (401) or allows and the fixed-response 200
     * surfaces. Locks the CLI options -> buildAuthCheck threading per
     * `feedback_site_level_binding_test`.
     */
    const guard = {
      kind: 'authenticate-cognito' as const,
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc',
      audience: 'client-abc',
      region: 'us-east-1',
      userPoolId: 'us-east-1_abc',
      sessionCookieName: 'AWSELBAuthSessionCookie',
      label: 'authenticate-cognito (UserPool=us-east-1_abc)',
    };

    function authenticatedPlan(): Parameters<typeof buildFrontDoor>[0] {
      return {
        listeners: [
          {
            listenerPort: 80,
            hostPort: 0,
            protocol: 'HTTP',
            defaultAction: { kind: 'fixed-response', statusCode: 200, messageBody: 'allowed' },
            defaultAuthGuard: guard,
            rules: [],
          },
        ],
      };
    }

    async function fetchOnce(port: number): Promise<{ status: number; body: string }> {
      const { request } = await import('node:http');
      return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    it('threads --no-verify-auth (verifyAuth: false) through to buildAuthCheck so unauthenticated requests pass', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      const { servers } = await buildFrontDoor(
        authenticatedPlan(),
        { containerHost: '127.0.0.1', pull: true, verifyAuth: false } as never,
        logger
      );
      try {
        const result = await fetchOnce(servers[0]!.port);
        expect(result.status).toBe(200);
        expect(result.body).toBe('allowed');
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('threads --bearer-token through so an inbound request with no Authorization is allowed', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      // A guard whose audience matches the verifier's pass-through accept;
      // since the JWKS fetch fails in unit tests the verifier returns allow
      // for any presented bearer. The injection path is what we're locking.
      const { servers } = await buildFrontDoor(
        authenticatedPlan(),
        { containerHost: '127.0.0.1', pull: true, bearerToken: 'injected-jwt' } as never,
        logger
      );
      try {
        const result = await fetchOnce(servers[0]!.port);
        expect(result.status).toBe(200);
        expect(result.body).toBe('allowed');
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });

    it('denies an unauthenticated request when no flag is set (default verifyAuth)', async () => {
      const logger = { info: () => {}, warn: () => {} } as never;
      const { servers } = await buildFrontDoor(
        authenticatedPlan(),
        { containerHost: '127.0.0.1', pull: true } as never,
        logger
      );
      try {
        const result = await fetchOnce(servers[0]!.port);
        expect(result.status).toBe(401);
      } finally {
        await Promise.all(servers.map((s) => s.close()));
      }
    });
  });
});

describe('parseLbPortOverrides', () => {
  it('parses <listenerPort>=<hostPort> pairs', () => {
    expect(parseLbPortOverrides(['80=8080', '443=8443'])).toEqual({ 80: 8080, 443: 8443 });
    expect(parseLbPortOverrides(undefined)).toEqual({});
  });

  it('throws on a malformed value or out-of-range port', () => {
    expect(() => parseLbPortOverrides(['8080'])).toThrow(/Expected <listenerPort>=<hostPort>/);
    expect(() => parseLbPortOverrides(['80=0'])).toThrow(/host port must be 1-65535/);
  });
});

/**
 * Drift guards for the `addCommonEcsServiceOptions` + `addAlbSpecificOptions`
 * decomposition. The decomposition exists so cdkd (and any other host wrapping
 * `runEcsServiceEmulator` with the ALB strategy) auto-inherits ALB-only flags
 * without a duplicate `.addOption(...)` block. These tests fail the moment
 * someone adds an ALB-specific flag inline in `createLocalStartAlbCommand`
 * instead of inside `addAlbSpecificOptions` — which would silently break the
 * inheritance the helper is supposed to guarantee.
 */
describe('start-alb option surface contract (addCommonEcsServiceOptions + addAlbSpecificOptions)', () => {
  function longFlagsOf(cmd: Command): string[] {
    return cmd.options
      .map((o) => o.long)
      .filter((l): l is string => typeof l === 'string')
      .sort();
  }

  it('addAlbSpecificOptions registers exactly the known ALB-only flags', () => {
    // Lock the helper's contract: cdkd imports it expecting THIS set of long
    // flags. Adding or removing one without updating the list below is a
    // semver-relevant surface change.
    const flags = longFlagsOf(addAlbSpecificOptions(new Command()));
    expect(flags).toEqual([
      '--bearer-token',
      '--lb-port',
      '--no-verify-auth',
      '--tls',
      '--tls-cert',
      '--tls-key',
    ]);
  });

  it('createLocalStartAlbCommand surface equals common + alb-specific (no inline drift)', () => {
    // The full CLI surface MUST be the union of the two helpers — never a
    // proper superset. A proper superset would mean someone added an option
    // inline in `createLocalStartAlbCommand`, which a host CLI (cdkd) calling
    // the helpers directly would silently miss.
    const full = longFlagsOf(createLocalStartAlbCommand());
    const expected = Array.from(
      new Set([
        ...longFlagsOf(addCommonEcsServiceOptions(new Command())),
        ...longFlagsOf(addAlbSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});
