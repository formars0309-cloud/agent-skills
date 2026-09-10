import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./audit-status.mjs', import.meta.url));
function fixture(t, changes = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'audit-wait-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = join(cwd, 'content-work', 'sample', 'audits', 'stage3-r1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'execution.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'stage3', attempt: 1,
    status: 'running', runnerPid: process.pid, startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60000).toISOString(), ...changes }));
  return { file, run: (...args) => spawnSync(process.execPath,
    [script, 'sample', '--wait', 'stage3-r1', ...args], { cwd, encoding: 'utf8', timeout: 2000 }) };
}
for (const value of ['NaN', 'Infinity', '0', '-1', '46', '--json']) {
  test(`잘못된 시간 값 ${value}는 즉시 거부`, (t) => {
    const { run } = fixture(t); const r = run('--timeout-min', value);
    assert.equal(r.status, 5); assert.equal(r.error, undefined);
  });
}
test('누락된 시간 값은 즉시 거부', (t) => {
  assert.equal(fixture(t).run('--timeout-min').status, 5);
});
test('잘못된 실행 마감은 무한 대기 없이 보류', (t) => {
  const { run, file } = fixture(t, { deadlineAt: 'invalid' });
  assert.equal(run().status, 6);
  assert.equal(JSON.parse(readFileSync(file)).status, 'running');
});
test('짧은 유한 상한을 넘기면 실행을 죽이지 않고 대기만 종료', (t) => {
  const { run, file } = fixture(t); const r = run('--timeout-min', '0.0001');
  assert.equal(r.status, 6); assert.equal(r.error, undefined);
  assert.equal(JSON.parse(readFileSync(file)).status, 'running');
});
test('완료된 반려 결과를 성공 판정으로 바꾸지 않는다', (t) => {
  const r = fixture(t, { status: 'completed', verdict: '반려' }).run();
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).verdict, '반려');
});
test('사라진 실행기는 대기를 끝내고 lost로 기록', (t) => {
  const { run, file } = fixture(t, { runnerPid: null });
  assert.equal(run().status, 6);
  assert.equal(JSON.parse(readFileSync(file)).status, 'lost');
});
test('wait 경로 탈출을 거부', (t) => {
  const { run } = fixture(t);
  // 첫 --wait 값을 바꾸는 별도 호출은 외부 상태를 읽지 않아야 한다.
  const r = spawnSync(process.execPath, [script, 'sample', '--wait', '../elsewhere'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(r.status, 5);
});
