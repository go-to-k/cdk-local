import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl start-service --watch` integ test
 * (Phase 2 of issue #214 — multi-replica rolling deploy).
 *
 * One `AWS::ECS::Service` with `DesiredCount=2` (the Phase 1
 * single-replica fixture stays in `tests/integration/local-start-service-watch/`
 * as a regression check; this one exercises the per-replica
 * rolling-deploy primitive that's the heart of Phase 2). Service
 * Connect is enabled so peer containers on the shared cdkl-svc network
 * resolve the service via the docker embedded DNS alias `srv` —
 * the verify.sh's curl-loop probe (a busybox sidecar on the same
 * network) uses `http://srv:8080/` so Docker round-robins between
 * the live replicas. During a roll, the embedded DNS rotates across
 * (old r0, old r1, shadow r0 at gen 1) for a brief window and then
 * shifts to (old r1, shadow r0 at gen 1) after the swap completes —
 * a continuous probe should observe zero connection refusals.
 *
 * `covers: AWS::ECS::Service` (start-service --watch path,
 * multi-replica rolling deploy via per-replica generation-suffixed
 * docker network names + Cloud Map ownerKey).
 */
export class LocalStartServiceWatchMultiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-service-watch-multi',
    });

    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '../webapp'));

    const taskDef = new ecs.TaskDefinition(this, 'WebTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    // PortMappings.Name is the Service Connect binding key — the
    // service's `serviceConnectConfiguration.services[].portName`
    // references this exact value to attach the producer port to a
    // discovery name.
    taskDef.addContainer('web', {
      image,
      memoryReservationMiB: 32,
      portMappings: [{ containerPort: 8080, name: 'web-port' }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: (taskDef.node.defaultChild as ecs.CfnTaskDefinition).ref,
      desiredCount: 2,
      launchType: 'EC2',
      // Service Connect (Cloud Map DNS-only overlay). cdk-local's
      // resolver reads this verbatim; the runner stamps `--network-alias
      // srv` and `--network-alias srv.cdkl.local` on every replica's
      // web container at docker-run time so peer containers on the
      // shared `cdkl-svc-<rand>` network resolve `srv` via Docker's
      // embedded DNS to one of the live replicas.
      serviceConnectConfiguration: {
        enabled: true,
        namespace: 'cdkl.local',
        services: [
          {
            portName: 'web-port',
            discoveryName: 'srv',
            clientAliases: [{ port: 8080, dnsName: 'srv' }],
          },
        ],
      },
    });
  }
}
