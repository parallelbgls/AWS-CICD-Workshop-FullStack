// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineactions from 'aws-cdk-lib/aws-codepipeline-actions'

export class InfrastructureAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    const bucket = new s3.Bucket(this, "ArtifactBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    const buildRole = new iam.Role(this, "CodeBuildRole", {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    })

    new iam.Policy(this, "CodeBuildRolePolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "codecommit:GitPull",
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:PutObject",
            "ssm:GetParameters"
          ],
          resources: ["*"]
        }),
      ],
      roles: [
        buildRole
      ]
    })

    const deployRole = new iam.Role(this, "CodeDeployRole", {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSCodeDeployRole"),
      ]
    })

    const vpc = new ec2.Vpc(this, 'VPC');

    const role = new iam.Role(this, "WebAppInstanceRole", {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCodeDeployReadOnlyAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ReadOnlyAccess")
      ]
    })

    new iam.Policy(this, "DeploymentInstancePolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "s3:GetObject",
          ],
          resources: ["*"]
        }),
      ],
      roles: [
        role
      ]
    })

    const sg = new ec2.SecurityGroup(this, "WebServersSecurityGroup", {
      vpc: vpc,
    })
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    const userData = ec2.UserData.forLinux({ shebang: "#!/bin/bash -ex" });
    userData.addCommands(
      "yum install -y aws-cli",
      "yum install -y git",
      "cd /home/ec2-user/",
      "wget https://aws-codedeploy-" + cdk.Aws.REGION + ".s3.amazonaws.com/latest/codedeploy-agent.noarch.rpm",
      "yum -y install codedeploy-agent.noarch.rpm",
      "service codedeploy-agent start",
    )

    const options = {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage(),
      role: role,
      securityGroup: sg,
      userData: userData,
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    };
    const devWeb1 = new ec2.Instance(this, "DevWebApp01", options)
    cdk.Tags.of(devWeb1).add("Name", "DevWebApp01")
    cdk.Tags.of(devWeb1).add("App", "DemoApp")
    cdk.Tags.of(devWeb1).add("Env", "DEV")
    const prdWeb1 = new ec2.Instance(this, "PrdWebApp01", options)
    cdk.Tags.of(prdWeb1).add("Name", "PrdWebApp01")
    cdk.Tags.of(prdWeb1).add("App", "DemoApp")
    cdk.Tags.of(prdWeb1).add("Env", "PRD")

    const repository = new codecommit.Repository(this, 'DemoAppRepository', { repositoryName: 'DemoApp' });

    const codePipelineRole = new iam.Role(this, `CodePipelineRole`, {
        roleName: `CodePipelineRole`,
        assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
        managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'),
        ],
    });
    new iam.Policy(this, "PipelinePolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "sts:AssumeRole",
          ],
          resources: ["*"]
        }),
      ],
      roles: [
        codePipelineRole
      ]
    })

    const buildProject = new codebuild.PipelineProject(this, 'PipelineProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_4_0,
      },
      role: buildRole,
    });
    
    const pipeline = new codepipeline.Pipeline(this, `DemoAppPipeline`, {
        pipelineName: 'DemoApp',
        role: codePipelineRole,
        crossAccountKeys: false,
        artifactBucket: bucket,
    });

    const sourceOutput = new codepipeline.Artifact();
    const sourceAction =  new codepipelineactions.CodeCommitSourceAction({
            actionName: 'CodeCommit',
            repository: repository,
            output: sourceOutput,
    });
    const sourceStage = pipeline.addStage({
        stageName: 'Source',
        actions: [
            sourceAction
        ],
    });
    
    const buildOutput = new codepipeline.Artifact();
    const buildAction = new codepipelineactions.CodeBuildAction({
            actionName: 'CodeBuild',
            input: sourceOutput,
            project: buildProject,
            outputs: [buildOutput],
        });
    const buildStage = pipeline.addStage({
        stageName: 'Build',
        actions: [
            buildAction
        ],
    });
    
    const deploymentgroup = new codedeploy.ServerDeploymentGroup(this, 'Development', {
      role: deployRole,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
      ec2InstanceTags: new codedeploy.InstanceTagSet(
        {
          'App': ['DemoApp'],
        },
        {
          'Env': ['DEV'],
        }
      ),
    });
    
    const deployStage = pipeline.addStage({
        stageName: 'Deploy',
        actions:[
            new codepipelineactions.CodeDeployServerDeployAction({
                actionName: 'CodeDeploy',
                input: buildOutput,
                deploymentGroup: deploymentgroup
            }),
        ],
    });
    
    const approvalStage = pipeline.addStage({
        stageName: 'Approve',
        actions:[
            new codepipelineactions.ManualApprovalAction({
                actionName: 'Approve',
                additionalInformation: 'Commit message: ' + sourceAction.variables.commitMessage,
                externalEntityLink: 'https://console.aws.amazon.com/codesuite/codecommit/repositories/DemoApp/commit/' + sourceAction.variables.commitId + '?region=' + process.env.CDK_DEFAULT_REGION 
            })
        ]
    })
    
    const productGroup = new codedeploy.ServerDeploymentGroup(this, 'Production', {
      role: deployRole,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
      ec2InstanceTags: new codedeploy.InstanceTagSet(
        {
          'App': ['DemoApp'],
        },
        {
          'Env': ['PRD'],
        }
      ),
    });
    const productionStage = pipeline.addStage({
        stageName: 'Product',
        actions:[
            new codepipelineactions.CodeDeployServerDeployAction({
                actionName: 'Product',
                input: buildOutput,
                deploymentGroup: productGroup
            }),
        ]
    })
    
    new cdk.CfnOutput(this, "DevLocation", {
      description: "Development web server location",
      value: "http://" + devWeb1.instancePublicDnsName
    })
    new cdk.CfnOutput(this, "PrdLocation", {
      description: "Production web server location",
      value: "http://" + prdWeb1.instancePublicDnsName
    })

    new cdk.CfnOutput(this, "BucketName", {
      description: "Bucket for storing artifacts",
      value: bucket.bucketName
    })

    new cdk.CfnOutput(this, "BuildRoleArn", {
      description: "Build role ARN",
      value: buildRole.roleArn
    })

    new cdk.CfnOutput(this, "DeployRoleArn", {
      description: "Deploy role ARN",
      value: deployRole.roleArn
    })
  }
}
