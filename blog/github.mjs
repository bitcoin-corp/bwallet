// GitHub: read the day's commits (REST API) and publish to b0ase/bwalletx-site (git over HTTPS).
// Tokens come from the job's env file only: GITHUB_TOKEN_B0ASE (b0ase/* repos), GITHUB_TOKEN_BCORP
// (bitcoin-corp/* repos), or GITHUB_TOKEN for both. Never the owner's personal credentials.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const REPOS = [
  { repo: 'bitcoin-corp/bwallet', branch: 'main', name: 'bWalletX app' },
  { repo: 'b0ase/bit-sign', branch: 'main', name: 'bChat / bit-sign' },
  { repo: 'b0ase/bwalletx-site', branch: 'main', name: 'bwalletx.com' },
  { repo: 'bitcoin-corp/bwalletx-push', branch: 'main', name: 'push and $b server' },
  { repo: 'bitcoin-corp/bwalletx-indexer', branch: 'main', name: 'indexer' },
  { repo: 'bitcoin-corp/bagents', branch: 'main', name: 'bAgents' },
];
export const SITE_REPO = 'b0ase/bwalletx-site';

export function tokenFor(repo, env) {
  const owner = repo.split('/')[0].toLowerCase();
  if (owner === 'b0ase') return env.GITHUB_TOKEN_B0ASE || env.GITHUB_TOKEN || '';
  if (owner === 'bitcoin-corp') return env.GITHUB_TOKEN_BCORP || env.GITHUB_TOKEN || '';
  return env.GITHUB_TOKEN || '';
}

async function gh(url, token) {
  const r = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url.replace(/\?.*/, '')}`), { status: r.status });
  return r.json();
}

/** Commits on each repo's branch in [since, until). Returns { commits, problems }; a repo it can't read is a problem, not a crash. */
export async function collect({ since, until }, env, repos = REPOS) {
  const commits = [], problems = [];
  for (const { repo, branch, name } of repos) {
    const token = tokenFor(repo, env);
    try {
      for (let page = 1; page <= 5; page++) {
        const list = await gh(`https://api.github.com/repos/${repo}/commits?sha=${branch}&since=${since}&until=${until}&per_page=100&page=${page}`, token);
        for (const c of list) commits.push({ ...c, repo, repoName: name });
        if (list.length < 100) break;
      }
    } catch (e) {
      problems.push(`${repo}: ${e.status === 404 ? `not readable${token ? ' with the token given' : ' (private, no token)'}` : e.message}`);
    }
  }
  return { commits, problems };
}

// ── publishing (git) ─────────────────────────────────────────────────────────
const git = (cwd, args, token) => execFileSync('git', [
  '-c', 'credential.helper=',
  ...(token ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : []),
  ...args,
], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

/** A fresh checkout of the site's main at `dir` (cloned once, then reset to origin/main each time). */
export function siteCheckout(dir, env) {
  const token = tokenFor(SITE_REPO, env);
  if (!token) throw Object.assign(new Error('no GitHub token for b0ase/bwalletx-site (GITHUB_TOKEN_B0ASE)'), { needsToken: true });
  if (!fs.existsSync(`${dir}/.git`)) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['clone', '--quiet', '--depth', '50', `https://github.com/${SITE_REPO}.git`, '.'], token);
  }
  git(dir, ['fetch', '--quiet', 'origin', 'main'], token);
  git(dir, ['reset', '--quiet', '--hard', 'origin/main'], token);
  git(dir, ['clean', '-fdq'], token);
  return { git: (args) => git(dir, args, token) };
}
