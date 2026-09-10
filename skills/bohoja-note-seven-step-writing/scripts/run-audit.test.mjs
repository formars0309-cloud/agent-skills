// 외부 모델 호출 없이 CLI 어댑터의 실행 증거·오류·출력 회수를 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const runner = fileURLToPath(new URL('./run-audit.mjs', import.meta.url));
function run(reviewer, mode='success') {
  const root=mkdtempSync(join(tmpdir(),'bohoja-adapter-'));
  mkdirSync(join(root,'bin')); mkdirSync(join(root,'input','sources'),{recursive:true});
  for (const [file,body] of Object.entries({'brief.md':'중립 질문','draft.md':'---\ntitle: 독립 검수 실행 시험\ndescription: '+ '가'.repeat(50)+'\nquickAnswer: '+'나'.repeat(50)+'\n---\n검사용 원고','prompt.txt':'원천 대조','sources/manifest.json':'[]'})) writeFileSync(join(root,'input',file),body);
  const stub=`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
const a=process.argv.slice(2); if(a.includes('--version')){console.log('test-cli 1');process.exit(0)}
let p='';for await(const c of process.stdin)p+=c;
const v='BEGIN_BOHOJA_AUDIT_JSON\\n'+JSON.stringify({verdict:'통과',findings:[],summary:'어댑터 시험'})+'\\nEND_BOHOJA_AUDIT_JSON';
if(${JSON.stringify(reviewer)}==='codex'){writeFileSync(a[a.indexOf('-o')+1],v);console.log(JSON.stringify({type:'thread.started',thread_id:'test-codex'}));}
else{console.log(JSON.stringify({type:'system',session_id:'test-claude',model:'test-model'}));console.log(JSON.stringify({type:'result',session_id:'test-claude',is_error:${mode==='error'},result:${mode==='invalid' ? "'계약 없는 응답'" : 'v'},modelUsage:{'test-model':{}}}));}
`;
  writeFileSync(join(root,'bin',reviewer),stub,{mode:0o755});
  const r=spawnSync(process.execPath,[runner,'example','--kind','stage3','--input','input','--reviewer',reviewer,'--model','test-model'],{cwd:root,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH},encoding:'utf8'});
  assert.notEqual(r.status,5,r.stderr);
  const e=JSON.parse(readFileSync(join(root,'content-work/example/audits/stage3-r1/execution.json'),'utf8'));
  rmSync(root,{recursive:true,force:true}); return {r,e};
}
test('Claude 판정과 실제 모델·세션·해시를 회수',()=>{const {r,e}=run('claude'); assert.equal(r.status,0,r.stderr);assert.equal(e.model,'test-model');assert.equal(e.sessionId,'test-claude');assert.equal(e.inputUnchanged,true);assert.equal(e.reviewer,'claude');});
test('Claude 오류 결과를 통과시키지 않음',()=>{const {r,e}=run('claude','error'); assert.equal(r.status,6);assert.equal(e.status,'failed');});
test('Claude 출력 계약이 없으면 보류',()=>{const {r,e}=run('claude','invalid');assert.equal(r.status,6);assert.equal(e.status,'failed');});
test('기존 Codex 판정 회수 호환',()=>{const {r,e}=run('codex');assert.equal(r.status,0,r.stderr);assert.equal(e.sessionId,'test-codex');assert.equal(e.inputUnchanged,true);});
