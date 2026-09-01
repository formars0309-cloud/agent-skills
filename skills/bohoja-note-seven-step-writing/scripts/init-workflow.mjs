#!/usr/bin/env node
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const [slug, title = '제목 미정'] = process.argv.slice(2);

if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error('사용법: node init-workflow.mjs <영문-kebab-slug> "<제목>"');
  process.exit(1);
}

const dir = join('content-work', slug);
await mkdir(dir, { recursive: true });

const common = `- 제목: ${title}\n- slug: ${slug}\n- 시작일: ${new Date().toISOString().slice(0, 10)}\n`;
const files = new Map([
  ['01-question-and-evidence.md', `# 1단계: 질문·근거·경계 설계\n\n## 작업 정보\n\n${common}\n## 대표 상황과 검색 의도\n\n## readerQuestion · addedValue · decision\n\n## 원천 우위 테스트\n\n## 포함 범위와 제외 범위\n\n## 의료·제도 경계\n\n## 형제 원고 중복 점검\n\n## 잠정 결론과 변경 조건\n\n## 권장 구조\n\n## 주장별 근거표\n\n| ID | 원고에 쓸 주장 | 유형 | 원천 제목 | 원문 URL | 원문 위치·짧은 대조 | 적용일·대상 | 확인일 | 상태 |\n|---|---|---|---|---|---|---|---|---|\n\n## 미정·상충·보류\n\n## 2단계 진행 여부: 보류\n`],
  ['02-evidence-bound-draft.md', `# 2단계: 근거 한정 초안\n\n## 작성 주체와 실행 기록\n\n## 제목과 quickAnswer\n\n## 전체 초안\n\n## 근거 ID 연결\n\n## 근거표 밖이라 쓰지 않은 내용\n\n## 추가 확인 항목\n`],
  ['03-source-trace-audit.md', `# 3단계: 원천 대조 감사\n\n## 감사 주체와 원천 확인 방식\n\n## 원천 대조 감사\n\n## 실패 건수\n\n- 미추적: 0\n- 불일치: 0\n- 과대: 0\n\n## 번호형 지적표\n\n| 번호 | 심각도 | 원고 위치·인용 | 문제 | 원천·판단 근거 | 권장 조치 |\n|---|---|---|---|---|---|\n\n## 추적 확인표\n\n## 4단계 전달 과제\n\n## 판정: 반려\n`],
  ['04-improved-draft.md', `# 4단계: 근거 기반 개선\n\n## 개선 주체와 실행 기록\n\n## 개선된 전체 원고\n\n## 평가 과제 반영표\n\n| 번호 | 평가 과제 | 반영 여부 | 반영 내용·이유 |\n|---|---|---|---|\n\n## 새로 확인한 원천과 남은 위험\n`],
  ['05-final-edited.md', `# 5단계: 보호자 언어 최종 편집\n\n## 제목과 quickAnswer\n\n## 완결된 전체 본문\n\n## 보호자 언어 편집 판단\n\n## 삭제·통합한 문단\n\n## 표·목록의 모바일 흐름\n\n## 6단계 집중 위험\n`],
  ['06-prepublish-audit.md', `# 6단계: 발행 전 이중감사\n\n## 사실 감사\n\n### 판정: 보류\n\n## 가치·밀도 감사\n\n### 판정: 보류\n\n## 독립 검수 기록\n\n- 상태: 미실행\n\n## Codex 재검증 및 판정표\n\n| 번호 | 제기 주체 | 지적 | 재검증 근거 | 판정 | 반영 내용 |\n|---|---|---|---|---|---|\n\n## 출처·적용일·환경 확인\n\n## 형제 원고 자기잠식 확인\n\n## 근거 미확보로 뺀 내용\n\n## 자동 감사 최종 판정: 보류\n\n## 의료인 승인: 대기\n\n## 공개 승인: 대기\n`],
]);

let created = 0;
let preserved = 0;
for (const [name, body] of files) {
  const path = join(dir, name);
  try {
    await access(path);
    console.log(`[보존] ${path}`);
    preserved += 1;
  } catch {
    await writeFile(path, body, 'utf8');
    console.log(`[생성] ${path}`);
    created += 1;
  }
}

console.log(`\n생성 ${created}개 · 기존 파일 보존 ${preserved}개`);
console.log(`7단계 사이트 정본 예정 경로: src/content/guides/${slug}.md`);
