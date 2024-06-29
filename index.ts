import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elb_targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as transfer from "aws-cdk-lib/aws-transfer";
import * as logs from "aws-cdk-lib/aws-logs";

export class SPTServerStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "DefaultVPC", {
      maxAzs: 2,
    });

    const logGroup = new logs.LogGroup(this, "SPTServerLogGroup", {
      logGroupName: `/ecs/SPT-Server`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ecsCluster = new ecs.Cluster(this, "DefaultECSCluster", {
      vpc,
      containerInsights: true,
      // this is required for spot instances (i think?)
      //  enableFargateCapacityProviders: true
    });

    // -- EFS
    const profilesFileSystem = new efs.FileSystem(
      this,
      "SPTProfileFileSystem",
      {
        vpc,
        encrypted: true,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
        performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
        throughputMode: efs.ThroughputMode.BURSTING,
        enableAutomaticBackups: true,
      }
    );

    const modsFileSystem = new efs.FileSystem(this, "SPTModsFileSystem", {
      vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      enableAutomaticBackups: false,
    });

    profilesFileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["elasticfilesystem:ClientMount"],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          Bool: {
            "elasticfilesystem:AccessedViaMountTarget": "true",
          },
        },
      })
    );

    modsFileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["elasticfilesystem:ClientMount"],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          Bool: {
            "elasticfilesystem:AccessedViaMountTarget": "true",
          },
        },
      })
    );

    // Transfer
    const sftpLoggingRole = new iam.Role(this, "CloudWatchLoggingRole", {
      assumedBy: new iam.ServicePrincipal("transfer.amazonaws.com"),
      description: "IAM role used by AWS Transfer for logging",
      inlinePolicies: {
        loggingRole: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/transfer/*`,
              ],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
      },
    });

    const sftpSecurityGroup = new ec2.SecurityGroup(
      this,
      "SPTSFTPSecurityGroup",
      {
        vpc,
        allowAllOutbound: false,
        securityGroupName: "SPTSFTPSecurityGroup",
        description: "Security group for SFTP server",
      }
    );

    sftpSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH inbound"
    );

    const sftpElasticIP = new ec2.CfnEIP(this, "SPTSFTPElasticIP", {
      domain: "vpc",
    });

    new cdk.CfnOutput(this, "SPTSFTPServerIP", { value: sftpElasticIP.ref });

    const sftpServer = new transfer.CfnServer(this, "SPTSFTPServer", {
      endpointDetails: {
        securityGroupIds: [sftpSecurityGroup.securityGroupId],
        vpcId: vpc.vpcId,
        subnetIds: [vpc.publicSubnets[0].subnetId],
        addressAllocationIds: [sftpElasticIP.attrAllocationId],
      },
      identityProviderType: "SERVICE_MANAGED",
      endpointType: "VPC",
      loggingRole: sftpLoggingRole.roleArn,
      protocols: ["SFTP"],
      domain: "EFS",
    });

    const sftpUserAccessRole = new iam.Role(this, "SPTSFTPAccessRole", {
      assumedBy: new iam.ServicePrincipal("transfer.amazonaws.com"),
      roleName: "SPTSFTPAccessRole",
      inlinePolicies: {
        sftpRole: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                // TODO: make this specific. i'm missing at least 1 permision below to allow uploading.
                "elasticfilesystem:*",
                // "elasticfilesystem:ClientMount",
                // "elasticfilesystem:ClientWrite",
                // "elasticfilesystem:DescribeMountTargets",
              ],
              resources: [
                `arn:aws:elasticfilesystem:${this.region}:${this.account}:file-system/${profilesFileSystem.fileSystemId}`,
                `arn:aws:elasticfilesystem:${this.region}:${this.account}:file-system/${modsFileSystem.fileSystemId}`,
              ],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
      },
    });

    const sftpPublicKey = app.node.tryGetContext("sftpPublicKey") as string;

    new transfer.CfnUser(this, "SPTSFTPProfilesUser", {
      serverId: sftpServer.attrServerId,
      homeDirectory: `/${profilesFileSystem.fileSystemId}`,
      role: sftpUserAccessRole.roleArn,
      userName: "spt-profiles-user",
      posixProfile: {
        gid: 0,
        uid: 0,
      },
      sshPublicKeys: [sftpPublicKey],
    });

    new transfer.CfnUser(this, "SPTSFTPModsUser", {
      serverId: sftpServer.attrServerId,
      homeDirectory: `/${modsFileSystem.fileSystemId}`,
      role: sftpUserAccessRole.roleArn,
      userName: "spt-mods-user",
      posixProfile: {
        gid: 0,
        uid: 0,
      },
      sshPublicKeys: [sftpPublicKey],
    });

    // ECR
    const image = new ecr_assets.DockerImageAsset(this, "SPTImage", {
      directory: process.cwd(),
    });

    // ECS
    const taskDef = new ecs.FargateTaskDefinition(this, "SPTTaskDefinition", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      volumes: [
        {
          name: "profiles",
          efsVolumeConfiguration: {
            fileSystemId: profilesFileSystem.fileSystemId,
          },
        },
        {
          name: "mods",
          efsVolumeConfiguration: {
            fileSystemId: modsFileSystem.fileSystemId,
          },
        },
      ],
    });

    const containerDef = new ecs.ContainerDefinition(
      this,
      "SPTContainerDefinition",
      {
        taskDefinition: taskDef,
        logging: new ecs.AwsLogDriver({
          logGroup,
          streamPrefix: "spt",
        }),
        image: ecs.ContainerImage.fromEcrRepository(
          image.repository,
          image.imageTag
        ),
      }
    );

    containerDef.addMountPoints({
      sourceVolume: "profiles",
      containerPath: "/server/user/profiles",
      readOnly: false,
    });

    containerDef.addMountPoints({
      sourceVolume: "mods",
      containerPath: "/server/_mods",
      readOnly: true,
    });

    containerDef.addPortMappings({
      containerPort: 6969,
      protocol: ecs.Protocol.TCP,
    });

    const albFargateService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        "SPTLoadBalancedFargateService",
        {
          cluster: ecsCluster,
          taskDefinition: taskDef,
          desiredCount: 1,
          enableExecuteCommand: true,
          assignPublicIp: false,
          publicLoadBalancer: false,
        }
      );

    albFargateService.targetGroup.configureHealthCheck({
      path: "/",
      port: "6969",
      healthyHttpCodes: "200,304",
      enabled: true,
      healthyThresholdCount: 2,
      interval: cdk.Duration.seconds(90),
      timeout: cdk.Duration.seconds(60),
    });

    const albListener = albFargateService.loadBalancer.addListener(
      "SPTHTTPListener1",
      {
        protocol: elb.ApplicationProtocol.HTTP,
        port: 6969,
        defaultTargetGroups: [albFargateService.targetGroup],
      }
    );

    albFargateService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "30"
    );

    // allow access to EFS from Fargate service
    profilesFileSystem.grantRootAccess(
      albFargateService.taskDefinition.taskRole.grantPrincipal
    );

    modsFileSystem.grantRootAccess(
      albFargateService.taskDefinition.taskRole.grantPrincipal
    );

    profilesFileSystem.connections.allowDefaultPortFrom(
      albFargateService.service.connections
    );

    modsFileSystem.connections.allowDefaultPortFrom(
      albFargateService.service.connections
    );

    // setup a network load balancer with a static public IP
    const networkLoadBalancer = new elb.NetworkLoadBalancer(
      this,
      "SPTNetworkLoadBalancer",
      {
        vpc,
        internetFacing: true,
        crossZoneEnabled: true,
      }
    );

    const networkLoadBalancerTargetGroup = networkLoadBalancer
      .addListener("ALBListener", { port: 6969 })
      .addTargets("ALBTargets", {
        targets: [
          new elb_targets.AlbTarget(albFargateService.loadBalancer, 6969),
        ],
        port: 6969,
      });

    networkLoadBalancerTargetGroup.configureHealthCheck({
      path: "/",
      port: "6969",
      healthyHttpCodes: "200,304",
      enabled: true,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      interval: cdk.Duration.seconds(90),
      timeout: cdk.Duration.seconds(60),
    });

    // ensure our ALB listener is created before the target group
    networkLoadBalancerTargetGroup.node.addDependency(albListener);

    const serverElasticIP = new ec2.CfnEIP(this, "SPTServerElasticIP", {
      domain: "vpc",
    });

    // set our subnet mappings to our elastic IPs
    const nlb = networkLoadBalancer.node.defaultChild as elb.CfnLoadBalancer;

    nlb.addDeletionOverride("Properties.Subnets");

    nlb.subnetMappings = [
      {
        allocationId: serverElasticIP.attrAllocationId,
        subnetId: vpc.publicSubnets[0].subnetId,
      },
    ];

    new cdk.CfnOutput(this, "SPTServerIP", {
      value: serverElasticIP.ref,
    });
  }
}

const app = new cdk.App();

new SPTServerStack(app, "SPTServerStack");
