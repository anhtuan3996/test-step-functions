import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const vpc = new ec2.Vpc(this, 'TestVPC', {
      maxAzs: 2,
    });

    const ecsCluster = new ecs.Cluster(this, 'TestECSCluster', {
      vpc,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TestTaskDefinition');

    const container = taskDefinition.addContainer('TestContainer', {
      image: ecs.ContainerImage.fromRegistry('nginx'),
      memoryLimitMiB: 256,
    });

    container.addPortMappings({ containerPort: 80 });


    // const ecsService = new ecs.Ec2Service(this, 'TestECSService', {
    //   cluster: ecsCluster,
    //   taskDefinition,
    // });


    const rule = new events.Rule(this, 'EcsScheduledRule', {
      schedule: events.Schedule.expression('rate(10 minute)'),
    });


    const runTask = new tasks.EcsRunTask(this, 'RunECSTask', {
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      cluster: ecsCluster,
      taskDefinition: taskDefinition,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      // containerOverrides: [
      // ]
    })

    const checkErrorLambda = new tasks.LambdaInvoke(this, 'CheckError', {
      lambdaFunction: this.createCheckError(),
      outputPath: '$.taskError',
      payloadResponseOnly: true
    })


    const retry = runTask.addRetry({
      errors: ['ECS.AccessDeniedException'],
      interval: cdk.Duration.seconds(60),
      // maxAttempts: 2,
      // backoffRate: 2
    })

    const lambda = this.createLambdaNotifyFailure();

    const notifyFailure = new tasks.LambdaInvoke(this, 'NotifyFailure', {
      lambdaFunction: lambda,
      outputPath: '$.taskError',
      payloadResponseOnly: true
    })

    // const catchAll = runTask.addCatch(notifyFailure, {
    //   errors: ['States.ALL'],
    //   resultPath: '$.taskError'
    // })

    const definition = stepfunctions.Chain.start(
      runTask
        .addCatch(
          checkErrorLambda.next(
            new stepfunctions.Choice(this, `Retryable?`)
              .when(
                stepfunctions.Condition.and(
                  stepfunctions.Condition.stringEquals("$.Error.Payload.type", "retryable"),
                  stepfunctions.Condition.numberLessThan("$.Error.Payload.retryCount", 3),
                ),
                new stepfunctions.Wait(this, `RetryWait`, {
                  time: stepfunctions.WaitTime.secondsPath("$.Error.Payload.waitTimeSeconds"),
                }).next(runTask),
              )
              .otherwise(notifyFailure),
          ),
          { resultPath: "$.RunTaskError" },
        )
    );

    // const definition =  runTask
    // .addCatch(notifyFailure, {
    //   errors:['States.ALL'],
    //   resultPath: '$.taskError',
    // });

    // const defination = stepfunctions.Chain.start(runTask).next(retry).next(catchAll)

    const stepFunctions = new stepfunctions.StateMachine(this, 'TestStateMachineCDK', {
      stateMachineName: 'test-retry',
      timeout: cdk.Duration.seconds(5),
      definition: definition
    })

    rule.addTarget(new targets.SfnStateMachine(stepFunctions));


    // CloudWatch Event Rule to monitor Step Function timeouts
    const eventRule = new events.Rule(this, 'StepFunctionTimeoutRule', {
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          status: ['TIMED_OUT']
        }
      }
    });

    eventRule.addTarget(new targets.LambdaFunction(lambda));
  }

  createLambdaNotifyFailure() {


    const path = require('path');

    const lambdaFunctionName = `lambda-notify-failure-ecs-scheduled-task`;
    return new lambda.Function(this, `NotifyFailureReTryEcsTaskLambda1`, {
        runtime: lambda.Runtime.NODEJS_18_X,
        functionName: lambdaFunctionName,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
            path.join(__dirname, '..','lib', 'lambda', 'notify-failure-ecs-scheduled-task')
        ),
        environment: { SLACK_WEBHOOK_URL: 'hook' },
        timeout: cdk.Duration.minutes(1),
        memorySize: 128,
    });
 }

  createCheckError() {

    const path = require('path');

    const lambdaFunctionName = `check-error`;
    return new lambda.Function(this, `NotifyFailureReTryEcsTaskLambda`, {
      runtime: lambda.Runtime.NODEJS_18_X,
      functionName: lambdaFunctionName,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..','lib', 'lambda', 'check-error')
      ),
      environment: { SLACK_WEBHOOK_URL: 'hook' },
      timeout: cdk.Duration.minutes(1),
      memorySize: 128,
    });
  }
 
  
}
