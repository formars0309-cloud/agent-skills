// 승인 기록의 의미를 보존한다. 개별 임상 미검토를 의료인 승인으로 바꾸지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const script=fileURLToPath(new URL('./validate-workflow.mjs',import.meta.url));
function check({flag=true,authority=true,record=true,medical='대기'}={}) {
 const root=mkdtempSync(join(tmpdir(),'bohoja-approval-'));const dir=join(root,'content-work/example');mkdirSync(dir,{recursive:true});mkdirSync(join(root,'src/content/guides'),{recursive:true});
 const files={
 '01-question-and-evidence.md':'## 원천 우위 테스트\n## 의료·제도 경계\n## 주장별 근거표\n## 미정·상충·보류\n## 2단계 진행 여부: 진행\n',
 '02-evidence-bound-draft.md':'## 전체 초안\n## 근거 ID 연결\n',
 '03-source-trace-audit.md':'## 원천 대조 감사\n## 번호형 지적표\n## 판정: 통과\n',
 '04-improved-draft.md':'## 개선된 전체 원고\n## 평가 과제 반영표\n',
 '05-final-edited.md':'## 완결된 전체 본문\n## 보호자 언어 편집 판단\n',
 '06-prepublish-audit.md':`## 사실 감사\n### 판정: 통과\n## 가치·밀도 감사\n### 판정: 통과\n## 독립 검수 기록\n## 자동 감사 최종 판정: 통과\n## 의료인 승인: ${medical}\n## 공개 승인: 승인\n${record?'## 상시 발행 지시 적용: 적용\n개별 임상 검토: 미수행\n':''}`};
 for(const [n,s] of Object.entries(files))writeFileSync(join(dir,n),s);
 writeFileSync(join(root,'AGENTS.md'),authority?'내가 글쓰기를 지시하면 항상 발행까지 완료해줘':'상시 지시 없음');
 writeFileSync(join(root,'src/content/guides/example.md'),'---\n'+['title','description','quickAnswer','readerQuestion','addedValue','decision','category','pubDate','verifiedOn','verificationMethod','sources'].map(k=>`${k}: 예시`).join('\n')+'\ndraft: false\n---\n본문');
 const r=spawnSync(process.execPath,[script,'example','--ready-to-publish',...(flag?['--standing-publication']:[])],{cwd:root,encoding:'utf8'});rmSync(root,{recursive:true,force:true});return r;
}
test('명시적 상시 지시와 임상 대기 기록이 함께 있어야 발행 검사 허용',()=>assert.equal(check().status,0));
test('옵션 없이는 의료인 승인 게이트 유지',()=>assert.equal(check({flag:false}).status,1));
test('저장소 사용자 지시가 없으면 차단',()=>assert.equal(check({authority:false}).status,1));
test('개별 임상 미검토 기록이 없으면 차단',()=>assert.equal(check({record:false}).status,1));
test('기존 명시 의료인 승인 경로 유지',()=>assert.equal(check({flag:false,medical:'승인'}).status,0));
