import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl start-alb --watch` integ test
 * (Phase 3 of issue #214 — ALB-fronted multi-replica rolling deploy
 * + front-door pool swap).
 *
 * Hand-rolls the synthesized shape of an ALB-fronted 2-replica ECS
 * service using L1 resources so the fixture stays VPC-free and
 * deterministic (cdk-local only reads the template; it never deploys
 * to AWS):
 *
 *   - `AWS::ECS::Service` with DesiredCount=2 and `LoadBalancers[]`
 *     pointing at the target group; container image is built from
 *     the local `webapp/` directory so verify.sh can flip the
 *     `VERSION` marker mid-run.
 *   - `AWS::ElasticLoadBalancingV2::TargetGroup` (HTTP:8080).
 *   - `AWS::ElasticLoadBalancingV2::Listener` (HTTP:80) whose default
 *     action forwards to that target group.
 *
 * The container is a busybox httpd serving `/www/index.html` whose
 * contents are the `VERSION` marker. verify.sh rewrites
 * `webapp/server.sh` mid-run to bump v1 -> v2, triggering a rolling
 * reload that:
 *   1. Re-stages the asset (new image hash).
 *   2. Per replica, boots a shadow at gen+1, waits TCP-ready, swaps
 *      the front-door pool entry, retires the old replica.
 *   3. A continuous host-side curl loop against the listener port
 *      (bound on a non-privileged host port via `--lb-port`) observes
 *      zero connection refusals across the roll AND a v1 -> v2
 *      transition AND only v2 after the roll completes.
 *
 * `covers: AWS::ECS::Service` (start-alb --watch path, multi-replica
 * rolling deploy with front-door front-door pool swap per replica).
 */
export class LocalStartAlbWatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-watch',
    });

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

    const targetGroup = new elbv2.CfnTargetGroup(this, 'WebTargetGroup', {
      port: 8080,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', {
      type: 'application',
    });

    new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: (taskDef.node.defaultChild as ecs.CfnTaskDefinition).ref,
      desiredCount: 2,
      launchType: 'EC2',
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 8080,
          targetGroupArn: targetGroup.ref,
        },
      ],
    });
  }
}
