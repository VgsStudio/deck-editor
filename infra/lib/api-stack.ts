import * as path from 'node:path';
import { Stack, type StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ApiStackProps extends StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  /** Exact frontend origin — CORS is locked to this, nothing wider. */
  frontendOrigin: string;
  /** owner/repo of the content repo the publish Lambda commits to. */
  githubRepo: string;
  /** Existing portfolio site bucket/distribution — referenced, not owned. */
  siteBucketName: string;
  distributionId: string;
}

/**
 * Write-only API: two PUT routes. The Lambda commits to the `palestras`
 * repo first (via GitHub's Contents API, using the file's current `sha` —
 * so a concurrent edit from elsewhere fails the commit instead of being
 * silently clobbered), which keeps git as the single source of truth and
 * gives every publish a revertable history. Once that commit succeeds, it
 * ALSO writes the same content straight to S3 + invalidates CloudFront —
 * so the site updates immediately instead of waiting on the existing
 * "Deploy palestras" Action, which still runs on every push as a
 * redundant safety net but is no longer on the critical path.
 *
 * IAM is scoped the same way as the palestras repo's own
 * `github-actions-talks-deploy` role: S3 write limited to `materiais/*`,
 * CloudFront invalidation limited to this one distribution. Nothing wider.
 */
export class ApiStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const githubPatSecret = new secretsmanager.Secret(this, 'GithubPatSecret', {
      secretName: 'slides-editor/github-pat',
      description:
        'Fine-grained GitHub PAT, scoped to Contents:write on VgsStudio/palestras only. Value set manually after deploy — never written by CDK.',
    });

    const siteBucket = s3.Bucket.fromBucketName(this, 'SiteBucket', props.siteBucketName);

    const publishFn = new lambda.Function(this, 'PublishFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'publish.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        GITHUB_REPO: props.githubRepo,
        GITHUB_PAT_SECRET_ARN: githubPatSecret.secretArn,
        TALKS_JSON_URL: 'https://vsoller.com.br/materiais/talks.json',
        SITE_BUCKET: props.siteBucketName,
        DISTRIBUTION_ID: props.distributionId,
      },
    });
    githubPatSecret.grantRead(publishFn);

    publishFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WriteMateriaisPrefix',
        actions: ['s3:PutObject'],
        resources: [siteBucket.arnForObjects('materiais/*')],
      }),
    );
    publishFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateMateriaisPaths',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.distributionId}`],
      }),
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [props.frontendOrigin],
        allowMethods: [apigwv2.CorsHttpMethod.PUT],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.minutes(10),
      },
      defaultAuthorizer: new HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
        userPoolClients: [props.userPoolClient],
      }),
    });

    // Conservative — this is a single-user tool, not a public API. Cheap
    // insurance against a leaked token being used for cost/abuse.
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 },
    });

    const integration = new HttpLambdaIntegration('PublishIntegration', publishFn);
    httpApi.addRoutes({ path: '/talks/{slug}/html', methods: [apigwv2.HttpMethod.PUT], integration });
    httpApi.addRoutes({ path: '/talks/{slug}/images/{filename}', methods: [apigwv2.HttpMethod.PUT], integration });

    this.apiUrl = httpApi.apiEndpoint;
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'GithubPatSecretArn', { value: githubPatSecret.secretArn });
  }
}
