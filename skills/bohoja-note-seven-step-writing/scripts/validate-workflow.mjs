#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CONTENT_ATTEMPTS, articleSha, openFindings, reconcileAudits, runnerAudits } from './audit-utils.mjs';

const args = process.argv.slice(2);
const slug = args.find((arg) => !arg.startsWith('--'));
const readyToPublish = args.includes('--ready-to-publish');
const useStandingPublication = args.includes('--standing-publication');

if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error('사용법: node validate-workflow.mjs <영문-kebab-slug> [--ready-to-publish] [--standing-publication]');
  process.exit(1);
}

const required = [
  ['01-question-and-evidence.md', ['## 원천 우위 테스트', '## 의료·제도 경계', '## 주장별 근거표', '## 미정·상충·보류']],
  ['02-evidence-bound-draft.md', ['## 전체 초안', '## 근거 ID 연결']],
  ['03-source-trace-audit.md', ['## 원천 대조 감사', '## 번호형 지적표', '## 판정:']],
  ['04-improved-draft.md', ['## 개선된 전체 원고', '## 평가 과제 반영표']],
  ['05-final-edited.md', ['## 완결된 전체 본문', '## 보호자 언어 편집 판단']],
  ['06-prepublish-audit.md', ['## 사실 감사', '## 가치·밀도 감사', '## 독립 검수 기록', '## 자동 감사 최종 판정:', '## 의료인 승인:', '## 공개 승인:']],
];

const errors = [];
const warnings = [];
const dir = join('content-work', slug);
const stageRaw = new Map();

for (const [name, headings] of required) {
  const path = join(dir, name);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    errors.push(`${path}: 파일이 없습니다.`);
    continue;
  }
  stageRaw.set(name, raw);
  for (const heading of headings) {
    if (!raw.includes(heading)) errors.push(`${path}: 필수 절 "${heading}"이 없습니다.`);
  }
  if (raw.length < 400) warnings.push(`${path}: 내용이 ${raw.length}자로 짧습니다. 빈 템플릿인지 확인하세요.`);
}

const planRaw = stageRaw.get('01-question-and-evidence.md') ?? '';
if (planRaw && !/## 2단계 진행 여부:\s*진행\s*(?:\r?\n|$)/.test(planRaw)) {
  errors.push(`${join(dir, '01-question-and-evidence.md')}: 2단계 진행 여부가 진행이 아닙니다.`);
}

const traceRaw = stageRaw.get('03-source-trace-audit.md') ?? '';
if (traceRaw && !/## 판정:\s*통과\s*(?:\r?\n|$)/.test(traceRaw)) {
  errors.push(`${join(dir, '03-source-trace-audit.md')}: 원천 대조 감사 판정이 통과가 아닙니다.`);
}

const finalPath = join('src', 'content', 'guides', `${slug}.md`);
let finalRaw = '';
try {
  finalRaw = await readFile(finalPath, 'utf8');
} catch {
  errors.push(`${finalPath}: 7단계 사이트 정본이 없습니다.`);
}

if (finalRaw) {
  const fields = [
    'title:', 'description:', 'quickAnswer:', 'readerQuestion:', 'addedValue:',
    'decision:', 'category:', 'pubDate:', 'verifiedOn:', 'verificationMethod:',
    'sources:', 'draft:',
  ];
  for (const field of fields) {
    if (!finalRaw.includes(`\n${field}`) && !finalRaw.startsWith(field)) {
      errors.push(`${finalPath}: 프론트매터 필드 "${field}"가 없습니다.`);
    }
  }
}

let reviewRaw = '';
reviewRaw = stageRaw.get('06-prepublish-audit.md') ?? '';

if (reviewRaw && !/## 자동 감사 최종 판정:\s*통과/.test(reviewRaw)) {
  errors.push(`${join(dir, '06-prepublish-audit.md')}: 자동 감사 최종 판정이 통과가 아닙니다.`);
}

