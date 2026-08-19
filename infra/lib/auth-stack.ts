import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  /** Cognito Hosted UI domain prefix — must be globally unique across all AWS accounts. */
  domainPrefix: string;
  callbackUrls: string[];
  logoutUrls: string[];
}

/**
 * Single-user auth for the hosted slide editor. No self-signup — the one
 * user (vgsoller@gmail.com) is created out-of-band via `admin-create-user`
 * so no email/password ever lives in source control. TOTP MFA is required
 * (not SMS: no SIM-swap exposure, no per-message SNS cost).
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'slides-editor',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.userPool = userPool;

    userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
      // The classic Hosted UI looks dated; Managed Login is Cognito's
      // modern, responsive redesign — a real visual upgrade even with
      // zero custom branding applied on top.
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const userPoolClient = userPool.addClient('SpaClient', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
    });
    this.userPoolClient = userPoolClient;

    // Cognito-provided defaults for Managed Login — a real designer is
    // available in the console later if custom colors/logo are wanted,
    // this just switches the client on to the modern style.
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomain', {
      value: `https://${props.domainPrefix}.auth.${this.region}.amazoncognito.com`,
    });
  }
}
