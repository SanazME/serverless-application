import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as iam from '@aws-cdk/aws-iam';
import * as event_sources from '@aws-cdk/aws-lambda-event-sources';
import { CfnOutput, Duration } from "@aws-cdk/core";

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
   
    
  }
}

