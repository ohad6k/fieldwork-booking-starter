// VibeRaven check for pull requests.
// Runs the pinned VibeRaven CLI on the PR head: `race --auto`, every reviewed race rule in the repo, and `check --base`.
// Only a proven break (an executed order of two requests that left the rule false) fails the check. Everything else is a note.
// No secrets, no Docker, no database service: the race runs on an in-process PostgreSQL (PGlite) with synthetic rows.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLI = {
  version: '1.13.0',
  tarball: 'https://registry.npmjs.org/@viberaven/cli/-/cli-1.13.0.tgz',
  integrity: 'sha512-S6J5U02vBBxyD5EiQTTcbrwF21+WAjS7Pr6pKEizHNZNBMuWY4PWPCskiwiqbwUBvPWXxijp4NCeNf2ihLLOtw==',
};
const NAME = 'VibeRaven';
const sha40 = /^[a-f0-9]{40}$/;
const ruleId = /^[a-z][a-z0-9_]{0,79}$/;
const specGlobs = [['.', /^viberaven\.race\.json$/], ['supabase/tests', /\.(?:rule|race)\.json$/], ['race', /\.json$/]];
const MAX_SPECS = 6;

// ---------- which changes matter ----------

const source = /\.(?:[cm]?[jt]sx?|py|go|rb|php)$/i;
const routeDir = /(?:^|\/)(?:api|routes?|server|functions|edge[-_]functions|webhooks?|actions)(?:\/|$)/i;
const routeFile = /(?:^|\/)(?:route|\+server|server|middleware|[^/]*webhook[^/]*)\.[^/]+$/i;
export const isMigration = path => /(?:^|\/)migrations\/[^/]+\.sql$/i.test(path);
export function relevantPath(path) {
  return /\.sql$/i.test(path) || /(?:\.race|\.rule)\.json$/i.test(path) || path === 'viberaven.race.json' ||
    /^supabase\/functions\//i.test(path) || (source.test(path) && (routeDir.test(path) || routeFile.test(path)));
}

// ---------- reading CLI reports ----------

const json = text => { try { return JSON.parse(text); } catch { return undefined; } };
const count = value => Number.isSafeInteger(value) && value >= 0;

/** A reviewed race spec: two to four requests and an invariant query. */
export function readSpec(bytes) {
  const spec = json(bytes.toString('utf8').replace(/^﻿/, ''));
  if (typeof spec?.invariant !== 'string' || !Array.isArray(spec.requests) || spec.requests.length < 2 ||
      spec.requests.length > 4 || !spec.requests.every(r => Array.isArray(r?.statements) && r.statements.length)) return;
  return spec;
}

/** Proven only when the run loaded every migration, completed, and an executed order left the rule false. */
export function specVerdict(status, report) {
  if (!report || report.loads !== true || report.complete !== true || report.skippedMigrations?.length ||
      report.schemaConfidence === 'conditional' || !count(report.tested) || !count(report.broken) || report.tested === 0) {
    return { verdict: 'incomplete' };
  }
  if (status === 1 && report.status === 'broken' && report.broken > 0) {
    return { verdict: 'broken', tested: report.tested, broken: report.broken, firstBroken: report.firstBroken };
  }
  if (status === 0 && report.status === 'passed' && report.broken === 0) return { verdict: 'holds', tested: report.tested };
  return { verdict: 'incomplete' };
}

