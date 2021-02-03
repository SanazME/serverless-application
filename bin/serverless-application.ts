#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ServerlessApplicationStack } from '../lib/serverless-application-stack';

const app = new cdk.App();
new ServerlessApplicationStack(app, 'ServerlessApplicationStack');
