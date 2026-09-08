// 보호자 노트 검수 실행기 공통 유틸(2026-09-08 판정·종료 방식 개선).
// 실행 기록(execution.json)은 항상 임시 파일에 쓴 뒤 rename으로 교체해 부분 기록을 남기지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const AUDIT_KINDS = ['stage3', 'final-fact', 'final-value'];
export const SEVERITIES = ['차단', '필수 수정', '권고'];
export const FINDING_KINDS = ['내용', '기계 대조'];
export const VERDICTS = ['반려', '수정 후 확인', '통과'];
// 반복 상한: 단계별 최초 1회 + 재검수 2회. 인프라 실패(실행 보류)는 별도 상한.
export const MAX_CONTENT_ATTEMPTS = 3;
export const MAX_INFRA_RETRIES = 2;
export const BEGIN_MARK = 'BEGIN_BOHOJA_AUDIT_JSON';
export const END_MARK = 'END_BOHOJA_AUDIT_JSON';

export function sha256(raw) {
  return createHash('sha256').update(Buffer.isBuffer(raw) ? raw : String(raw).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// draft 상태만 정규화한 원고 SHA. draft: true/false 전환은 해시를 바꾸지 않는다.
export function articleSha(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return sha256(text);
  const fm = match[1].replace(/^draft:\s*(?:true|false)\s*$/m, 'draft: <publication-state>');
  return sha256(`---\n${fm}\n---\n${match[2]}`);
}

export function hashTree(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// PID 재사용을 막기 위해 프로세스 시작 시각을 함께 기록·대조한다(macOS/Linux ps).
export function processStart(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const text = (result.stdout ?? '').trim();
  return result.status === 0 && text ? text : null;
}

export function processAlive(pid, expectedStart) {
  if (!pid) return false;
  const start = processStart(pid);
  if (!start) return false;
  return expectedStart ? start === expectedStart : true;
}

export function listAudits(auditsDir) {
  if (!existsSync(auditsDir)) return [];
  return readdirSync(auditsDir)
    .filter((name) => existsSync(join(auditsDir, name, 'execution.json')))
    .map((name) => ({ name, dir: join(auditsDir, name), execution: readJson(join(auditsDir, name, 'execution.json')) }))
    .filter((item) => item.execution);
}

// 실행기가 만든 기록만 판정 계약의 대상이다. schemaVersion이 없는 과거 ad hoc 기록은 이력으로만 본다.
export function runnerAudits(auditsDir, kind) {
  return listAudits(auditsDir).filter((item) => item.execution.schemaVersion >= 1 && (!kind || item.execution.kind === kind))
    .sort((a, b) => (a.execution.startedAt ?? '').localeCompare(b.execution.startedAt ?? ''));
}

export function parseVerdict(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const start = text.lastIndexOf(BEGIN_MARK);
  const end = text.lastIndexOf(END_MARK);
  if (start < 0 || end <= start) return { ok: false, error: `판정 원문에 ${BEGIN_MARK} … ${END_MARK} 블록이 없습니다.` };
  let value;
  try { value = JSON.parse(text.slice(start + BEGIN_MARK.length, end).trim()); }
  catch (error) { return { ok: false, error: `판정 JSON 파싱 실패: ${error.message}` }; }
  if (!VERDICTS.includes(value.verdict)) return { ok: false, error: `verdict는 ${VERDICTS.join(' / ')} 중 하나여야 합니다.` };
  if (!Array.isArray(value.findings)) return { ok: false, error: 'findings 배열이 없습니다.' };
  const ids = new Set();
  for (const f of value.findings) {
    if (!f || !/^F[1-9]\d*$/.test(f.id ?? '') || ids.has(f.id)) return { ok: false, error: `지적 ID가 F1부터 중복 없이 이어져야 합니다: ${f?.id}` };
    ids.add(f.id);
    if (!SEVERITIES.includes(f.severity)) return { ok: false, error: `${f.id}: severity는 ${SEVERITIES.join(' / ')} 중 하나여야 합니다.` };
    if (!FINDING_KINDS.includes(f.kind)) return { ok: false, error: `${f.id}: kind는 ${FINDING_KINDS.join(' / ')} 중 하나여야 합니다.` };
    for (const key of ['location', 'problem', 'basis', 'readerImpact', 'action']) {
      if (typeof f[key] !== 'string' || !f[key].trim()) return { ok: false, error: `${f.id}: ${key}가 비었습니다. 심각도마다 원문 근거와 독자 영향 설명이 필수입니다.` };
    }
    if (f.kind === '기계 대조' && f.severity === '차단') return { ok: false, error: `${f.id}: 기계 대조로 종결 가능한 지적은 차단일 수 없습니다.` };
  }
  // 판정 일관성: 차단이 있으면 반려, 차단 없이 필수 수정이 있으면 수정 후 확인, 둘 다 없으면 통과.
  const hasBlocking = value.findings.some((f) => f.severity === '차단');
  const hasRequired = value.findings.some((f) => f.severity === '필수 수정');
  const expected = hasBlocking ? '반려' : hasRequired ? '수정 후 확인' : '통과';
  if (value.verdict !== expected) return { ok: false, error: `지적 구성(차단 ${hasBlocking ? '있음' : '없음'}, 필수 수정 ${hasRequired ? '있음' : '없음'})과 verdict ${value.verdict}가 맞지 않습니다. 기대: ${expected}` };
  return { ok: true, value };
}

// 검수자에게 붙이는 출력 계약. 프롬프트 본문이 어떻게 쓰였든 이 블록이 판정의 기계 계약이다.
export function outputContract({ kind, focus }) {
  const focusText = focus
    ? `\n\n이번 검수는 현행 원고 전체를 대상으로 하되 다음 범위를 우선 점검한다(중립적 점검 범위이며 이전 판정은 전달되지 않았다): ${focus}`
    : '';
  return `${focusText}

판정 규칙(2026-09-08 개정):
- 지적은 세 심각도로 나눈다. 차단 = 독자의 판단·안전·자격·금액·기한을 바꾸는 오류, 핵심 근거 미확보, 실제 모순. 필수 수정 = 발행 전 고쳐야 하지만 독자 판단을 바꾸지 않는 오류. 권고 = 문체·부가 내용·구성 선호.
- 각 지적의 kind는 둘 중 하나다. 내용 = 사실의 의미가 달라지는 수정이 필요해 새 독립 검수가 필요한 것. 기계 대조 = 행 번호·근거표 위치 표기·메타데이터·글자 수처럼 수정 뒤 기계 대조로 종결할 수 있는 것.
- 실제 의미 오류를 문체 문제로 낮추지 마라. 반대로 권고 수준의 문체 선호나 부가 내용 제안만으로 반려하지 마라. 요약문(quickAnswer·description)에 본문의 모든 예외를 반복하라고 요구하지 말고, 요약의 범위·조건이 독자에게 오해를 만드는지만 판단하라.
- 심각도마다 원문 근거(basis)와 독자 영향(readerImpact)을 반드시 쓴다.
- verdict: 차단이 하나라도 있으면 반려. 차단 없이 필수 수정이 있으면 수정 후 확인. 차단·필수 수정이 없으면 통과(권고는 있어도 된다).
- 최초 검수는 전 범위를 한 번에 점검한다. 나중에 덧붙일 지적을 남기지 마라.

출력의 마지막에는 아래 표식 사이의 JSON 객체 하나를 반드시 넣는다. 사람이 읽을 지적표·추적표는 그 앞에 자유롭게 쓴다. kind 필드는 ${JSON.stringify(kind)} 검수의 계약이다.
${BEGIN_MARK}
{"verdict":"반려|수정 후 확인|통과","findings":[{"id":"F1","severity":"차단|필수 수정|권고","kind":"내용|기계 대조","location":"원고 위치·짧은 인용","problem":"문제","basis":"원천 파일·위치·원문 대조","readerImpact":"독자에게 미치는 영향","action":"권장 조치"}],"summary":"한 줄 요약"}
${END_MARK}
`;
}

export function openFindings(execution) {
  return (execution.findings ?? []).filter((f) => f.severity !== '권고');
}

// 프론트매터 필드 값(단일 행 따옴표/plain, 또는 >- | 블록 스칼라)을 읽는다. 검사용 근사 파서다.
export function frontmatterField(raw, key) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
      const block = [];
      for (let j = i + 1; j < lines.length && (/^\s+/.test(lines[j]) || lines[j] === ''); j += 1) block.push(lines[j].trim());
      return rest.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
    }
    if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) return rest.slice(1, -1);
    return rest;
  }
  return null;
}

