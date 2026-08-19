import * as path from 'node:path';
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

// Same palette as web/style.css — colors here are 8-hex RGBA (Managed
// Login's format), everywhere else they're the CSS the site already uses.
const ORANGE = 'ff6a21ff';
const RED = 'c4342aff';
const BG = '0a0806ff';
const CARD = '161210ff';
const BORDER = '3a332cff';
const TEXT_HEADING = 'f2eee8ff';
const TEXT_BODY = 'cfc7baff';
const TEXT_MUTED = 'a99d8cff';
const ERROR_TEXT = 'ff8a8aff';

// Partial Managed Login branding settings — only the fields that diverge
// from Cognito's own defaults are listed; anything omitted is filled in
// by Cognito itself, same as useCognitoProvidedValues would do.
const MANAGED_LOGIN_SETTINGS = {
  categories: {
    global: { colorSchemeMode: 'DARK' },
  },
  components: {
    pageBackground: {
      image: { enabled: false },
      darkMode: { color: BG },
    },
    form: {
      borderRadius: 18,
      darkMode: { backgroundColor: CARD, borderColor: BORDER },
    },
    primaryButton: {
      darkMode: {
        defaults: { backgroundColor: ORANGE, textColor: 'ffffffff' },
        hover: { backgroundColor: RED, textColor: 'ffffffff' },
        active: { backgroundColor: RED, textColor: 'ffffffff' },
      },
    },
    secondaryButton: {
      darkMode: {
        defaults: { backgroundColor: CARD, borderColor: ORANGE, textColor: ORANGE },
        hover: { backgroundColor: '2a1f16ff', borderColor: ORANGE, textColor: ORANGE },
        active: { backgroundColor: '3a2a1cff', borderColor: ORANGE, textColor: ORANGE },
      },
    },
    pageText: {
      darkMode: { headingColor: TEXT_HEADING, bodyColor: TEXT_BODY, descriptionColor: TEXT_MUTED },
    },
    alert: {
      darkMode: { error: { backgroundColor: '1a0f0dff', borderColor: ERROR_TEXT } },
    },
  },
};

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

    // Rewrites the plain-text email-OTP message into branded "VGS AUTH"
    // HTML — Cognito still generates the code and sends via SES, this
    // trigger only swaps the subject/body content.
    const customMessageFn = new lambda.Function(this, 'CustomMessageFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'custom-message.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: Duration.seconds(5),
      memorySize: 128,
    });

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
      // emailOtp as a FIRST factor is rejected outright by Cognito
      // whenever MFA is required ("Only PASSWORD and WEB_AUTHN can be
      // enabled as an auth factor if MFA is enabled") — tried it, AWS
      // said no. Email-as-alternative lives at the MFA (second-factor)
      // step instead — see mfaSecondFactor below and the note on cost.
      lambdaTriggers: { customMessage: customMessageFn },
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

    // Dark + orange, matching the editor's own theme — the full designer
    // is still available in the console later for further tweaks (logo,
    // background art, etc.), this covers the colors that mattered most.
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      settings: MANAGED_LOGIN_SETTINGS,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomain', {
      value: `https://${props.domainPrefix}.auth.${this.region}.amazoncognito.com`,
    });
  }
}
