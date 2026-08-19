// Zero-build Lambda: only dependency is @aws-sdk/client-secrets-manager,
// which ships inside the Node.js 22 managed runtime — nothing to npm
// install, nothing to bundle, minimal supply-chain surface.
//
// This function never touches S3/CloudFront. It validates the request,
// then commits straight to VgsStudio/palestras via GitHub's Contents
// API — the repo's own existing "Deploy palestras" Action is what
// actually publishes. See slides-editor's planning notes for why.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REPO = process.env.GITHUB_REPO;
const SECRET_ARN = process.env.GITHUB_PAT_SECRET_ARN;
const TALKS_JSON_URL = process.env.TALKS_JSON_URL;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMAGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(png|jpe?g|webp|gif|svg)$/i;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const smClient = new SecretsManagerClient({});
let cachedToken = null; // reused across warm invocations of the same execution environment

async function getGithubToken() {
  if (cachedToken) return cachedToken;
  const out = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedToken = out.SecretString;
  return cachedToken;
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// Cross-checks against the PUBLIC talks.json (not any writable store) —
// a slug not already listed there is rejected outright, closing off any
// attempt to write outside an existing talk's folder.
async function loadValidSlugs() {
  const res = await fetch(TALKS_JSON_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`talks.json fetch failed: ${res.status}`);
  const talks = await res.json();
  const slugs = new Set();
  for (const t of talks) {
    const m = /^\/materiais\/([^/]+)\/$/.exec(t.href || '');
    if (m) slugs.add(m[1]);
  }
  return slugs;
}

async function githubRequest(token, method, apiPath, body) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'slides-editor-lambda',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getExistingSha(token, apiPath) {
  const res = await githubRequest(token, 'GET', apiPath);
  if (res.status === 200) return (await res.json()).sha;
  if (res.status === 404) return null;
  throw new Error(`github GET ${apiPath} failed: ${res.status}`);
}

export const handler = async (event) => {
  try {
    const slug = event.pathParameters?.slug;
    const filename = event.pathParameters?.filename;
    const isImageRoute = Boolean(filename);

    if (!slug || !SLUG_RE.test(slug)) {
      return jsonResponse(400, { error: 'slug inválido' });
    }

    const validSlugs = await loadValidSlugs();
    if (!validSlugs.has(slug)) {
      return jsonResponse(403, { error: 'palestra desconhecida — este editor só publica em palestras já existentes' });
    }

    let repoPath;
    let contentBuffer;
    const raw = event.body || '';
    contentBuffer = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');

    if (isImageRoute) {
      if (!IMAGE_NAME_RE.test(filename)) {
        return jsonResponse(400, { error: 'nome de arquivo de imagem inválido' });
      }
      if (contentBuffer.length === 0) return jsonResponse(400, { error: 'corpo vazio' });
      if (contentBuffer.length > MAX_IMAGE_BYTES) return jsonResponse(413, { error: 'imagem grande demais' });
      repoPath = `${slug}/images/${filename}`;
    } else {
      if (contentBuffer.length === 0) return jsonResponse(400, { error: 'corpo vazio' });
      if (contentBuffer.length > MAX_HTML_BYTES) return jsonResponse(413, { error: 'HTML grande demais' });
      repoPath = `${slug}/index.html`;
    }

    const token = await getGithubToken();
    const sha = await getExistingSha(token, repoPath);

    const commitBody = {
      message: `slides-editor: publica ${repoPath}`,
      content: contentBuffer.toString('base64'),
      branch: 'main',
    };
    if (sha) commitBody.sha = sha;

    const putRes = await githubRequest(token, 'PUT', repoPath, commitBody);
    if (putRes.status === 200 || putRes.status === 201) {
      return jsonResponse(200, { ok: true, path: repoPath });
    }
    if (putRes.status === 409 || putRes.status === 422) {
      return jsonResponse(409, {
        error: 'conflito — alguém mudou este arquivo desde que você abriu. Recarregue e tente de novo.',
      });
    }
    console.error('github PUT failed', putRes.status, await putRes.text());
    return jsonResponse(502, { error: 'falha ao publicar no GitHub' });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: 'erro interno' });
  }
};