// src/content.config.ts의 z.string().min(a).max(b) 상한을 읽는다. 못 읽으면 기본값.
export function schemaLimits(configPath) {
  const defaults = { title: 70, description: 160, quickAnswer: 400, readerQuestion: 120, addedValue: 300, decision: 200, shows: 40, verify: 90 };
  let raw = '';
  try { raw = readFileSync(configPath, 'utf8'); } catch { return { limits: defaults, source: 'default' }; }
  const limits = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const m = raw.match(new RegExp(`${key}:\\s*z\\.string\\(\\)(?:\\.min\\(\\d+\\))?\\.max\\((\\d+)\\)`));
    if (m) limits[key] = Number(m[1]);
  }
  return { limits, source: configPath };
}

export function checkFrontmatterLimits(draftRaw, limits) {
  const problems = [];
  for (const [key, max] of Object.entries(limits)) {
    const value = frontmatterField(draftRaw, key);
    if (value === null) { if (['title', 'description', 'quickAnswer'].includes(key)) problems.push(`${key} 필드가 없습니다.`); continue; }
    if (value.length > max) problems.push(`${key} ${value.length}자 > 상한 ${max}자`);
  }
  return problems;
}

// 실행 중으로 기록됐지만 runner가 없거나(PID 재사용 포함) 마감이 지난 기록을 lost로 확정한다. 종료 코드는 만들어내지 않는다.
export function reconcileAudits(auditsDir, graceMs = 2 * 60000) {
  const changed = [];
  for (const item of runnerAudits(auditsDir)) {
    const e = item.execution;
    if (e.status !== 'running') continue;
    const alive = processAlive(e.runnerPid, e.runnerStart);
    const overdue = e.deadlineAt && Date.now() > Date.parse(e.deadlineAt) + graceMs;
    if (!alive || overdue) {
      Object.assign(e, {
        status: 'lost', lostDetectedAt: new Date().toISOString(), exitCode: null,
        reason: !alive ? `runner PID ${e.runnerPid}가 존재하지 않음(종료 기록 없음)` : `마감 ${e.deadlineAt} 경과 후에도 종료 기록 없음`,
        codexAliveAtDetection: processAlive(e.codexPid, e.codexStart),
      });
      writeJsonAtomic(join(item.dir, 'execution.json'), e);
      changed.push(item.name);
    }
  }
  return changed;
}
