import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as iam from '@aws-cdk/aws-iam';
import * as event_sources from '@aws-cdk/aws-lambda-event-sources';
import { CfnOutput, Duration } from "@aws-cdk/core";
import * as path from 'path';
import { S3EventSource } from "@aws-cdk/aws-lambda-event-sources";

const imageBucketName = 'cdk-rek-imagebucket';

export class ServerlessApplicationStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    /**
     * Image Bucket
     */
    const imageBucket = new s3.Bucket(this, imageBucketName);
    new cdk.CfnOutput(this, 'imageBucket', {value: imageBucket.bucketName});
    /**
     * DynamoDB table for storing image labels
     */
    const table = new dynamodb.Table(this, 'ImageLabeles', {
      partitionKey: {name: 'image', type: dynamodb.AttributeType.STRING}
    });
    new cdk.CfnOutput(this, 'ddbTable', {value: table.tableName});   
    /**
     * Building lambda function; compute for our serverless microservice
     */
    const rekFn = new lambda.Function(this, 'rekognitionFunction', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'rekognitionlambda')),
      timeout: Duration.seconds(30), 
      memorySize: 1024,
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName
      }
    })
    /**
     * Lambda can read from S3 event source when the obj is created in s3
     */
    rekFn.addEventSource(new S3EventSource(imageBucket, {
      events: [s3.EventType.OBJECT_CREATED]
    }));
    /**
     * Grant s3 read permission to lambda
     */
    imageBucket.grantRead(rekFn)
    /**
     * Grant dynamodb write permission to lambda
     */
    table.grantWriteData(rekFn);
    /**
     * 
     */
    rekFn.addToRolePolicy( new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*']
    })
    )
  }
}

