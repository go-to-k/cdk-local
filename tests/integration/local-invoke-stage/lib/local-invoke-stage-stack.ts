import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture (issue #560): a
 * function with no `architecture` defaults to `X86_64`, so on an arm64 host
 * the container runs under emulation, where the Go RIE faults intermittently.
 * The fence is `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

export interface MarkerStackProps extends cdk.StackProps {
  /** What this stack's handler returns, so verify.sh can tell the stacks apart. */
  marker: string;
  /**
   * Also declare a CONTAINER Lambda. Its docker-image asset is found through
   * the stack's asset manifest, which CDK names after the ARTIFACT id
   * (`CdklLocalInvokeStageInnerApi<hash>.assets.json`), not the physical name
   * — the read a Stage stack used to miss (#746).
   */
  withImage?: boolean;
  /**
   * Prefix for the construct ids, so a stack can carry logical ids NO other
   * stack shares — which start-api needs to serve it beside another stack.
   */
  idPrefix?: string;
}

/**
 * One handler behind one HTTP API route. Every instance declares the SAME
 * construct ids, so every stack carries the SAME logical ids — exactly what a
 * `cdk.Stage` deployed twice produces — and the asset is staged ONCE into the
 * APP's outdir, which a Stage stack reaches as `../asset.<hash>`.
 */
export class MarkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarkerStackProps) {
    super(scope, id, props);

    const p = props.idPrefix ?? '';
    const fn = new lambda.Function(this, `${p}Handler`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(here, '..', 'lambda')),
      environment: { MARKER: props.marker },
    });

    if (props.withImage) {
      new lambda.DockerImageFunction(this, 'ImageHandler', {
        architecture: HOST_ARCHITECTURE,
        code: lambda.DockerImageCode.fromImageAsset(path.join(here, '..', 'docker')),
        environment: { MARKER: `${props.marker}-image` },
      });
    }

    const api = new apigwv2.HttpApi(this, `${p}HttpApi`);
    api.addRoutes({
      path: '/marker',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(`${p}Integration`, fn),
    });
  }
}

/** A Stage holding two stacks whose paths share a prefix (`Api` / `ApiV2`). */
export class InnerStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);
    new MarkerStack(this, 'Api', { marker: 'api', withImage: true });
    new MarkerStack(this, 'ApiV2', { marker: 'apiv2' });
  }
}

/** An outer Stage nesting `InnerStage`: the stacks display as `Outer/Inner/Api`. */
export class OuterStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);
    new InnerStage(this, 'Inner');
  }
}
