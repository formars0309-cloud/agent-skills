#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const slug = args.find((arg) => !arg.startsWith('--'));
const readyToPublish = args.includes('--ready-to-publish');

if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error('사용법: node validate-workflow.mjs <영문-kebab-slug> [--ready-to-publish]');
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
  const factReview = reviewRaw.split('## 사실 감사')[1]?.split('## 가치·밀도 감사')[0] ?? '';
  const valueReview = reviewRaw.split('## 가치·밀도 감사')[1]?.split('## 독립 검수 기록')[0] ?? '';
  if (!/### 판정:\s*통과\s*(?:\r?\n|$)/.test(factReview)) {
    errors.push(`${join(dir, '06-prepublish-audit.md')}: 사실 감사 판정이 통과가 아닙니다.`);
  }
  if (!/### 판정:\s*통과\s*(?:\r?\n|$)/.test(valueReview)) {
    errors.push(`${join(dir, '06-prepublish-audit.md')}: 가치·밀도 감사 판정이 통과가 아닙니다.`);
  }
}

const medicalApproved = /## 의료인 승인:\s*승인\s*(?:\r?\n|$)/.test(reviewRaw);
const publicationApproved = /## 공개 승인:\s*승인\s*(?:\r?\n|$)/.test(reviewRaw);
const isDraft = /\ndraft:\s*true\s*(?:\r?\n|$)/.test(finalRaw);
const isPublished = /\ndraft:\s*false\s*(?:\r?\n|$)/.test(finalRaw);

if (finalRaw) {
  if (readyToPublish) {
    if (!medicalApproved) errors.push('의료인 승인이 기록되지 않았습니다.');
    if (!publicationApproved) errors.push('공개 승인이 기록되지 않았습니다.');
    if (!isPublished) errors.push(`${finalPath}: 발행 준비 검사에는 draft: false가 필요합니다.`);
  } else {
    if (!medicalApproved && !isDraft) errors.push(`${finalPath}: 의료인 승인 전에는 draft: true여야 합니다.`);
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