/** The first broken order, retold from the engine's own record of that run. */
export function brokenOrder(recordsText, k) {
  if (typeof recordsText !== 'string' || !count(k)) return;
  const row = recordsText.split('\n').map(json).find(entry => entry?.k === k);
  if (!row || row.ruleHolds !== false || !Array.isArray(row.trace)) return;
  const who = session => (session === 0 ? 'A' : session === 1 ? 'B' : session === 2 ? 'C' : 'D');
  const steps = [];
  for (const event of row.trace) {
    if (event.event === 'issue' && typeof event.sql === 'string' && !/^BEGIN\b/i.test(event.sql)) {
      steps.push(who(event.session) + ': ' + (/^COMMIT$/i.test(event.sql) ? 'COMMIT' : clip(event.sql, 160)));
    } else if (event.event === 'wait') steps.push(who(event.session) + ' waits for a lock held by the other request');
    else if (event.event === 'wake') steps.push(who(event.session) + ' resumes with what it had already read');
    else if (event.event === 'complete' && event.tag === 'ERR') steps.push(who(event.session) + ' fails (' + clip(String(event.code), 12) + ')');
  }
  return { isolation: String(row.iso), committed: row.committed, steps };
}

/** race --auto: proven only when a scenario ran on the full schema (not one completed from repository evidence). */
export function autoVerdict(report) {
  if (!report || !Array.isArray(report.results)) return { verdict: 'incomplete', notes: ['`race --auto` did not return a report.'] };
  const conditional = report.load?.conditional !== false;
  const broken = report.results.filter(r => r?.status === 'broken' && count(r.broken) && r.broken > 0 && count(r.tested));
  const notes = [];
  if (broken.length && !conditional) {
    return { verdict: 'broken', findings: broken.map(r => ({ id: String(r.id), tested: r.tested, broken: r.broken,
      requests: (r.requests ?? []).map(q => clip(String(q.sql ?? ''), 200)) })) };
  }
  if (broken.length) notes.push('`race --auto` saw a break on a schema completed from repository evidence. Treat it as a lead and confirm it with a reviewed rule.');
  const ran = report.results.filter(r => count(r?.tested) && r.tested > 0).length;
  const skipped = report.results.filter(r => r?.status === 'not_exercised');
  if (report.results.length) notes.push('`race --auto` inferred ' + report.results.length + ' two-request scenario(s); ' + ran + ' ran' +
    (skipped.length ? ', ' + skipped.length + ' could not run (' + clip(String(skipped[0].reason ?? 'no reason given'), 120) + ')' : '') + '.');
  else notes.push('`race --auto` found no two-request scenario to infer from the schema and functions.');
  return { verdict: ran && !broken.length && report.status === 'passed' ? 'holds' : 'incomplete', notes };
}

export function introducedFindings(report, base) {
  const introduced = report?.change?.findings?.introduced;
  if (report?.change?.baseCommit === undefined || !Array.isArray(introduced)) return;
  if (base && report.change.baseCommit !== base) return;
  return [...new Set(introduced.map(f => f?.id).filter(id => typeof id === 'string' && ruleId.test(id)))];
}

// ---------- proposing and verifying a fix ----------

const word = '[a-z_][a-z0-9_$]*';
const tableName = `(?:"?${word}"?\\.)?"?(${word})"?`;
const selectInto = new RegExp(
  `select\\s[^;]*?\\binto\\s+(?:strict\\s+)?[^;]*?\\bfrom\\s+${tableName}[^;]*?;`, 'gi');

/**
 * A read-then-write in one function: SELECT ... INTO ... FROM t ... ; followed later by UPDATE t in the same body.
 * The proposal adds FOR UPDATE to that SELECT, so the second request reads the row only after the first commits.
 * It is proposed only if the patched migrations make the same race rule hold.
 */
