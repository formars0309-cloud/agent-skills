import test from 'node:test';
import assert from 'node:assert/strict';
import transform, { splitKoreanSentences } from '../assets/rehype-mobile-readability.mjs';

test('소수점·날짜·약어·URL과 문장 인용을 보존한다', () => {
  assert.deepEqual(splitKoreanSentences('Dr. Kim은 2.5mg을 썼다.[2] 다음이다.'), ['Dr. Kim은 2.5mg을 썼다.[2]', '다음이다.']);
  assert.deepEqual(splitKoreanSentences('2026. 9. 14. 기준이다. 조건은 같다.'), ['2026. 9. 14. 기준이다.', '조건은 같다.']);
  assert.deepEqual(splitKoreanSentences('주소 https://example.com/가.나 이다. 다음이다.'), ['주소 https://example.com/가.나 이다.', '다음이다.']);
  assert.deepEqual(splitKoreanSentences('아니다. [2, 3] 다음이다.'), ['아니다. [2, 3]', '다음이다.']);
});

const text = (value) => ({ type: 'text', value });
const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
const flatten = (node) => node.type === 'text' ? node.value : (node.children ?? []).map(flatten).join('');

test('약어 풀이 뒤 조사를 맞추고 서지 목록을 본문 목록과 구분한다', () => {
  const tree = {type:'root', children:[el('p',[text('ISG가 작동합니다. ISG는 다시 확인합니다.')]),el('h2',[text('출처')]),el('ul',[el('li',[text('공식 자료')])])]};
  transform({glossary:{ISG:'공회전 제한 시스템(ISG)'}})(tree);
  assert.match(flatten(tree), /시스템\(ISG\)이 작동합니다/);
  assert.match(flatten(tree), /ISG는 다시/);
  assert.deepEqual(tree.children.at(-1).properties.className,['mobile-bibliography']);
});

test('문장 끝의 여러 출처 링크를 묶고 연속 번호 줄을 목록으로 복원한다', () => {
  const cited={type:'root',children:[el('p',[text('조건입니다. '),el('a',[text('근거 A')],{href:'/a'}),text(', '),el('a',[text('근거 B')],{href:'/b'})])]};
  transform()(cited);
  assert.equal(cited.children.length,1);
  const numbered={type:'root',children:[el('p',[text('조사 당일\n5. 조건입니다. 예외입니다.\n6. 다른 조건입니다.')])]};
  transform()(numbered);
  assert.equal(numbered.children[1].tagName,'ol');
  assert.equal(numbered.children[1].properties.start,5);
  assert.equal(numbered.children[1].children.length,2);
  assert.equal(flatten(numbered.children[1].children[0]),'조건입니다. 예외입니다.');
  assert.deepEqual(splitKoreanSentences('5. 조건입니다. 다음입니다.'),['5. 조건입니다.','다음입니다.']);
});

test('검토된 요약 경계는 마지막 목록 밖에 유지한다', () => {
  const tree={type:'root',children:[el('p',[text('두 가지입니다. 첫째, 대상입니다. 둘째, 비용입니다. 요약하면 둘 다 확인합니다.')])]};
  transform({enumerationEndBefore:['요약하면']})(tree);
  assert.equal(tree.children[1].tagName,'ul');
  assert.deepEqual(tree.children[1].children.map(n => flatten(n).trim()),['대상입니다.','비용입니다.']);
  assert.equal(flatten(tree.children[2]),'요약하면 둘 다 확인합니다.');
});

test('문장 분리 후 가시 텍스트와 링크 목적지·강조·목록 항목 수를 유지한다', () => {
  const link = el('a', [text('근거')], { href: 'https://example.com' });
  const tree = { type: 'root', children: [el('p', [text('첫째는 '), el('strong', [text('아니다. 조건은 같다.')]), text(' '), link]), el('ul', [el('li', [text('첫 문장이다. 둘째 문장이다.')])])] };
  const before = flatten(tree);
  transform()(tree);
  assert.equal(flatten(tree), before);
  assert.equal(tree.children.length, 3);
  assert.equal(tree.children[2].children.length, 1);
  assert.equal(tree.children[2].children[0].children.length, 2);
  const links = JSON.stringify(tree).match(/https:\/\/example.com/g) ?? [];
  assert.equal(links.length, 1);
});

