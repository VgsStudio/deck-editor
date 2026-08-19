// Cognito "custom message" trigger: fires synchronously before Cognito
// sends any templated email, letting us swap in real branded HTML for
// the plain-text default. Cognito still owns generating the code and
// actually sending the mail (via SES) — this only rewrites the content.
// No AWS SDK needed, no state, nothing to bundle.

const ORANGE = '#ff6a21';
const RED = '#c4342a';
const BG = '#0a0806';
const CARD = '#161210';
const TEXT = '#f2eee8';
const MUTED = '#a99d8c';

function emailHtml({ heading, intro, code, footer }) {
  return `<!doctype html>
<html>
<body style="margin:0;padding:32px 16px;background:${BG};font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:420px;margin:0 auto;border-collapse:collapse;">
    <tr>
      <td style="padding:36px 32px;background:${CARD};border:1px solid rgba(255,255,255,0.12);border-radius:18px;">
        <div style="font-size:32px;line-height:1;margin-bottom:14px;">🤓</div>
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:${ORANGE};text-transform:uppercase;margin-bottom:8px;">VGS AUTH</div>
        <div style="font-size:19px;font-weight:700;color:${TEXT};margin-bottom:10px;">${heading}</div>
        <div style="font-size:14px;color:${MUTED};line-height:1.5;margin-bottom:26px;">${intro}</div>
        <div style="text-align:center;padding:20px 0;border-radius:12px;background:linear-gradient(135deg, ${ORANGE}, ${RED});margin-bottom:24px;">
          <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#fff;font-family:ui-monospace,Consolas,monospace;">${code}</span>
        </div>
        <div style="font-size:12px;color:${MUTED};line-height:1.5;">${footer}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 8px;text-align:center;font-size:11px;color:#5a5148;">
        editor.slides.vsoller.com.br
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const handler = async (event) => {
  if (event.triggerSource === 'CustomMessage_Authentication') {
    const code = event.request.codeParameter;
    event.response.emailSubject = '🔑 Seu código de acesso — VGS AUTH';
    event.response.emailMessage = emailHtml({
      heading: 'Seu código de acesso',
      intro: 'Use o código abaixo pra entrar no editor de palestras. Ele expira em alguns minutos.',
      code,
      footer: 'Se você não pediu esse código, pode ignorar este e-mail.',
    });
  }
  return event;
};