export function proposeRowLock(sql) {
  const bodies = [...sql.matchAll(/as\s+(\$[a-z_0-9]*\$)([\s\S]*?)\1/gi)];
  for (const body of bodies) {
    const text = body[2];
    const start = body.index + body[0].indexOf(text);
    for (const match of text.matchAll(selectInto)) {
      const statement = match[0];
      if (/\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b/i.test(statement)) continue;
      const table = match[1].toLowerCase();
      const later = text.slice(match.index + statement.length);
      if (!new RegExp(`\\bupdate\\s+(?:"?${word}"?\\.)?"?${table}"?\\s+set\\b`, 'i').test(later)) continue;
      const semicolon = start + match.index + statement.length - 1;
      const lineStart = sql.lastIndexOf('\n', semicolon) + 1;
      const indent = /^\s*/.exec(sql.slice(lineStart))[0];
      const patched = sql.slice(0, semicolon) + '\n' + indent + 'for update' + sql.slice(semicolon);
      const line = sql.slice(0, start + match.index).split('\n').length;
      return { table, line, patched,
        why: 'The function reads `' + table + '` into a variable, checks it, and later updates `' + table +
          '` from that stale value. `FOR UPDATE` locks the row on read, so a second request waits and then reads the committed value.' };
    }
  }
}

/** One unified-diff hunk for a single contiguous change. */
export function unifiedDiff(path, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, head - 3);
  const aEnd = Math.min(a.length, a.length - tail + 3);
  const bEnd = Math.min(b.length, b.length - tail + 3);
  const lines = [];
  for (let i = from; i < head; i++) lines.push(' ' + a[i]);
  for (let i = head; i < a.length - tail; i++) lines.push('-' + a[i]);
  for (let i = head; i < b.length - tail; i++) lines.push('+' + b[i]);
  for (let i = a.length - tail; i < aEnd; i++) lines.push(' ' + a[i]);
  const aCount = aEnd - from;
  const bCount = bEnd - from;
  return ['--- a/' + path, '+++ b/' + path, `@@ -${from + 1},${aCount} +${from + 1},${bCount} @@`, ...lines].join('\n');
}

// ---------- the report ----------

function clip(text, max) {
  const flat = String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
const code = text => '`' + String(text).replace(/`/g, "'") + '`';

export function render(result) {
  const { proven, notes, cli, seconds } = result;
  const lines = [];
  const title = proven.length
    ? proven.length + ' proven race' + (proven.length > 1 ? 's' : '') + ': ' + clip(proven[0].rule, 90)
    : result.skipped ? 'No database or server change in this PR' : 'No proven finding';
  if (result.skipped) lines.push(result.skipped);
  for (const [i, finding] of proven.entries()) {
    if (proven.length > 1) lines.push('### Finding ' + (i + 1));
    lines.push('**Proven:** ' + clip(finding.rule, 200), '',
      finding.broken + ' of ' + finding.tested + ' tested orders of two concurrent requests left the rule false (' + finding.isolation +
        ', PostgreSQL in-process, migrations at this commit). Rule file: ' + code(finding.spec) + '.');
    if (finding.order) {
      lines.push('', 'Broken order:', '', ...finding.order.steps.map((step, n) => (n + 1) + '. ' + step.replace(/[<>]/g, '')),
        '', 'Both requests committed and the rule query returned false: ' + code(clip(finding.invariant, 300)));
    }
    if (finding.fix?.verified) {
      lines.push('', '**Fix (verified):** ' + finding.fix.why, '',
        'With this patch the same rule held in ' + finding.fix.tested + ' of ' + finding.fix.tested + ' tested orders.', '',
        '```diff', finding.fix.diff, '```', '',
        'If this migration already ran in production, put the same change in a new migration instead of editing this one.');
    } else if (finding.fix) {
      lines.push('', '**Fix not verified:** adding `FOR UPDATE` at ' + code(finding.fix.path + ':' + finding.fix.line) + ' did not make the rule hold. Use the prompt below.');
    }
    lines.push('', '**For your coding agent:**', '', '```text', finding.prompt, '```');
  }
  if (notes.length) lines.push('', '### Notes (these do not fail the check)', '', ...notes.map(note => '- ' + note));
  lines.push('', '<sub>' + NAME + ' ' + cli + ' · ' + seconds.toFixed(1) + ' s · no secrets, no Docker · only proven two-request breaks fail this check. ' +
    'To add it to a repo, copy `.github/workflows/viberaven.yml` and `.github/actions/viberaven-check/`.</sub>');
  const machine = { tool: 'viberaven', cli, conclusion: proven.length ? 'failure' : 'success',
    proven: proven.map(f => ({ rule: f.rule, spec: f.spec, tested: f.tested, broken: f.broken, isolation: f.isolation,
      fix: f.fix?.verified ? { path: f.fix.path, diff: f.fix.diff, verifiedTested: f.fix.tested } : null,
      rerun: f.rerun })), notes };
  lines.push('', '<details><summary>Machine-readable result</summary>', '', '```json', JSON.stringify(machine, null, 1), '```', '', '</details>');
  return { title, text: lines.join('\n') };
}

function agentPrompt(finding, migrations) {
  const files = migrations.length ? migrations.join(', ') : 'the changed SQL';
  const lines = [
    'VibeRaven proved a two-request race in this PR. Rule: "' + clip(finding.rule, 200) + '".',
    finding.broken + ' of ' + finding.tested + ' tested orders broke it (' + finding.isolation + ').',
  ];
  if (finding.fix?.verified) {
    lines.push('Apply this verified patch to ' + finding.fix.path + ' (it adds FOR UPDATE to the read the function later writes back):', '',
      finding.fix.diff, '');
  } else {
    lines.push('Make the read-check-write in ' + files + ' atomic: either one conditional UPDATE ... WHERE <limit check> RETURNING ..., ' +
      'or SELECT ... FOR UPDATE on the row before the check. Keep the rule file unchanged.');
  }
  lines.push('Then run: ' + finding.rerun, 'Expect exit 0 and "0 broken". Commit the fix to this PR branch.');
  return lines.join('\n');
}

// ---------- running the pinned CLI ----------

function safeEnv(env, home) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'CI', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => keep.includes(key.toUpperCase())));
  return { ...clean, HOME: home, USERPROFILE: home, VIBERAVEN_TELEMETRY: '0', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' };
}

