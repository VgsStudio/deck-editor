import * as path from 'node:path';
import { Stack, type StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface ApiStackProps extends StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  /** Exact frontend origin — CORS is locked to this, nothing wider. */
  frontendOrigin: string;
  /** owner/repo of the content repo the publish Lambda commits to. */
  githubRepo: string;
}

/**
 * Write-only API: two PUT routes that end in a git commit to the
 * `palestras` repo (via GitHub's Contents API), never a direct S3 write.
 * That keeps the repo as the single source of truth — the existing
 * "Deploy palestras" GitHub Action is what actually publishes, exactly
 * as it does for any other push. See slides-editor infra notes / the
 * planning doc for why this replaced an earlier direct-to-S3 design.
 *
 * The Lambda's only AWS permission is reading the one GitHub PAT secret
 * — no S3, no CloudFront. A bug here has nothing destructive to reach.
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
      },
    });
    githubPatSecret.grantRead(publishFn);

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
