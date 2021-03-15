import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as apigateway from "@aws-cdk/aws-apigateway";
import * as cognito from "@aws-cdk/aws-cognito";
import {
  AuthorizationType,
  PassthroughBehavior,
} from "@aws-cdk/aws-apigateway";
import * as iam from "@aws-cdk/aws-iam";
import { Duration, RemovalPolicy } from "@aws-cdk/core";
import * as s3deploy from "@aws-cdk/aws-s3-deployment";
import * as sqs from "@aws-cdk/aws-sqs";
import * as s3n from "@aws-cdk/aws-s3-notifications";
import * as event_source from "@aws-cdk/aws-lambda-event-sources";
import { HttpMethods } from "@aws-cdk/aws-s3";
import * as path from "path";

const imageBucketName = "cdk-rek-imagebucket";
const resizedBucketName = imageBucketName + "-resized";
const websiteBucketName = "cdk-rekn-publicbucket";

export class ServerlessApplicationStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    /**=================================================================
     * Image Bucket
     * =================================================================
     */
    const imageBucket = new s3.Bucket(this, imageBucketName, {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, "imageBucket", { value: imageBucket.bucketName });

    const imageBucketArn = imageBucket.bucketArn;

    /**=================================================================
     * Thumbnail (Resized) Bucket
     * =================================================================
     */
    const resizedBucket = new s3.Bucket(this, resizedBucketName, {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new cdk.CfnOutput(this, "resizedBucket", {
      value: resizedBucket.bucketName,
    });

    const resizedBucketArn = resizedBucket.bucketArn;

    /**=================================================================
     * Construct to create ouS3 Bucket to host our website
     * =================================================================
     */
    const webBucket = new s3.Bucket(this, websiteBucketName, {
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      removalPolicy: RemovalPolicy.DESTROY,
      // publicReadAccess: true      // exposes the bucket completely public or we can add a policy to expose the bucket for a given condition
    });

    webBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [webBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          IpAddress: {
            "aws:SourceIp": [
              "*.*.*.*/*", // change it to your IP address of from your allowed list
            ],
          },
        },
      })
    );

    new cdk.CfnOutput(this, "bucketURL", {
      value: webBucket.bucketWebsiteDomainName,
    });

    /**=================================================================
     * Deploy site contents to S3 bucket
     * =================================================================
     */
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset("./public")],
      destinationBucket: webBucket,
    });

    /**=================================================================
     * DynamoDB table for storing image labels
     * =================================================================
     */
    const table = new dynamodb.Table(this, "ImageLabels", {
      partitionKey: { name: "image", type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
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
     * Cognito User Pool Authentication
     * =================================================================
     */
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true, // Allow users to sign up
      autoVerify: { email: true }, // Verify email address by sending a verification code
      signInAliases: { email: true, username: true }, // Set email as an alias
    });

    /**
     * An app is an entity within a user pool that has permission to call unauthenticated APIs (APIs that do not have an authenticated user), such as APIs to register, sign in, and handle forgotten passwords. To call these APIs, you need an app client ID and an optional client secret.
     */
    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false, // Don't need to generate secret for web app running on browsers
    });

    const identityPool = new cognito.CfnIdentityPool(
      this,
      "ImageRekognitionIdentityPool",
      {
        allowUnauthenticatedIdentities: false, // Don't allow unauthenticated users
        cognitoIdentityProviders: [
          {
            clientId: userPoolClient.userPoolClientId,
            providerName: userPool.userPoolProviderName,
          },
        ],
      }
    );

    const auth = new apigateway.CfnAuthorizer(this, "APIGatewayAuthorizer", {
      name: "customer-authorizer",
      identitySource: "method.request.header.Authorization",
      providerArns: [userPool.userPoolArn],
      restApiId: api.restApiId,
      type: AuthorizationType.COGNITO,
    });

    const authenticatedRole = new iam.Role(
      this,
      "ImageRekognitionAuthenticatedRole",
      {
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "authenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    // IAM policy granting users permission to upload, download and delete their own pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        effect: iam.Effect.ALLOW,
        resources: [
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
          resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
          resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
        ],
      })
    );

    // IAM policy granting users permission to list their pictures
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        effect: iam.Effect.ALLOW,
        resources: [imageBucketArn, resizedBucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"],
          },
        },
      })
    );

    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "mobileanalytics:PutEvents",
          "cognito-sync:*",
          "cognito-identity:*",
        ],
        resources: ["*"],
      })
    );

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "IdentityPoolRoleAttachment",
      {
        identityPoolId: identityPool.ref,
        roles: { authenticated: authenticatedRole.roleArn },
      }
    );

    // Export values of Cognito
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "AppClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "IdentityPoolId", {
      value: identityPool.ref,
    });

    /**=================================================================
     * API Gateway
     * =================================================================
     */

    const imageApi = api.root.addResource("images");

    // GET /images
    imageApi.addMethod("GET", lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        "method.request.querystring.action": true,
        "method.request.querystring.key": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
      ],
    });

    // DELETE /images
    imageApi.addMethod("DELETE", lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        "method.request.querystring.action": true,
        "method.request.querystring.key": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
      ],
    });

    /**=================================================================
     * Building SQS queue and DeadLetter Queue
     * =================================================================
     */
    const dlQueue = new sqs.Queue(this, "ImageDLQueue", {
      queueName: "ImageDLQueue",
    });

    const queue = new sqs.Queue(this, "ImageQueue", {
      queueName: "ImageQueue",
      visibilityTimeout: cdk.Duration.seconds(30),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 2,
        queue: dlQueue,
      },
    });
    /**=================================================================
     * Building S3 Bucket Create Notificatino to SQS
     * =================================================================
     */
    imageBucket.addObjectCreatedNotification(new s3n.SqsDestination(queue), {
      prefix: "private/",
    });
    /**=================================================================
     * Lambda(Rekognition) to consume messages from SQS
     * =================================================================
     */
    rekFn.addEventSource(new event_source.SqsEventSource(queue));
  }
}
