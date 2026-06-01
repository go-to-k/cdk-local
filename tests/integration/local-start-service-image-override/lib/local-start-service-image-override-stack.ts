import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';

/**
 * Fixture stack for `cdkl start-service --image-override` (issues
 * #238 / #240 / #244).
 *
 * Hand-rolls one `AWS::ECS::Service` whose container image is a
 * placeholder ECR URI — i.e. an image that DOES NOT EXIST in any
 * registry the test host can reach. Without `--image-override`, the
 * boot path would either fail to pull the image or surface the
 * pinned-image WARN and abort. With `--image-override AppService=
 * ./webapp/Dockerfile`, the override engine:
 *
 *   1. Detects the placeholder URI as "pinned to a deployed
 *      registry" (the same anchor `isLocalCdkAssetImage` uses).
 *   2. `docker build`s the supplied Dockerfile, emitting
 *      `Building override image for '<target>' from '<path>'`.
 *   3. Threads the resulting local tag into the runner so the
 *      booted replica uses the override image, not the placeholder.
 *
 * The container is a tiny Node Alpine HTTP server replying with a
 * known string (`OVERRIDE_OK`) so the test can assert the override
 * built + booted successfully — a request that returned `OVERRIDE_OK`
 * proves the override path ran (the placeholder URI never pulls).
 *
 * Bridge network mode keeps the local exec path simple. The
 * container port (8080) is published on an ephemeral host port; the
 * verify.sh remaps it via `--host-port`.
 *
 * `covers: AWS::ECS::Service` (start-service `--image-override`).
 */
// A clearly-fake ECR URI. The override engine's pinned-image
// detector matches the `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`
// shape regardless of whether the repo / account exists, so this
// gets classified as pinned-to-a-deployed-registry without ever
// being pulled.
const PLACEHOLDER_ECR_IMAGE =
  '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkl-integ-placeholder:v1';

export class LocalStartServiceImageOverrideStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-service-image-override-fixture',
    });

    const appTask = new ecs.CfnTaskDefinition(this, 'AppTask', {
      family: 'cdkl-start-service-image-override-app',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'app',
          image: PLACEHOLDER_ECR_IMAGE,
          essential: true,
          memoryReservation: 32,
          portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
        },
      ],
    });

    new ecs.CfnService(this, 'AppService', {
      cluster: cluster.ref,
      taskDefinition: appTask.ref,
      desiredCount: 1,
      launchType: 'EC2',
    });
  }
}
