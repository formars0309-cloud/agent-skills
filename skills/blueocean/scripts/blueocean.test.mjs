import test from 'node:test';
import assert from 'node:assert/strict';
import { commercialRatio, trendWindow, summarizeTrend, requestJson, effectiveSaturation, grade } from './blueocean.mjs';

test('의료 주제의 일반 경험담과 상업 신호를 구분한다', () => {
  assert.equal(commercialRatio([{ title: '요양병원 입원 준비물', description: '보호자의 경험', bloggername: '가족일기' }]), 0);
  assert.equal(commercialRatio([{ title: '입원 안내', bloggername: '행복요양병원' }]), 1);
  assert.equal(commercialRatio([{ description: '무료 상담 신청', bloggername: '안내' }]), 1);
  assert.equal(commercialRatio([{ description: '제품을 제공받아 작성했습니다' }]), 1);
});

test('완료된 24개월: 연도 경계, 윤년, 한국 월 경계', () => {
  assert.deepEqual(trendWindow(new Date('2026-09-20T00:00:00Z')), { startDate: '2024-09-01', endDate: '2026-08-31' });
  assert.deepEqual(trendWindow(new Date('2025-01-01T00:00:00Z')), { startDate: '2023-01-01', endDate: '2024-12-31' });
  assert.equal(trendWindow(new Date('2024-03-01T00:00:00Z')).endDate, '2024-02-29');
  assert.equal(trendWindow(new Date('2026-08-31T15:00:00Z')).endDate, '2026-08-31');
});

const window = { startDate: '2024-09-01', endDate: '2026-08-31' };
const data = Array.from({ length: 24 }, (_, i) => ({ period: new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10), ratio: i < 12 ? 10 : 20 }));
test('동일한 12개월끼리 비교하고 원자료를 보존한다', () => {
  const result = summarizeTrend(data, window);
  assert.equal(result.yoy, 2);
  assert.equal(result.trendComplete, true);
  assert.deepEqual(result.monthly, data);
  assert.equal(result.seasonal, false);
});
test('결측·중복 월은 성장을 추정하지 않는다', () => {
  assert.equal(summarizeTrend(data.slice(1), window).yoy, null);
  assert.equal(summarizeTrend([...data.slice(0, 23), data[0]], window).trendComplete, false);
});
test('계절성 및 이전 기간 검색 0을 구분한다', () => {
  assert.equal(summarizeTrend(data.map((x, i) => ({ ...x, ratio: i === 23 ? 100 : 10 })), window).seasonal, true);
  assert.equal(summarizeTrend(data.map((x, i) => ({ ...x, ratio: i < 12 ? 0 : 10 })), window).yoy, null);
});
test('429 이후 성공하면 제한된 재시도를 한다', async () => {
  let calls = 0; const delays = [];
  const result = await requestJson('https://example.invalid', {}, {
    fetchImpl: async () => ++calls === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }) } : { ok: true, json: async () => ({ ok: true }) },
    wait: async ms => delays.push(ms),
  });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 2); assert.deepEqual(delays, [1000]);
});
test('인증 오류는 재시도하지 않고 통신 오류는 세 번으로 제한한다', async () => {
  let calls = 0;
  await assert.rejects(requestJson('https://example.invalid', {}, { fetchImpl: async () => { calls++; return { ok: false, status: 401 }; }, wait: async () => {} }), /HTTP 401/);
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(requestJson('https://example.invalid', {}, { fetchImpl: async () => { calls++; throw new Error('secret'); }, wait: async () => {} }), /통신 실패/);
  assert.equal(calls, 3);
});
test('기존 등급 기준을 유지한다', () => {
  assert.equal(effectiveSaturation(10, 0.8), 6);
  assert.equal(grade(6).tier, 'B');
});