if (reviewRaw) {
  // 제목 행이 정확히 일치하는 절만 본다("## 사실 감사 새 터미널·새 세션 실행 기록" 같은 이웃 절과 섞이지 않게).
  const section = (heading) => {
    const m = reviewRaw.replace(/\r\n/g, '\n').match(new RegExp(`^## ${heading}\\s*$\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    return m ? m[1] : '';
  };
  const factReview = section('사실 감사');
  const valueReview = section('가치·밀도 감사');
  if (!/### 판정:\s*통과\s*(?:\r?\n|$)/.test(factReview)) {
    errors.push(`${join(dir, '06-prepublish-audit.md')}: 사실 감사 판정이 통과가 아닙니다.`);
  }
  if (!/### 판정:\s*통과\s*(?:\r?\n|$)/.test(valueReview)) {
    errors.push(`${join(dir, '06-prepublish-audit.md')}: 가치·밀도 감사 판정이 통과가 아닙니다.`);
  }
}

// ---------------------------------------------------------------------------
// 독립 검수 실행 기록(2026-09-08 판정·종료 방식 개선). 실행기(run-audit.mjs)가 만든 기록만 계약 대상이다.
// 과거 ad hoc 기록(schemaVersion 없음)은 이력으로만 보고 재분류하지 않는다.
const auditsDir = join(dir, 'audits');
if (existsSync(auditsDir)) {
  const lost = reconcileAudits(auditsDir);
  if (lost.length) warnings.push(`${auditsDir}: 실행 기록만 있고 프로세스가 없는 검수를 lost로 확정했습니다: ${lost.join(', ')}`);
  const siteSha = finalRaw ? articleSha(finalRaw) : null;
  for (const kind of ['stage3', 'final-fact', 'final-value']) {
    const runs = runnerAudits(auditsDir, kind);
    if (!runs.length) { warnings.push(`${auditsDir}: ${kind} 실행기 기록이 없습니다. 단계 파일의 판정만 검사합니다(과거 방식).`); continue; }
    const label = `${auditsDir}/${kind}`;
    const running = runs.filter((r) => r.execution.status === 'running');
    if (running.length) errors.push(`${label}: 아직 실행 중으로 기록된 검수가 있습니다(${running.map((r) => r.name).join(', ')}). 완료 전에는 통과할 수 없습니다.`);
    const completed = runs.filter((r) => ['completed', 'confirmed'].includes(r.execution.status));
    if (completed.length > MAX_CONTENT_ATTEMPTS && !existsSync(join(auditsDir, `${kind}-hold-resolved.md`))) {
      errors.push(`${label}: 내용 검수 ${completed.length}회로 상한 ${MAX_CONTENT_ATTEMPTS}회를 넘겼는데 보류 해제 기록(${kind}-hold-resolved.md)이 없습니다.`);
    }
    const last = runs.at(-1);
    const e = last.execution;
    if (['lost', 'timeout', 'failed', 'aborted'].includes(e.status)) {
      errors.push(`${label}: 마지막 실행 ${last.name}이 실행 보류(${e.status}: ${e.reason ?? '사유 없음'})입니다. 새 검수 없이 통과할 수 없습니다.`);
      continue;
    }
    if (e.status === 'completed' && e.verdict !== '통과') {
      errors.push(`${label}: 마지막 판정이 ${e.verdict}입니다(${last.name}). ${e.verdict === '수정 후 확인' ? '기계 대조 종결(confirm-findings.mjs)이나 새 검수가 필요합니다.' : '차단 지적을 해소한 새 검수가 필요합니다.'}`);
    }
    if (e.status === 'confirmed') {
      const open = openFindings(e);
      if (open.some((f) => f.severity === '차단' || f.kind === '내용')) errors.push(`${label}: 확인 종결 기록에 차단·내용 수정 지적이 섞여 있습니다.`);
    }
    // SHA 변경 → 이전 판정 오용 금지. 최종 검수는 현재 사이트 정본과 같은 원고를 봤어야 한다.
    if (kind !== 'stage3' && siteSha) {
      const judged = e.status === 'confirmed' ? e.confirmation?.inputsAfter?.draftArticleSha : e.inputs?.draftArticleSha;
      if (judged && judged !== siteSha) errors.push(`${label}: 검수한 원고 SHA(${judged.slice(0, 12)}…)가 현재 정본(${siteSha.slice(0, 12)}…)과 다릅니다. 예전 판정을 새 원고의 통과로 쓸 수 없습니다.`);
    }
  }
}

const medicalApproved = /## 의료인 승인:\s*승인\s*(?:\r?\n|$)/.test(reviewRaw);
const publicationApproved = /## 공개 승인:\s*승인\s*(?:\r?\n|$)/.test(reviewRaw);
// 상시 발행은 개별 임상 승인의 증거가 아니다. 명시적인 저장소 사용자 지시와 기록을 함께 요구한다.
const agentRules = existsSync('AGENTS.md') ? await readFile('AGENTS.md', 'utf8') : '';
const standingAuthorized = useStandingPublication
  && agentRules.includes('내가 글쓰기를 지시하면 항상 발행까지 완료해줘')
  && /## 상시 발행 지시 적용:\s*적용\s*(?:\r?\n|$)/.test(reviewRaw)
  && /## 의료인 승인:\s*대기\s*(?:\r?\n|$)/.test(reviewRaw)
  && reviewRaw.includes('개별 임상 검토: 미수행');
if (useStandingPublication && !standingAuthorized) errors.push('상시 발행 사용자 지시 또는 개별 임상 검토 상태 기록이 불완전합니다.');
if (standingAuthorized) console.log('[승인 구분] 사용자 상시 발행 지시 적용. 개별 임상 검토·의료인 승인은 대기이며 통과로 바꾸지 않습니다.');
const isDraft = /\ndraft:\s*true\s*(?:\r?\n|$)/.test(finalRaw);
const isPublished = /\ndraft:\s*false\s*(?:\r?\n|$)/.test(finalRaw);

if (finalRaw) {
  if (readyToPublish) {
    if (!medicalApproved && !standingAuthorized) errors.push('의료인 승인이 기록되지 않았습니다.');
    if (!publicationApproved) errors.push('공개 승인이 기록되지 않았습니다.');
    if (!isPublished) errors.push(`${finalPath}: 발행 준비 검사에는 draft: false가 필요합니다.`);
  } else {
    if (!medicalApproved && !standingAuthorized && !isDraft) errors.push(`${finalPath}: 의료인 승인 전에는 draft: true여야 합니다.`);
    if (isPublished && !publicationApproved) errors.push(`${finalPath}: 공개 승인 없이 draft: false입니다.`);
    if (medicalApproved && isDraft) warnings.push('의료인 승인은 완료됐지만 원고는 아직 draft: true입니다. 공개 승인 전이라면 정상입니다.');
  }
}

console.log(`\n보호자 노트 7단계 검사: ${slug}`);
for (const warning of warnings) console.log(`  [경고] ${warning}`);
for (const error of errors) console.log(`  [오류] ${error}`);

if (errors.length) {
  console.log(`\n오류 ${errors.length}건 · 완료 처리할 수 없습니다.`);
  process.exit(1);
}

console.log(`\n통과 · 경고 ${warnings.length}건 · 모드 ${readyToPublish ? '발행 준비' : '초안 준비'}`);