test('링크 내부·표·코드·이미지 문단을 임의로 쪼개지 않는다', () => {
  const tree = { type: 'root', children: [el('p', [el('a', [text('첫 문장이다. 둘째 문장이다.')], { href: '/x' })]), el('table', [el('tr', [el('td', [el('p', [text('첫 문장이다. 둘째다.')])])])]), el('p', [el('img', [], { src: '/a.png' }), text('첫 문장이다. 둘째다.')])] };
  const before = JSON.stringify(tree);
  transform()(tree);
  assert.equal(JSON.stringify(tree), before);
});

test('인라인 계산식을 보존하면서 계산 설명 문장을 분리한다', () => {
  const tree = { type: 'root', children: [el('p', [text('계산은 '), el('code', [text('4 + 8 / 2 = 8')]), text('이다. 둘을 모두 쓴다는 뜻은 아니다.')])] };
  const before = flatten(tree);
  transform()(tree);
  assert.equal(tree.children.length, 2);
  assert.equal(flatten(tree), before);
  assert.equal(tree.children[0].children[1].tagName, 'code');
});

test('괄호·퍼센트 종결을 나누고 인용은 같은 문단 안에서 빈 줄을 둔다', () => {
  assert.deepEqual(splitKoreanSentences('규정입니다(제23조). 다음입니다.'), ['규정입니다(제23조).', '다음입니다.']);
  assert.deepEqual(splitKoreanSentences('비율은 10%. 조건은 같다.'), ['비율은 10%.', '조건은 같다.']);
  const tree = { type: 'root', children: [el('p', [text('“대상이 아닙니다. 조건을 확인하세요.”')])] };
  const before = flatten(tree);
  transform()(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].children.filter(n => n.tagName === 'br').length, 2);
  assert.equal(flatten(tree), before);
  const listTree = { type: 'root', children: [el('ul', [el('li', [text('“대상이 아닙니다. 조건을 확인하세요.”')])])] };
  transform()(listTree);
  assert.equal(listTree.children[0].children[0].children[0].children.filter(n => n.tagName === 'br').length, 2);
});

test('약어는 첫 등장만 풀고 첫째·둘째의 병렬 구조를 목록으로 표시한다', () => {
  const tree = { type: 'root', children: [el('p', [text('TS 안내입니다. TS는 다시 확인합니다.')]), el('p', [text('첫째, 대상입니다.')]), text('\n'), el('p', [text('둘째, 예외입니다.')])] };
  transform({ glossary: { TS: '한국교통안전공단(TS)' } })(tree);
  assert.equal(flatten(tree).match(/한국교통안전공단/g).length, 1);
  const list = tree.children.find(n => n.tagName === 'ul');
  assert.equal(list.children.length, 2);
  assert.equal(flatten(list), '대상입니다.예외입니다.');
});

test('한 문단 안의 첫째·둘째는 설명을 각 항목에 붙인 채 번호 목록이 된다', () => {
  const tree = { type: 'root', children: [el('p', [text('두 가지다. 첫째, '), el('strong', [text('대상이다.')]), text(' 예외도 있다. 둘째, 비용이다. 조건이 있다.')])] };
  transform()(tree);
  assert.equal(tree.children.length, 2);
  const list = tree.children[1];
  assert.equal(list.tagName, 'ul');
  assert.equal(list.children.length, 2);
  assert.equal(flatten(list.children[0]).trim(), '대상이다. 예외도 있다.');
  assert.equal(flatten(list.children[1]).trim(), '비용이다. 조건이 있다.');
});
