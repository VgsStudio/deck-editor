import { Stack, type StackProps, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface OidcStackProps extends StackProps {
  /** "owner@ownerId/repo@repoId" — GitHub's immutable sub-claim format, see portfolio/infra's github-oidc-stack.ts for the same gotcha. */
  githubRepo: string;
  cdkQualifier?: string;
}

/** Lets GitHub Actions in this repo run `cdk deploy` without a long-lived AWS key. */
export class OidcStack extends Stack {
  constructor(scope: Construct, id: string, props: OidcStackProps) {
    super(scope, id, props);

    const qualifier = props.cdkQualifier ?? 'hnb659fds';
    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

    const deployRole = new iam.Role(this, 'GithubActionsDeployRole', {
      roleName: 'github-actions-slides-editor-deploy',
      description: 'Assumed by GitHub Actions (OIDC) to deploy the slides-editor stacks via CDK',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main` },
      }),
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-image-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );
  }
}
