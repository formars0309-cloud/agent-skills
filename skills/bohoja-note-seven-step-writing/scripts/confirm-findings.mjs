#!/usr/bin/env node
// 「수정 후 확인」 판정의 기계 대조 종결(2026-09-08). 행 번호·메타데이터·글자 수처럼 기계 대조로 검증되는 지적만
// 수정·대조 증거로 닫는다. 사실의 의미가 달라지는 수정(kind 내용)이나 차단 지적은 여기서 닫을 수 없고 새 독립 검수가 필요하다.
//
// 사용법(저장소 루트에서):
//   node <스킬>/scripts/confirm-findings.mjs <slug> --run <실행 폴더 이름> --input <수정 반영된 입력 폴더> --method "<대조 방법과 결과>"
// 종료 코드: 0 확인 종결 · 3 종결 불가(차단 또는 내용 수정 남음 → 새 검수 필요) · 5 인자·상태 오류
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { articleSha, hashTree, openFindings, readJson, writeJsonAtomic } from './audit-utils.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const slug = args[0];
const runName = flag('--run');
const inputDir = flag('--input') ? resolve(flag('--input')) : null;
const method = flag('--method');
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !runName || !inputDir || !method) {
  console.error('사용법: confirm-findings.mjs <slug> --run <실행 폴더> --input <폴더> --method "<대조 방법>"'); process.exit(5);
}
const root = process.cwd();
const runDir = join(root, 'content-work', slug, 'audits', runName);
const executionPath = join(runDir, 'execution.json');
const e = readJson(executionPath);
if (!e || e.schemaVersion < 1) { console.error('실행기 기록이 아닙니다: ' + executionPath); process.exit(5); }
if (e.status !== 'completed' || e.verdict !== '수정 후 확인') { console.error(`확인 종결은 completed·수정 후 확인 기록에만 적용됩니다(현재 ${e.status}·${e.verdict ?? '-'}).`); process.exit(5); }

const open = openFindings(e);
const blocking = open.filter((f) => f.severity === '차단');
const contentRequired = open.filter((f) => f.kind === '내용');
if (blocking.length || contentRequired.length) {
  console.error('[확인 종결 불가] 새 독립 검수가 필요한 지적이 남아 있습니다.');
  for (const f of [...blocking, ...contentRequired]) console.error(`  - ${f.id} [${f.severity}·${f.kind}] ${f.location} — ${f.problem}`);
  process.exit(3);
}

const after = hashTree(inputDir);
const draftRaw = readFileSync(join(inputDir, 'draft.md'), 'utf8');
const draftArticleSha = articleSha(draftRaw);
let siteArticleSha = null;
if (e.kind !== 'stage3') {
  const sitePath = join(root, 'src', 'content', 'guides', `${slug}.md`);
  if (!existsSync(sitePath)) { console.error('사이트 정본이 없습니다: ' + sitePath); process.exit(5); }
  siteArticleSha = articleSha(readFileSync(sitePath, 'utf8'));
  if (siteArticleSha !== draftArticleSha) { console.error('수정된 draft.md가 사이트 정본과 다릅니다. 정본을 먼저 맞추세요.'); process.exit(5); }
}
const changedFiles = Object.keys({ ...e.before, ...after }).filter((k) => e.before[k] !== after[k]).sort();
const confirmation = {
  confirmedAt: new Date().toISOString(), method, findingIds: open.map((f) => f.id), changedFiles,
  inputsBefore: { draftArticleSha: e.inputs?.draftArticleSha ?? null, draft: e.before['draft.md'], brief: e.before['brief.md'] },
  inputsAfter: { draftArticleSha, siteArticleSha, draft: after['draft.md'], brief: after['brief.md'] },
};
writeJsonAtomic(join(runDir, 'confirmation.json'), confirmation);
Object.assign(e, { status: 'confirmed', confirmation });
writeJsonAtomic(executionPath, e);
console.log(JSON.stringify({ run: runName, status: 'confirmed', closed: confirmation.findingIds, changedFiles, draftArticleSha }));
console.log(`- 확인 종결: ${confirmation.findingIds.join(', ')} · 방법: ${method} · 원고 정규화 SHA ${draftArticleSha}`);
