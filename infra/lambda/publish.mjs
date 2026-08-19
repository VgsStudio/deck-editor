// Zero-build Lambda: only dependencies are @aws-sdk/* packages, which ship
// inside the Node.js 22 managed runtime — nothing to npm install, nothing
// to bundle, minimal supply-chain surface.
//
// Publish does two things, in order: (1) commit to VgsStudio/palestras via
// GitHub's Contents API — this is what keeps git as the source of truth,
// and its sha-based conflict check is what stops a stale edit from
// clobbering someone else's concurrent change; (2) once that succeeds,
// write the same bytes straight to S3 and invalidate CloudFront, so the
// site updates immediately instead of waiting on the repo's own "Deploy
// palestras" Action (which still runs on every push, just no longer on
// the critical path — a safety net, not a bottleneck).
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

const REPO = process.env.GITHUB_REPO;
const SECRET_ARN = process.env.GITHUB_PAT_SECRET_ARN;
const TALKS_JSON_URL = process.env.TALKS_JSON_URL;
const SITE_BUCKET = process.env.SITE_BUCKET;
const DISTRIBUTION_ID = process.env.DISTRIBUTION_ID;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMAGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(png|jpe?g|webp|gif|svg)$/i;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

const smClient = new SecretsManagerClient({});
const s3Client = new S3Client({});
const cfClient = new CloudFrontClient({});
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

// repoPath mirrors materiais/<slug>/... 1:1 for html-type talks (see
// palestras/scripts/build-manifest.mjs), so writing it straight to that
// same key is equivalent to what the Action's own sync would produce.
async function publishToSite(repoPath, contentBuffer, imageFilename) {
  const key = `materiais/${repoPath}`;
  const contentType = imageFilename
    ? IMAGE_CONTENT_TYPES[imageFilename.slice(imageFilename.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream'
    : 'text/html; charset=utf-8';

  await s3Client.send(
    new PutObjectCommand({ Bucket: SITE_BUCKET, Key: key, Body: contentBuffer, ContentType: contentType }),
  );
  await cfClient.send(
    new CreateInvalidationCommand({
      DistributionId: DISTRIBUTION_ID,
      InvalidationBatch: {
        CallerReference: `slides-editor-${Date.now()}`,
        Paths: { Quantity: 1, Items: [`/${key}`] },
      },
    }),
  );
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
      try {
        await publishToSite(repoPath, contentBuffer, isImageRoute ? filename : null);
      } catch (err) {
        // Git already has it — the Action will catch S3/CloudFront up on
        // its own within its normal ~20s. Not a failure from the user's
        // point of view, just slower than usual this one time.
        console.error('direct S3/CloudFront publish failed after git commit succeeded', err);
        return jsonResponse(200, {
          ok: true,
          path: repoPath,
          warning: 'commitado, mas a atualização instantânea falhou — deve aparecer no ar em ~20s pelo build automático',
        });
      }
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
