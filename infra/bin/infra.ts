#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { AuthStack } from '../lib/auth-stack';
import { SiteStack } from '../lib/site-stack';
import { ApiStack } from '../lib/api-stack';
import { OidcStack } from '../lib/oidc-stack';

const ZONE_NAME = 'vsoller.com.br';
const HOSTED_ZONE_ID = 'Z02751983QMG471PEMGX6';
const DOMAIN_NAME = `slides.${ZONE_NAME}`;
// Existing wildcard cert (*.vsoller.com.br, us-east-1) — covers this
// subdomain already, no new cert/DNS-validation step needed.
const WILDCARD_CERT_ARN = 'arn:aws:acm:us-east-1:605914448173:certificate/bfa41f72-6051-4776-84b2-a5ed9ac68370';

const app = new cdk.App();

const env = {
  account: '605914448173',
  region: 'us-east-1',
};

const certificate = acm.Certificate.fromCertificateArn(app, 'WildcardCert', WILDCARD_CERT_ARN);

const authStack = new AuthStack(app, 'SlidesEditor-Auth', {
  env,
  domainPrefix: 'vgs-slides-editor',
  callbackUrls: [`https://${DOMAIN_NAME}/`],
  logoutUrls: [`https://${DOMAIN_NAME}/`],
});

new SiteStack(app, 'SlidesEditor-Site', {
  env,
  domainName: DOMAIN_NAME,
  hostedZoneId: HOSTED_ZONE_ID,
  zoneName: ZONE_NAME,
  certificate,
});

new ApiStack(app, 'SlidesEditor-Api', {
  env,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  frontendOrigin: `https://${DOMAIN_NAME}`,
  githubRepo: 'VgsStudio/palestras',
});

new OidcStack(app, 'SlidesEditor-Oidc', {
  env,
  githubRepo: 'VgsStudio@81604963/slides-editor@1339821987',
});
