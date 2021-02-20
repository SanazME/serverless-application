import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as apigateway from "@aws-cdk/aws-apigateway";
import * as iam from "@aws-cdk/aws-iam";
import { S3EventSource } from "@aws-cdk/aws-lambda-event-sources";
import { Duration, RemovalPolicy } from "@aws-cdk/core";
import * as path from "path";
import { AuthorizationType, PassthroughBehavior } from "@aws-cdk/aws-apigateway";

const imageBucketName = "cdk-rek-imagebucket";
const resizedBucketName = imageBucketName + "-resized";

export class ServerlessApplicationStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    /**=================================================================
     * Image Bucket
     * =================================================================
     */
    const imageBucket = new s3.Bucket(this, imageBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, "imageBucket", { value: imageBucket.bucketName });

    /**=================================================================
     * Thumbnail (Resized) Bucket
     * =================================================================
     */
    const resizedBucket = new s3.Bucket(this, resizedBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, "resizedBucket", {
      value: resizedBucket.bucketName,
    });

    /**=================================================================
     * DynamoDB table for storing image labels
     * =================================================================
     */
    const table = new dynamodb.Table(this, "ImageLabels", {
      partitionKey: { name: "image", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, "ddbTable", { value: table.tableName });
    /**=================================================================
     * Creating a layer for our lambda function
     * =================================================================
     */
    const layer = new lambda.LayerVersion(this, "reklayer", {
      code: lambda.Code.fromAsset("reklayer"),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      license: "Apache-2.0",
      description:
        "A layer to enable the PIL library in the Rekognition Lambda",
    });
    /**=================================================================
     * Building lambda function; compute for our serverless microservice
     * =================================================================
     */
    const rekFn = new lambda.Function(this, "rekognitionFunction", {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "index.handler",
      timeout: Duration.seconds(30),
      code: lambda.Code.fromAsset("rekognitionlambda"),
      memorySize: 1024,
      layers: [layer],
      environment: {
        TABLE: table.tableName,
        BUCKET: imageBucket.bucketName,
        RESIZEDBUCKET: resizedBucket.bucketName,
      },
    });
    /**=================================================================
     * Lambda can read from S3 event source when the obj is created in s3
     * =================================================================
     */
    rekFn.addEventSource(
      new S3EventSource(imageBucket, {
        events: [s3.EventType.OBJECT_CREATED],
      })
    );
    /**=================================================================
     * Grant s3 read & put permission to lambda
     * =================================================================
     */
    imageBucket.grantRead(rekFn);
    resizedBucket.grantPut(rekFn);
    /**=================================================================
     * Grant dynamodb write permission to lambda
     * =================================================================
     */
    table.grantWriteData(rekFn);
    rekFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["rekognition:DetectLabels"],
        resources: ["*"],
      })
    );

    /**=================================================================
     * Lambda for Synchronous Front End
     * =================================================================
     */
    const serviceFn = new lambda.Function(this, "serviceFunction", {
      code: lambda.Code.fromAsset("servicelambda"),
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "index.handler",
      environment: {
        TABLE: table.tableName,
        BUCKET: imageBucket.bucketName,
        RESIZEDBUCKET: resizedBucket.bucketName,
      },
    });

    imageBucket.grantWrite(serviceFn);
    resizedBucket.grantWrite(serviceFn);
    table.grantReadWriteData(serviceFn);

    /**=================================================================
     * This construct builds a new Amazon API Gateway with AWS Lambda Integration
     * =================================================================
     */
    
    const api = new apigateway.LambdaRestApi(this, "imageAPi", {
      handler: serviceFn,
      proxy: false,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
    
    const lambdaIntegration = new apigateway.LambdaIntegration(serviceFn, {
      proxy: false,
      requestParameters: {
        "integration.request.querystring.action":
        "method.request.querystring.action",
        "integration.request.querystring.key": "method.request.querystring.key",
      },
      requestTemplates: {
        "application/json": JSON.stringify({
          action: "$util.escapeJavaScript($input.params('action'))",
          key: "util.escapeJavaScript($input.params('key'))",
        }),
      },
      passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
      ],
    });
    
    /**=================================================================
     * API Gateway 
     * =================================================================
     */

     const imageApi = api.root.addResource('images');

     // GET /images
     imageApi.addMethod('GET', lambdaIntegration, {
       requestParameters: {
         'method.request.querystring.action':true,
         'method.request.querystring.key':true
       },
       methodResponses: [
         {
           statusCode: "200",
           responseParameters: {
             'method.response.header.Access-Control-Allow-Origin': true,
           },
         },
         {
           statusCode: "500",
           responseParameters: {
             'method.response.header.Access-Control-Allow-Origin': true,
           },
         },
       ]
     });

     // DELETE /images
     imageApi.addMethod('DELETE', lambdaIntegration, {
       requestParameters: {
         'method.request.querystring.action':true,
         'method.request.querystring.key':true
       },
       methodResponses: [
         {
           statusCode: "200",
           responseParameters: {
             'method.response.header.Access-Control-Allow-Origin': true,
           },
         },
         {
           statusCode: "500",
           responseParameters: {
             'method.response.header.Access-Control-Allow-Origin': true,
           },
         },
       ]
     });

  }
}
