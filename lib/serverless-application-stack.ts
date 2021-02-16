import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as iam from '@aws-cdk/aws-iam';
import { S3EventSource } from "@aws-cdk/aws-lambda-event-sources";
import { Duration } from '@aws-cdk/core';
import * as path from 'path';


const imageBucketName = "cdk-rek-imagebucket";
const resizedBucketName = imageBucketName + '-resized';

export class ServerlessApplicationStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    /**
     * Image Bucket
     */
    const imageBucket = new s3.Bucket(this, imageBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, 'imageBucket', {value: imageBucket.bucketName});
    
    /**
     * Thumbnail (Resized) Bucket
     */
    const resizedBucket = new s3.Bucket(this, resizedBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, 'resizedBucket', {value: resizedBucket.bucketName});
    
    /**
     * DynamoDB table for storing image labels
     */
    const table = new dynamodb.Table(this, 'ImageLabeles', {
      partitionKey: {name: 'image', type: dynamodb.AttributeType.STRING}
    });
    new cdk.CfnOutput(this, 'ddbTable', {value: table.tableName});   
    /**
     * Creating a layer for our lambda function
     */
    const layer = new lambda.LayerVersion(this, 'reklayer', {
      code: lambda.Code.fromAsset('reklayer'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      license: 'Apache-2.0',
      description: 'A layer to enable the PIL library in the Rekognition Lambda',
    });
    /**
     * Building lambda function; compute for our serverless microservice
     */
    const rekFn = new lambda.Function(this, 'rekognitionFunction', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromAsset('rekognitionlambda'),
      memorySize: 1024,
      layers:[layer],
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "THUMBBUCKET": resizedBucket.bucketName
      }
    })
    /**
     * Lambda can read from S3 event source when the obj is created in s3
     */
    rekFn.addEventSource(new S3EventSource(imageBucket, {
      events: [s3.EventType.OBJECT_CREATED]
    }));
    /**
     * Grant s3 read & put permission to lambda
     */
    imageBucket.grantRead(rekFn)
    imageBucket.grantPut(rekFn)
    /**
     * Grant dynamodb write permission to lambda
     */
    table.grantWriteData(rekFn);
    rekFn.addToRolePolicy( new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*']
    }))    
  }
}
