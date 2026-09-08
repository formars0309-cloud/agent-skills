#!/usr/bin/env node
// 보호자 노트 3·6단계 독립 검수 실행기(2026-09-08 판정·종료 방식 개선).
// 새 codex exec 비저장 세션을 읽기 전용으로 띄우고, 실행 전 입력 검증 → 반복 상한 확인 → 실행 → 종료 상태·판정 JSON 회수까지
// 유한 시간 안에 끝낸다. 무제한 대기, 부분 기록, 종료 코드 날조를 하지 않는다.
//
// 사용법(저장소 루트에서):
//   node <스킬>/scripts/run-audit.mjs <slug> --kind stage3|final-fact|final-value --input <입력 폴더> [--focus "<중립 점검 범위>"]
//        [--timeout-min 45] [--after-hold] [--dry-run]
// 입력 폴더: brief.md, draft.md, prompt.txt, sources/manifest.json (+ 원천 파일). 검수자는 이 폴더만 본다.
// 종료 코드: 0 통과 · 2 수정 후 확인 · 3 반려 · 4 반복 상한 소진(보류 반환) · 5 입력 검증 실패(CLI 미시작) · 6 실행 보류
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_KINDS, MAX_CONTENT_ATTEMPTS, MAX_INFRA_RETRIES, articleSha, checkFrontmatterLimits, hashTree, openFindings,
  outputContract, parseVerdict, processStart, readJson, runnerAudits, schemaLimits, sha256, writeJsonAtomic,
} from './audit-utils.mjs';

const args = process.argv.slice(2);
const VALUE_FLAGS = ['--kind', '--input', '--focus', '--timeout-min'];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])));
const slug = positional[0];
const kind = flag('--kind');
const inputDir = flag('--input') ? resolve(flag('--input')) : null;
const focus = flag('--focus');
const timeoutMin = Number(flag('--timeout-min') || 45);
const afterHold = args.includes('--after-hold');
const dryRun = args.includes('--dry-run');

function fail(code, message) { console.error(`[검수 실행기] ${message}`); process.exit(code); }
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !AUDIT_KINDS.includes(kind) || !inputDir) {
  fail(5, '사용법: run-audit.mjs <slug> --kind stage3|final-fact|final-value --input <폴더> [--focus ...] [--timeout-min 45] [--after-hold] [--dry-run]');
}

const root = process.cwd();
const auditsDir = join(root, 'content-work', slug, 'audits');
const sitePath = join(root, 'src', 'content', 'guides', `${slug}.md`);

// ---------- 1. 실행 전 입력 검증: 실패하면 다음 명령을 실행하지 않는다 ----------
const problems = [];
for (const name of ['brief.md', 'draft.md', 'prompt.txt', 'sources/manifest.json']) {
  if (!existsSync(join(inputDir, name))) problems.push(`입력 폴더에 ${name}이 없습니다.`);
}
let manifest = null;
if (existsSync(join(inputDir, 'sources', 'manifest.json'))) {
  manifest = readJson(join(inputDir, 'sources', 'manifest.json'));
  if (!manifest) problems.push('sources/manifest.json을 JSON으로 읽지 못했습니다.');
  else {
    const entries = Array.isArray(manifest) ? manifest : Array.isArray(manifest.files) ? manifest.files : Array.isArray(manifest.sources) ? manifest.sources : [];
    for (const entry of entries) {
      const file = typeof entry === 'string' ? entry : entry?.file ?? entry?.path ?? entry?.filename;
      if (file && !existsSync(join(inputDir, 'sources', file)) && !existsSync(join(inputDir, file))) problems.push(`manifest가 가리키는 원천 파일이 없습니다: ${file}`);
    }
  }
}
let draftRaw = '';
if (existsSync(join(inputDir, 'draft.md'))) {
  draftRaw = readFileSync(join(inputDir, 'draft.md'), 'utf8');
  const { limits, source } = schemaLimits(join(root, 'src', 'content.config.ts'));
  for (const p of checkFrontmatterLimits(draftRaw, limits)) problems.push(`draft.md 프론트매터: ${p} (기준 ${source})`);
}
let siteArticleShaValue = null;
if (kind !== 'stage3') {
  if (!existsSync(sitePath)) problems.push(`${kind} 검수는 사이트 정본 src/content/guides/${slug}.md가 있어야 합니다(draft.md와 동일해야 함).`);
  else {
    siteArticleShaValue = articleSha(readFileSync(sitePath, 'utf8'));
    if (draftRaw && articleSha(draftRaw) !== siteArticleShaValue) problems.push('draft.md가 사이트 정본과 다릅니다(draft 상태 제외). 최종 검수 입력은 정본과 같아야 합니다.');
  }
}
const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' });
if (codexVersion.status !== 0) problems.push('codex CLI를 실행하지 못했습니다.');
if (problems.length) {
  console.error('[검수 실행기] 입력 검증 실패 — Codex를 시작하지 않습니다.');
  for (const p of problems) console.error('  - ' + p);
  process.exit(5);
}

