import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl start-service --watch` integ test
 * (Phase 1 of issue #214 — single-replica rebuild-on-change).
 *
 * One `AWS::ECS::Service` with `DesiredCount=1` (single replica is the
 * Phase 1 constraint; multi-replica rolling reload is Phase 2). The
 * single container is a busybox image built from a local `webapp/`
 * asset; the asset's `server.sh` runs `httpd -p 8080 -h /www` after
 * writing a one-line `index.html` with the version marker. verify.sh
 * mutates `server.sh` to bump the marker (v1 -> v2) and asserts
 * `curl http://127.0.0.1:8080/` returns the new value after a single
 * hot reload — proving the watcher re-synths, rebuilds the asset
 * image, and replaces the single replica without a `^C` / re-launch.
 *
 * `covers: AWS::ECS::Service` (start-service --watch path).
 */
export class LocalStartServiceWatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-service-watch',
    });

    // Asset image built from the local `webapp/` directory. CDK computes
    // an asset hash from the directory contents during synth — editing
    // `webapp/server.sh` flips the hash, which is exactly the signal
    // cdk-local's `--watch` reload needs to pick up the new image.
    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '../webapp'));

    const taskDef = new ecs.TaskDefinition(this, 'WebTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    taskDef.addContainer('web', {
      image,
      memoryReservationMiB: 32,
      portMappings: [{ containerPort: 8080 }],
    });

    // Use L1 CfnService directly so the fixture stays tiny (no VPC /
    // launch-type / placement constraints). cdk-local doesn't talk to
    // AWS for any of this — the cluster name surfaces only to the
    // metadata sidecar.
    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: (taskDef.node.defaultChild as ecs.CfnTaskDefinition).ref,
      desiredCount: 1,
      launchType: 'EC2',
    });
  }
}
