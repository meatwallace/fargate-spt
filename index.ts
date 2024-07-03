import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as transfer from "aws-cdk-lib/aws-transfer";
import * as logs from "aws-cdk-lib/aws-logs";

export class SPTServerStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "SPT-VPC", {
      cidr: "10.0.0.0/24",
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "SPT-Public-Subnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
      maxAzs: 1,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    const logGroup = new logs.LogGroup(this, "SPT-Server-Log-Group", {
      logGroupName: `/ecs/SPT-Server-Log-Group`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ecsCluster = new ecs.Cluster(this, "SPT-ECS-Cluster", {
      vpc,
      containerInsights: true,
    });

    // -- EFS
    const profilesFileSystem = new efs.FileSystem(
      this,
      "SPT-Profile-File-System",
      {
        vpc,
        encrypted: true,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
        performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
        throughputMode: efs.ThroughputMode.BURSTING,
        enableAutomaticBackups: true,
      }
    );

    const modsFileSystem = new efs.FileSystem(this, "SPT-Mods-File-System", {
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

    // ECR
    const image = new ecr_assets.DockerImageAsset(this, "SPT-Image", {
      directory: process.cwd(),
    });

    // ECS
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "SPT-Task-Definition",
      {
        cpu: 1024,
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
      }
    );

    const containerDefinition = new ecs.ContainerDefinition(
      this,
      "SPT-Container-Definition",
      {
        taskDefinition: taskDefinition,
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

    containerDefinition.addMountPoints({
      sourceVolume: "profiles",
      containerPath: "/server/user/profiles",
      readOnly: false,
    });

    containerDefinition.addMountPoints({
      sourceVolume: "mods",
      containerPath: "/server/_mods",
      readOnly: true,
    });

    containerDefinition.addPortMappings({
      containerPort: 6969,
      protocol: ecs.Protocol.TCP,
    });

    const fargateService = new ecs.FargateService(this, "SPT-Fargate-Service", {
      cluster: ecsCluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      minHealthyPercent: 0,
      enableExecuteCommand: true,
    });

    // expose the correct port
    fargateService.connections.allowFromAnyIpv4(ec2.Port.tcp(6969));

    // allow access to EFS from Fargate service
    profilesFileSystem.grantRootAccess(
      fargateService.taskDefinition.taskRole.grantPrincipal
    );

    modsFileSystem.grantRootAccess(
      fargateService.taskDefinition.taskRole.grantPrincipal
    );

    profilesFileSystem.connections.allowDefaultPortFrom(
      fargateService.connections
    );

    modsFileSystem.connections.allowDefaultPortFrom(fargateService.connections);

    // Transfer
    if (process.env.SFTP_ENABLED === "true") {
      const sftpLoggingRole = new iam.Role(this, "SPT-SFTP-Logging-Role", {
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
        "SPT-SFTP-Security-Group",
        {
          vpc,
          allowAllOutbound: false,
          securityGroupName: "SPT-SFTP-Security-Group",
          description: "Security group for SFTP server",
        }
      );

      sftpSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(22),
        "Allow SSH inbound"
      );

      const sftpElasticIP = new ec2.CfnEIP(this, "SPT-SFTP-Elastic-IP", {
        domain: "vpc",
      });

      new cdk.CfnOutput(this, "SPT-SFTP-IP", { value: sftpElasticIP.ref });

      const sftpServer = new transfer.CfnServer(this, "SPT-SFTP-Server", {
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

      const sftpUserAccessRole = new iam.Role(this, "SPT-SFTP-Access-Role", {
        assumedBy: new iam.ServicePrincipal("transfer.amazonaws.com"),
        roleName: "SPT-SFTP-Access-Role",
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

      new transfer.CfnUser(this, "SPT-SFTP-Profiles-User", {
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

      new transfer.CfnUser(this, "SPT-SFTP-Mods-User", {
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
    }
  }
}

const app = new cdk.App();

new SPTServerStack(app, "SPT-Server-Stack");