// ---------- 2. 반복 상한 ----------
mkdirSync(auditsDir, { recursive: true });
const prior = runnerAudits(auditsDir, kind);
const completed = prior.filter((a) => ['completed', 'confirmed'].includes(a.execution.status));
const lastCompletedIndex = prior.findLastIndex((a) => ['completed', 'confirmed'].includes(a.execution.status));
const infraSinceLast = prior.slice(lastCompletedIndex + 1).filter((a) => ['lost', 'timeout', 'failed', 'aborted'].includes(a.execution.status));
const running = prior.filter((a) => a.execution.status === 'running');
if (running.length) fail(6, `실행 중으로 기록된 검수가 있습니다: ${running.map((a) => a.name).join(', ')}. 먼저 audit-status.mjs로 생존 여부를 확인하세요.`);
const holdResolved = join(auditsDir, `${kind}-hold-resolved.md`);
const holdPath = join(auditsDir, `${kind}-hold.md`);
function returnHold(reason) {
  const last = completed.at(-1)?.execution;
  const lines = [
    `# ${kind} 검수 보류 반환 — ${new Date().toISOString()}`, '',
    `- 사유: ${reason}`,
    `- 내용 검수 회차: ${completed.length} (상한 ${MAX_CONTENT_ATTEMPTS}) · 마지막 완료 뒤 인프라 실패: ${infraSinceLast.length} (상한 ${MAX_INFRA_RETRIES})`,
    `- 마지막 판정: ${last?.verdict ?? '없음'} (${last?.runDir ?? '-'})`, '',
    '## 남은 차단·필수 수정 사항', '',
    ...(last ? openFindings(last).map((f) => `- ${f.id} [${f.severity}·${f.kind}] ${f.location} — ${f.problem} / 근거: ${f.basis} / 조치: ${f.action}`) : ['- 기록 없음']),
    '', '## 재개 조건', '',
    '- 위 사항의 원인과 수정 범위를 정리하고, 중요 오류 수정·원천 보완이 끝난 뒤 사용자 지시로 새 작업을 시작한다.',
    `- 재개할 때는 \`${kind}-hold-resolved.md\`에 재개 사유를 적고 \`--after-hold\`로 실행한다. 자동 통과·계속 반복은 금지.`,
    '',
  ];
  writeFileSync(holdPath, lines.join('\n'), 'utf8');
  console.error(`[검수 실행기] 반복 상한 소진 — main에 보류 반환. 요약: content-work/${slug}/audits/${kind}-hold.md`);
  process.exit(4);
}
if (!(afterHold && existsSync(holdResolved))) {
  if (completed.length >= MAX_CONTENT_ATTEMPTS) returnHold(`내용 검수 ${completed.length}회(최초 1회 + 재검수 ${MAX_CONTENT_ATTEMPTS - 1}회) 소진`);
  if (infraSinceLast.length >= MAX_INFRA_RETRIES) returnHold(`인프라 실패 재시도 ${infraSinceLast.length}회 소진`);
} else if (afterHold) {
  console.log(`[검수 실행기] 보류 해제 기록 확인: ${holdResolved}`);
}

