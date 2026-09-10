#!/usr/bin/env node
// 검수 실행 감독(2026-09-08). 실행기가 기록할 수 없는 종료(SIGKILL, 터미널 소실)를 탐지하고, 유한 시간 안에 대기를 끝낸다.
//
// 사용법(저장소 루트에서):
//   node <스킬>/scripts/audit-status.mjs <slug> [--json]                 실행 기록 전체 상태. 죽은 runner는 lost로 표시
//   node <스킬>/scripts/audit-status.mjs <slug> --wait <실행 폴더 이름> [--timeout-min N]   그 실행이 끝날 때까지 상한을 두고 대기
// 종료 코드: 0 대기 대상이 completed/confirmed · 6 lost/timeout/failed/aborted 또는 대기 상한 초과 · 5 인자 오류
import { join } from 'node:path';
import { MAX_CONTENT_ATTEMPTS, openFindings, readJson, reconcileAudits as reconcile, runnerAudits } from './audit-utils.mjs';

const args = process.argv.slice(2);
const VALUE_FLAGS = ['--wait', '--timeout-min'];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const slug = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])));
const waitName = flag('--wait');
const timeoutMin = flag('--timeout-min') ? Number(flag('--timeout-min')) : null;
const asJson = args.includes('--json');
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { console.error('사용법: audit-status.mjs <slug> [--wait <실행 폴더>] [--timeout-min N] [--json]'); process.exit(5); }
// NaN/Infinity나 누락된 값으로 마감 비교가 무력화되지 않게 대기 전에 검사한다.
if (args.includes('--timeout-min') && (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 45)) {
  console.error('--timeout-min은 0보다 크고 45 이하인 유한한 분 값이어야 합니다.'); process.exit(5);
}
if (args.includes('--wait') && (!waitName || !/^(stage3|final-fact|final-value)-r[1-9]\d*$/.test(waitName))) {
  console.error('--wait에는 stage3-r1처럼 실행 폴더 이름을 지정하세요.'); process.exit(5);
}
const auditsDir = join(process.cwd(), 'content-work', slug, 'audits');
function report() {
  const changed = reconcile(auditsDir);
  const rows = runnerAudits(auditsDir).map((item) => ({
    run: item.name, kind: item.execution.kind, attempt: item.execution.attempt, status: item.execution.status, verdict: item.execution.verdict ?? null,
    open: item.execution.status === 'confirmed' ? 0 : item.execution.findings ? openFindings(item.execution).length : null, startedAt: item.execution.startedAt, endedAt: item.execution.endedAt ?? null, reason: item.execution.reason ?? null,
  }));
  if (asJson) console.log(JSON.stringify({ changed, runs: rows }, null, 2));
  else {
    if (changed.length) console.log(`[소실 확정] ${changed.join(', ')}`);
    for (const r of rows) console.log(`${r.run.padEnd(18)} ${r.status.padEnd(10)} 회차 ${r.attempt}/${MAX_CONTENT_ATTEMPTS}  판정 ${r.verdict ?? '-'}  미결 ${r.open ?? '-'}  ${r.reason ?? ''}`);
    if (!rows.length) console.log('실행기 기록 없음');
  }
  return rows;
}

if (!waitName) { report(); process.exit(0); }

const path = join(auditsDir, waitName, 'execution.json');
const first = readJson(path);
if (!first) { console.error(`실행 기록이 없습니다: ${path}`); process.exit(5); }
const now = Date.now();
const deadline = Date.parse(first.deadlineAt);
if (first.status === 'running' && !Number.isFinite(deadline)) {
  console.error('실행 마감이 없거나 잘못됐습니다. 대기를 시작하지 않고 실행 보류로 반환합니다.'); process.exit(6);
}
// 재호출해도 기록된 마감(+정리 유예 5분)을 넘겨 새 대기 창을 만들지 않는다.
const bound = Math.min(now + (timeoutMin ?? 45) * 60000, Number.isFinite(deadline) ? deadline + 5 * 60000 : now);
while (true) {
  reconcile(auditsDir);
  const e = readJson(path);
  if (e && e.status !== 'running') {
    const ok = ['completed', 'confirmed'].includes(e.status);
    console.log(JSON.stringify({ run: waitName, status: e.status, verdict: e.verdict ?? null, reason: e.reason ?? null, endedAt: e.endedAt ?? null }));
    process.exit(ok ? 0 : 6);
  }
  if (Date.now() > bound) {
    console.error(`[감독] 대기 상한 도달 — ${waitName}은 아직 running 기록입니다. 실행 보류로 처리하세요.`);
    process.exit(6);
  }
  await new Promise((r) => setTimeout(r, Math.max(1, Math.min(10000, bound - Date.now()))));
}
