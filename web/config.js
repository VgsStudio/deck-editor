// Filled in with real values right after the first `cdk deploy` — none of
// these are secrets (client ID / API URL are meant to be public for a SPA;
// the actual gate is Cognito login + the API's JWT authorizer).
window.SLIDES_EDITOR_CONFIG = {
  cognitoDomain: 'https://vgs-slides-editor.auth.us-east-1.amazoncognito.com',
  userPoolClientId: '74jku099cpn3pblea49rqhit16',
  apiUrl: 'https://3843f805vf.execute-api.us-east-1.amazonaws.com',
  redirectUri: 'https://slides.vsoller.com.br/',
  contentBase: 'https://vsoller.com.br',
};