// ---------- 3. 실행 폴더(고유 경로)와 기록 ----------
let seq = prior.length + 1;
let runName = `${kind}-r${seq}`;
while (existsSync(join(auditsDir, runName))) { seq += 1; runName = `${kind}-r${seq}`; }
const runDir = join(auditsDir, runName);
const executionPath = join(runDir, 'execution.json');
const promptRaw = readFileSync(join(inputDir, 'prompt.txt'), 'utf8');
const prompt = promptRaw.trimEnd() + '\n' + outputContract({ kind, focus });
const configText = (() => { try { return readFileSync(join(process.env.HOME || '', '.codex', 'config.toml'), 'utf8'); } catch { return ''; } })();
const modelMatch = configText.match(/^model\s*=\s*"([^"]+)"/m);
const before = hashTree(inputDir);
const startedAt = new Date().toISOString();
const deadlineAt = new Date(Date.now() + timeoutMin * 60000).toISOString();
const execution = {
  schemaVersion: 1, kind, slug, runDir: `content-work/${slug}/audits/${runName}`, attempt: completed.length + 1,
  status: 'running', startedAt, deadlineAt, timeoutMin, focus: focus ?? null,
  runnerPid: process.pid, runnerStart: processStart(process.pid), codexPid: null, codexStart: null,
  model: modelMatch ? modelMatch[1] : 'CLI default', cliVersion: codexVersion.stdout.trim(),
  inputDirectory: inputDir, before, promptSha256: sha256(prompt),
  inputs: { draftArticleSha: articleSha(draftRaw), siteArticleSha: siteArticleShaValue, briefSha256: before['brief.md'] ?? null },
  prompt: join(runDir, 'prompt.txt'), rawOutput: join(runDir, 'raw.jsonl'), verdictFile: join(runDir, 'verdict.md'),
};
if (dryRun) { console.log(JSON.stringify({ dryRun: true, runName, attempt: execution.attempt, promptSha256: execution.promptSha256 }, null, 2)); process.exit(0); }
mkdirSync(runDir);
writeFileSync(join(runDir, 'prompt.txt'), prompt, 'utf8');
writeJsonAtomic(executionPath, execution);

// ---------- 4. 실행: 타임아웃·신호·예외를 모두 기록한다 ----------
const rawFd = openSync(join(runDir, 'raw.jsonl'), 'w');
const errFd = openSync(join(runDir, 'stderr.txt'), 'w');
const child = spawn('codex', ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-C', inputDir, '-o', join(runDir, 'verdict.md'), '-'],
  { stdio: ['pipe', rawFd, errFd] });
execution.codexPid = child.pid;
execution.codexStart = processStart(child.pid);
writeJsonAtomic(executionPath, execution);
child.stdin.end(prompt);

let finished = false;
function finalize(status, extra = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { closeSync(rawFd); } catch {}
  try { closeSync(errFd); } catch {}
  Object.assign(execution, { status, endedAt: new Date().toISOString() }, extra);
  try {
    execution.after = hashTree(inputDir);
    execution.inputUnchanged = JSON.stringify(execution.after) === JSON.stringify(before);
  } catch (error) { execution.inputUnchanged = false; execution.hashError = error.message; }
  try {
    const rawLines = readFileSync(join(runDir, 'raw.jsonl'), 'utf8').split('\n');
    for (const line of rawLines) { try { const j = JSON.parse(line); if (j.type === 'thread.started') execution.sessionId = j.thread_id; } catch {} }
  } catch {}
  writeJsonAtomic(executionPath, execution);
}
function killChild(signal = 'SIGTERM') {
  try { child.kill(signal); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref();
}
const timer = setTimeout(() => {
  killChild();
  finalize('timeout', { reason: `제한 시간 ${timeoutMin}분 초과`, exitCode: null });
  console.error(`[검수 실행기] 실행 보류: 제한 시간 초과. 기록 ${execution.runDir}/execution.json`);
  process.exit(6);
}, timeoutMin * 60000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killChild(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    finalize('aborted', { reason: `실행기가 ${signal} 신호로 종료됨`, exitCode: null });
    process.exit(6);
  });
}
process.on('uncaughtException', (error) => {
  killChild();
  finalize('failed', { reason: `실행기 예외: ${error.message}`, exitCode: null });
  process.exit(6);
});