export async function installCli(directory, env, fetchImpl = fetch) {
  const response = await fetchImpl(CLI.tarball, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Pinned CLI tarball unavailable');
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 32 * 1024 * 1024) throw new Error('Pinned CLI tarball too large');
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== CLI.integrity) throw new Error('Pinned CLI failed its integrity check');
  const tarball = join(directory, 'cli.tgz');
  writeFileSync(tarball, archive);
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = existsSync(npmCli) ? [process.execPath, [npmCli]] : ['npm', []];
  const result = spawnSync(npm[0], [...npm[1], 'install', tarball, '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--omit=dev', '--prefix=' + directory, '--registry=https://registry.npmjs.org/',
    '--cache=' + join(directory, 'npm-cache'), '--userconfig=' + join(directory, 'user.npmrc')],
  { cwd: directory, env, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' && npm[0] === 'npm' });
  const entry = join(directory, 'node_modules', '@viberaven', 'cli', 'dist', 'cli.js');
  if (result.status !== 0 || !existsSync(entry)) throw new Error('Could not install the pinned CLI');
  return entry;
}

function runner(entry, env) {
  return (cwd, args, seconds) => {
    const child = spawnSync(process.execPath, [entry, ...args], {
      cwd, env, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    return { status: child.status, report: json(child.stdout ?? '') };
  };
}

// ---------- git ----------

function git(cwd, env, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function readPullRequest(env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return;
  const event = json(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event?.pull_request;
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !sha40.test(pr?.head?.sha ?? '') || !sha40.test(pr?.base?.sha ?? '')) return;
  return { repo, number: event.number, head: pr.head.sha, base: pr.base.sha,
    sameRepo: pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase() };
}

function findSpecs(workspace) {
  const found = [];
  for (const [folder, pattern] of specGlobs) {
    const dir = join(workspace, folder);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = (folder === '.' ? '' : folder + '/') + name;
      const info = lstatSync(join(workspace, path));
      if (!pattern.test(name) || !info.isFile() || info.size > 64 * 1024) continue;
      const spec = readSpec(readFileSync(join(workspace, path)));
      if (spec) found.push({ path, spec });
    }
  }
  return found.slice(0, MAX_SPECS);
}

// ---------- GitHub check run ----------

async function postCheckRun(env, pr, conclusion, title, text, annotations, fetchImpl = fetch) {
  const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const summary = text.length > 60_000 ? text.slice(0, 60_000) + '\n\n…truncated; see the job summary.' : text;
  const response = await fetchImpl(api + '/repos/' + pr.repo + '/check-runs', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.VR_TOKEN,
      'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ name: env.VR_CHECK_NAME || 'VibeRaven race', head_sha: pr.head, status: 'completed', conclusion,
      details_url: env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? env.GITHUB_SERVER_URL + '/' + pr.repo + '/actions/runs/' + env.GITHUB_RUN_ID : undefined,
      output: { title: clip(title, 240), summary, annotations: annotations.slice(0, 50) } }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('check run ' + response.status);
}

// ---------- main ----------

export async function runCheck(env, { fetchImpl = fetch, install = installCli } = {}) {
  const started = Date.now();
  const notes = [];
  const proven = [];
  const annotations = [];
  let skipped;
  const pr = readPullRequest(env);
  if (!pr) {
    skipped = 'VibeRaven check runs on `pull_request` events.';
  }
  const workspace = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const temp = mkdtempSync(join(realpathSync(env.RUNNER_TEMP ?? tmpdir()), 'viberaven-'));
  const childEnv = safeEnv(env, temp);
  let incomplete = false;
  try {
    let changes = [];
    if (pr) {
      if (git(workspace, childEnv, 'rev-parse', 'HEAD').trim() !== pr.head) throw new Error('Check out the PR head: actions/checkout with ref: ${{ github.event.pull_request.head.sha }}.');
      changes = git(workspace, childEnv, 'diff', '--name-only', '--no-renames', '-z', pr.base + '...' + pr.head).split('\0').filter(Boolean);
      if (!changes.some(relevantPath)) skipped = 'No migration, SQL, server route, Edge Function or race rule changed.';
    }
    if (!skipped) {
      const entry = await install(temp, childEnv);
      const run = runner(entry, childEnv);
      const migrations = changes.filter(isMigration);

      const auto = autoVerdict(run(workspace, ['race', '.', '--auto', '--json'], 150).report);
      notes.push(...(auto.notes ?? []));
      for (const finding of auto.findings ?? []) {
        proven.push({ rule: 'race --auto: ' + finding.id, spec: '(inferred by race --auto)', tested: finding.tested, broken: finding.broken,
          isolation: 'read committed', invariant: 'inferred rule', rerun: 'npx -y viberaven@' + CLI.version + ' race . --auto',
          order: { steps: finding.requests } });
      }

      const specs = findSpecs(workspace);
      if (!specs.length) notes.push('No reviewed race rule found (`viberaven.race.json` or `supabase/tests/*.rule.json`). Add one to test a specific business rule.');
      for (const [i, { path, spec }] of specs.entries()) {
        const out = join(temp, 'race-' + i + '.json');
        const { status, report } = run(workspace, ['race', '.', '--spec', path, '--out', out, '--json'], 90);
        const verdict = specVerdict(status, report);
        const rerun = 'npx -y viberaven@' + CLI.version + ' race . --spec ' + path;
        if (verdict.verdict === 'holds') {
          notes.push(code(path) + ': the rule held in ' + verdict.tested + ' of ' + verdict.tested + ' tested orders. This covers those orders only; it is not a proof for every order.');
          continue;
        }
        if (verdict.verdict !== 'broken') {
          incomplete = true;
          notes.push(code(path) + ': no verdict (' + clip(report?.summary ?? report?.failure?.message ?? 'the race did not complete', 160) + ').');
          continue;
        }
        const records = existsSync(join(temp, 'race-' + i + '.records.jsonl')) ? readFileSync(join(temp, 'race-' + i + '.records.jsonl'), 'utf8') : undefined;
        const finding = { rule: String(spec.rule ?? 'Race rule in ' + path), spec: path, tested: verdict.tested, broken: verdict.broken,
          isolation: (spec.isolation ?? ['read committed'])[0], invariant: spec.invariant, rerun,
          order: brokenOrder(records, verdict.firstBroken) };

        for (const file of migrations) {
          const before = readFileSync(join(workspace, file), 'utf8');
          const proposal = proposeRowLock(before);
          if (!proposal) continue;
          // Verify on a copy of this commit with the patch applied.
          const copy = join(temp, 'fix-' + i);
          mkdirSync(copy);
          git(workspace, childEnv, 'archive', '--format=tar', '-o', join(temp, 'fix-' + i + '.tar'), pr.head);
          // A relative archive path keeps tar from reading a drive letter as a remote host.
          const tar = spawnSync('tar', ['-xf', '../fix-' + i + '.tar'], { cwd: copy, env: childEnv, timeout: 30_000 });
          if (tar.status !== 0) break;
          writeFileSync(join(copy, file), proposal.patched);
          const check = run(copy, ['race', '.', '--spec', path, '--out', join(temp, 'fix-' + i + '.json'), '--json'], 90);
          const after = specVerdict(check.status, check.report);
          finding.fix = { path: file, line: proposal.line, why: proposal.why, verified: after.verdict === 'holds',
            tested: after.tested, diff: unifiedDiff(file, before, proposal.patched) };
          annotations.push({ path: file, start_line: proposal.line, end_line: proposal.line, annotation_level: 'failure',
            title: 'Proven race: ' + clip(finding.rule, 120),
            message: finding.broken + ' of ' + finding.tested + ' tested orders broke the rule.' +
              (finding.fix.verified ? ' Verified fix: add FOR UPDATE to this SELECT.' : '') });
          break;
        }
        if (!annotations.length && migrations[0]) {
          annotations.push({ path: migrations[0], start_line: 1, end_line: 1, annotation_level: 'failure',
            title: 'Proven race: ' + clip(finding.rule, 120), message: finding.broken + ' of ' + finding.tested + ' tested orders broke the rule.' });
        }
        finding.prompt = agentPrompt(finding, migrations);
        proven.push(finding);
      }
      for (const finding of proven) finding.prompt ??= agentPrompt(finding, migrations);

      const check = run(workspace, ['check', '.', '--base', pr.base, '--json'], 90).report;
      const ids = introducedFindings(check, pr.base);
      if (!ids) notes.push('`check --base` did not complete; static leads are unavailable for this run.');
      else if (!ids.length) notes.push('`check`: no new static findings compared with the base branch.');
      else notes.push('`check`: new static leads (not proven, review them): ' + ids.slice(0, 8).map(id =>
        code(id) + ' (`npx -y viberaven prompt --gap ' + id + ' --no-copy`)').join(', ') + '.');
    }
  } catch (error) {
    incomplete = true;
    notes.push('The check could not finish: ' + clip(error?.message ?? 'unknown error', 200));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const { title, text } = render({ proven, notes, cli: CLI.version, seconds: (Date.now() - started) / 1000, skipped });
  const conclusion = proven.length ? 'failure' : incomplete ? 'neutral' : 'success';
  const heading = '## ' + NAME + ' · ' + title;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, heading + '\n\n' + text + '\n');
  console.log(heading + '\n\n' + text);
  if (pr && env.VR_TOKEN && pr.sameRepo) {
    try { await postCheckRun(env, pr, conclusion, title, text, annotations, fetchImpl); }
    catch (error) { console.log('::warning::Could not post the VibeRaven check run (' + clip(error.message, 80) + '). The job result and summary still apply.'); }
  }
  return proven.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCheck(process.env);
}
