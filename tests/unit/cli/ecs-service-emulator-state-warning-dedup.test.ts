import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * `cdkl start-service` / `cdkl start-alb` resolve every target's image TWICE
 * during boot: once in the pre-boot pin-classification peek
 * (`resolveAndBuildImageOverrides`, to decide which targets are pinned) and
 * once in the real service boot (`resolveServiceAndRunnerOpts`). Both go
 * through `buildEcsImageResolutionContext`, which WARNs when a same-stack ECR
 * image needs deployed state and none is bound — so WITHOUT a guard the user
 * saw the "references a same-stack AWS::ECR::Repository. Pass a state-source
 * flag ..." WARN twice for the same service (the duplicate the studio LOGS
 * panel surfaced for a spawned `start-alb` child).
 *
 * The peek now passes `{ suppressStateWarning: true }` so the message fires
 * exactly once (from the real boot path). This covers both the builder's
 * suppression behaviour and the peek's binding (source-grep, since booting the
 * full emulator end-to-end needs Docker + a real ECS template).
 */

const { stsSendMock } = vi.hoisted(() => ({ stsSendMock: vi.fn() }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { buildEcsImageResolutionContext } = await import(
  '../../../src/cli/commands/local-start-service.js'
);

function ecrImageStack(): StackInfo {
  // A TaskDef whose container image references a same-stack
  // AWS::ECR::Repository via `Fn::GetAtt` / `Ref` — triggers
  // `needsStateResources`, so with no stateProvider the builder reaches the
  // "needs deployed state" WARN branch.
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        Repo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: {
                  'Fn::Join': [
                    '',
                    [
                      { 'Fn::Select': [4, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                      '.dkr.ecr.',
                      { 'Fn::Select': [3, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                      '.',
                      { Ref: 'AWS::URLSuffix' },
                      '/',
                      { Ref: 'Repo' },
                      ':latest',
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

const ECR_WARN = 'references a same-stack AWS::ECR::Repository';

describe('buildEcsImageResolutionContext state-warning suppression', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stsSendMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function warnedAboutEcr(): boolean {
    return warnSpy.mock.calls.some((args) => args.some((a) => String(a).includes(ECR_WARN)));
  }

  it('WARNs about the same-stack ECR image when no state is bound (default)', async () => {
    await buildEcsImageResolutionContext('MyStack:TaskDef', [ecrImageStack()], {} as never, undefined);
    expect(warnedAboutEcr()).toBe(true);
  });

  it('stays silent when suppressStateWarning is set (the pre-boot peek path)', async () => {
    await buildEcsImageResolutionContext('MyStack:TaskDef', [ecrImageStack()], {} as never, undefined, {
      suppressStateWarning: true,
    });
    expect(warnedAboutEcr()).toBe(false);
  });
});

describe('resolveAndBuildImageOverrides peek binding (state-warning dedup)', () => {
  const SOURCE = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/cli/commands/ecs-service-emulator.ts'
    ),
    'utf-8'
  );

  it('threads suppressStateWarning into the peek call so the WARN is not duplicated', () => {
    // The peek (`resolveAndBuildImageOverrides`) classifies each target's image
    // and handles its own resolution errors as DEBUG; it must NOT also emit the
    // user-facing state WARN, which the real boot path emits once. Lock that the
    // peek's buildEcsImageResolutionContext call passes the suppress flag.
    const peekStart = SOURCE.indexOf('async function resolveAndBuildImageOverrides');
    expect(peekStart).toBeGreaterThan(-1);
    const peekBody = SOURCE.slice(peekStart, peekStart + 3000);
    expect(peekBody).toContain('buildEcsImageResolutionContext');
    expect(peekBody).toContain('suppressStateWarning: true');
  });
});