child.on('error', (error) => {
  finalize('failed', { reason: `codex 실행 실패: ${error.message}`, exitCode: null });
  console.error('[검수 실행기] 실행 보류: ' + error.message);
  process.exit(6);
});
child.on('close', (code, signal) => {
  if (finished) return;
  const exitCode = typeof code === 'number' ? code : null;
  if (exitCode !== 0) {
    finalize('failed', { reason: signal ? `codex가 ${signal}로 종료됨` : `codex 종료 코드 ${exitCode}`, exitCode, signal: signal ?? null });
    console.error(`[검수 실행기] 실행 보류: ${execution.reason}. 기록 ${execution.runDir}/execution.json`);
    process.exit(6);
  }
  let verdictRaw = '';
  try { verdictRaw = readFileSync(join(runDir, 'verdict.md'), 'utf8'); } catch {}
  const parsed = parseVerdict(verdictRaw);
  if (!parsed.ok) {
    finalize('failed', { reason: `판정 출력 계약 위반: ${parsed.error}`, exitCode });
    console.error(`[검수 실행기] 실행 보류: ${execution.reason}. 원출력은 보존됨.`);
    process.exit(6);
  }
  finalize('completed', {
    exitCode, verdict: parsed.value.verdict, findings: parsed.value.findings, summary: parsed.value.summary ?? '',
    verdictSha256: sha256(verdictRaw),
  });
  const inputNote = execution.inputUnchanged ? '일치' : '불일치(실행 중 입력 변경 → 보류)';
  if (!execution.inputUnchanged) { execution.status = 'failed'; execution.reason = '실행 중 입력이 바뀜'; writeJsonAtomic(executionPath, execution); }
  const open = openFindings(execution);
  console.log(JSON.stringify({ runDir: execution.runDir, status: execution.status, verdict: execution.verdict, attempt: execution.attempt,
    findings: execution.findings.length, blocking: open.filter((f) => f.severity === '차단').length, required: open.filter((f) => f.severity === '필수 수정').length,
    mechanicalOnly: open.length > 0 && open.every((f) => f.kind === '기계 대조'), sessionId: execution.sessionId ?? null }));
  console.log('\n[단계 기록에 옮길 실행 기록]');
  console.log([
    `- 회차: ${execution.attempt} (상한 ${MAX_CONTENT_ATTEMPTS})`,
    `- 세션 ID 또는 비저장 실행 ID/PID: ${execution.sessionId ?? '없음'} / runner ${execution.runnerPid} / codex ${execution.codexPid}`,
    `- 모델·CLI 버전: ${execution.model} · ${execution.cliVersion}`,
    `- 시작·종료 시각: ${execution.startedAt} ~ ${execution.endedAt}`,
    `- 입력 파일·SHA-256: draft.md ${before['draft.md']} · brief.md ${before['brief.md']} · 원고 정규화 SHA ${execution.inputs.draftArticleSha}`,
    `- 프롬프트·원출력 경로: ${execution.runDir}/prompt.txt · ${execution.runDir}/raw.jsonl · 판정 ${execution.runDir}/verdict.md`,
    `- 종료 코드·입력 SHA 재대조: ${exitCode} · ${inputNote}`,
    '- 이전 대화 인계: 없음',
    `- 판정: ${execution.verdict}`,
  ].join('\n'));
  if (execution.status !== 'completed') process.exit(6);
  process.exit(execution.verdict === '통과' ? 0 : execution.verdict === '수정 후 확인' ? 2 : 3);
});
