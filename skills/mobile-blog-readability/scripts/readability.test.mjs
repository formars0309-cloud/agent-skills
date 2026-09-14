import test from 'node:test';
import assert from 'node:assert/strict';
import transform, { splitKoreanSentences, appliesToArticle, explainKoreanAbbreviations } from '../assets/rehype-mobile-readability.mjs';

test('소수점·날짜·약어·URL과 문장 인용을 보존한다', () => {
  assert.deepEqual(splitKoreanSentences('Dr. Kim은 2.5mg을 썼다.[2] 다음이다.'), ['Dr. Kim은 2.5mg을 썼다.[2]', '다음이다.']);
  assert.deepEqual(splitKoreanSentences('2026. 9. 14. 기준이다. 조건은 같다.'), ['2026. 9. 14. 기준이다.', '조건은 같다.']);
  assert.deepEqual(splitKoreanSentences('주소 https://example.com/가.나 이다. 다음이다.'), ['주소 https://example.com/가.나 이다.', '다음이다.']);
  assert.deepEqual(splitKoreanSentences('아니다. [2, 3] 다음이다.'), ['아니다. [2, 3]', '다음이다.']);
});

const text = (value) => ({ type: 'text', value });
const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
const flatten = (node) => node.type === 'text' ? node.value : (node.children ?? []).map(flatten).join('');

test('굵은 명사형 머리말은 설명에 붙이고 완성 문장은 구분한다', () => {
  const tree={type:'root',children:[el('p',[el('strong',[text('감경.')]),text(' 대상에 따라 다릅니다. 조건을 확인합니다.')]),el('p',[el('strong',[text('대상입니다.')]),text(' 조건을 확인합니다.')])]};
  transform()(tree);
  assert.equal(tree.children.length,4);
  assert.equal(flatten(tree.children[0]).trim(),'감경. 대상에 따라 다릅니다.');
  assert.equal(flatten(tree.children[2]).trim(),'대상입니다.');
});

test('약어 풀이 뒤 조사를 맞추고 서지 목록을 본문 목록과 구분한다', () => {
  const tree = {type:'root', children:[el('p',[text('ISG가 작동합니다. ISG는 다시 확인합니다.')]),el('h2',[text('출처')]),el('ul',[el('li',[text('공식 자료')])])]};
  transform({glossary:{ISG:'공회전 제한 시스템(ISG)'}})(tree);
  assert.match(flatten(tree), /시스템\(ISG\)이 작동합니다/);
  assert.match(flatten(tree), /ISG는 다시/);
  assert.deepEqual(tree.children.at(-1).properties.className,['mobile-bibliography']);
});

test('공식 링크 제목은 보존하고 겹괄호와 조사·문장부호를 처리한다', () => {
  const tree={type:'root',children:[el('p',[el('a',[text('TS 공식 문서')],{href:'/official'}),text(' TS와, ISG로. 검사(MMSE, GDS)를 확인합니다.')])]};
  transform({glossary:{TS:'한국교통안전공단(TS)',ISG:'공회전 제한 시스템(ISG)',MMSE:'간이정신진단검사(MMSE)',GDS:'전반적 퇴화척도(GDS)'}})(tree);
  assert.equal(tree.children[0].children[0].children[0].value,'TS 공식 문서');
  assert.match(flatten(tree),/공단\(TS\)과,/);
  assert.match(flatten(tree),/시스템\(ISG\)으로\./);
  assert.match(flatten(tree),/검사\(간이정신진단검사 MMSE, 전반적 퇴화척도 GDS\)/);
});

test('강조 노드를 가로지르는 괄호의 약어도 겹괄호 없이 푼다', () => {
  const tree={type:'root',children:[el('p',[text('검사('),el('strong',[text('MMSE')]),text(', GDS)를 확인합니다.')])]};
  transform({glossary:{MMSE:'간이정신진단검사(MMSE)',GDS:'전반적 퇴화척도(GDS)'}})(tree);
  assert.equal(flatten(tree),'검사(간이정신진단검사 MMSE, 전반적 퇴화척도 GDS)를 확인합니다.');
});

test('표에서 처음 만나는 약어는 표를 보존한 채 바로 뒤에서 설명한다', () => {
  const table=el('table',[el('tr',[el('td',[text('GTL 20인치')]),el('td',[text('TS')])])]);
  const original=JSON.stringify(table);
  const tree={type:'root',children:[table,el('p',[text('GTL을 비교합니다. TS를 확인합니다.')])]};
  transform({glossary:{TS:'한국교통안전공단(TS)'},definitions:{GTL:'GTL은 GT-Line 트림을 줄여 쓴 표기입니다.'}})(tree);
  assert.equal(JSON.stringify(table),original);
  assert.equal(tree.children.filter(n=>n.properties?.['data-mobile-definition']==='GTL').length,1);
  assert.match(flatten(tree),/용어: 한국교통안전공단\(TS\)/);
});

test('별표 강조 복원은 승인한 문구에만 적용하고 코드 문자는 보존한다', () => {
  const tree={type:'root',children:[el('p',[text('**15%**와 **그대로**'),el('code',[text('**15%**')])])]};
  transform({boldRepairs:['15%']})(tree);
  assert.equal(tree.children[0].children[0].tagName,'strong');
  assert.match(flatten(tree),/\*\*그대로\*\*/);
  assert.equal(flatten(tree.children[0].children.at(-1)),'**15%**');
});

test('검토된 묶음 이름과 명사형 머리말을 글자 그대로 강조한다', () => {
  const tree={type:'root',children:[el('p',[text('조사 당일\n5. 확인합니다.\n6. 살펴봅니다.')]),el('p',[text('실구매가. 가격을 확인합니다.')])]};
  transform({emphasizeParagraphs:['조사 당일'],labelPrefixes:['실구매가.']})(tree);
  assert.equal(tree.children[0].children[0].tagName,'strong');
  assert.equal(tree.children.at(-1).children[0].tagName,'strong');
  assert.match(flatten(tree.children.at(-1)),/실구매가\. 가격/);
});

test('도입 뒤 첫째와 다음 문단 둘째를 묶되 각각의 예외를 보존한다', () => {
  const tree={type:'root',children:[el('p',[text('주의할 점이 둘 있습니다. 첫째, 적용되지 않습니다. 첫 항목의 예외입니다.')]),text('\n'),el('p',[text('둘째, 다른 조건입니다. 둘째 항목의 예외입니다.')]),el('p',[text('공단은 별도로 확인합니다.')])]};
  transform()(tree);
  assert.equal(flatten(tree.children[0]).trim(),'주의할 점이 둘 있습니다.');
  const list=tree.children.find(n=>n.tagName==='ul');
  assert.equal(list.children.length,2);
  assert.match(flatten(list.children[0]),/첫 항목의 예외입니다/);
  assert.match(flatten(list.children[1]),/둘째 항목의 예외입니다/);
  assert.equal(list.children[0].children.length,2);
  assert.equal(tree.children.at(-1).tagName,'p');
  assert.match(flatten(tree.children.at(-1)),/공단은 별도로/);
});

test('검토된 긴 쉼표 목록은 괄호 안 쉼표와 수치·연결어를 보존한다', () => {
  const raw='적는 항목입니다. 병력, 약물 수(5가지 이내, 5~9가지), 그리고 특기사항입니다. 총괄 설명입니다.';
  const tree={type:'root',children:[el('p',[text(raw)])]};
  const rule={when:'병력',from:'병력',to:'특기사항입니다.',count:3};
  transform({commaLists:[rule]})(tree);
  const list=tree.children.find(n=>n.tagName==='ul');
  assert.equal(list.children.length,3);
  assert.equal(flatten(list.children[1]).trim(),'약물 수(5가지 이내, 5~9가지),');
  // 공백뿐인 블록 제거 후에도 모든 글자·수치·기호는 같다.
  assert.equal(flatten(tree).replace(/\s/g,''),raw.replace(/\s/g,''));
  assert.equal(tree.children.at(-1).tagName,'p');
  assert.throws(()=>transform({commaLists:[{...rule,count:4}]} )({type:'root',children:[el('p',[text(raw)])]}),/항목 수/);
});

test('서수 절차와 그 뒤 보호자 할 일 목록을 독립적으로 유지한다', () => {
  const raw='절차입니다. 첫째, 신청합니다. 둘째, 판정합니다. 보호자가 할 일입니다. 준비를 정하고, 상태를 전달하고, 청구하는 것입니다.';
  const tree={type:'root',children:[el('p',[text(raw)])]};
  transform({enumerationEndBefore:[{when:'절차입니다.',before:'보호자가 할 일입니다.'}],commaLists:[{when:'준비를 정하고',from:'준비를 정하고',to:'청구하는 것입니다.',count:3}]})(tree);
  const lists=tree.children.filter(n=>n.tagName==='ul');
  assert.deepEqual(lists.map(n=>n.children.length),[2,3]);
  assert.equal(flatten(tree).replace(/\s/g,''),raw.replace(/(?:첫째|둘째),\s*/g,'').replace(/\s/g,''));
});

test('풀이를 첫 등장 문장 옆에 놓고 표 도입문과 표를 붙여 둔다', () => {
  const tree={type:'root',children:[el('p',[text('2WD를 봅니다. 다음 설명입니다.')]),el('p',[text('아래 표는 LPG를 비교합니다.')]),el('table',[])]};
  transform({definitions:{'2WD':'2WD 설명입니다.',LPG:'LPG 설명입니다.'}})(tree);
  assert.equal(flatten(tree.children[1]),'2WD 설명입니다.');
  const t=tree.children.findIndex(n=>n.tagName==='table');
  assert.equal(flatten(tree.children[t-1]),'아래 표는 LPG를 비교합니다.');
  assert.equal(flatten(tree.children[t-2]),'LPG 설명입니다.');
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
  const curly={type:'root',children:[el('p',[text('첫째, 대상입니다. 둘째, 비용입니다. 조사표에 “잘 보여야 한다”는 기준은 없습니다. 다시 확인합니다.')])]};
  transform({enumerationEndBefore:['조사표에 "잘 보여야 한다"는 기준은 없습니다.']})(curly);
  assert.equal(curly.children[0].tagName,'ul');
  assert.match(flatten(curly.children[1]),/^조사표에 “잘 보여야 한다”/);
  assert.doesNotMatch(flatten(curly.children[0]),/조사표/);
  const missing={type:'root',children:[el('p',[text('확인할 둘입니다. 첫째, 대상입니다. 둘째, 비용입니다.')])]};
  assert.throws(()=>transform({enumerationEndBefore:[{when:'확인할 둘입니다.',before:'요약하면'}]})(missing),/요약 경계/);
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

test('쉼표 목록 주변의 공백만 있는 문단을 만들지 않는다', () => {
  const tree={type:'root',children:[el('p',[text('  항목 A, 항목 B입니다.  ')])]};
  transform({commaLists:[{when:'항목 A',from:'항목 A',to:'항목 B입니다.',count:2}]})(tree);
  assert.equal(tree.children.length,1);
  assert.equal(tree.children[0].tagName,'ul');
  assert.equal(tree.children[0].children.length,2);
});

test('굵은 서수 마커를 제거하고 인용 안 목록은 임의 변환하지 않는다', () => {
  const paragraph=()=>el('p',[el('strong',[text('첫째,')]),text(' 첫 항목이다. '),el('strong',[text('둘째,')]),text(' 둘째 항목이다.')]);
  const tree={type:'root',children:[paragraph(),el('blockquote',[paragraph()])]};
  transform()(tree);
  assert.equal(tree.children[0].tagName,'ul');
  assert.equal(flatten(tree.children[0]).includes('첫째,'),false);
  assert.equal(tree.children[1].children.some(n=>['ul','ol'].includes(n.tagName)),false);
  assert.ok(flatten(tree.children[1]).includes('첫째,'));
});
test('확인한 단계 절차는 ol로 순서를 전달한다', () => {
  const tree={type:'root',children:[el('p',[text('세 단계입니다. 첫째, 신청합니다. 둘째, 조사합니다. 셋째, 판정합니다.')])]};
  transform({orderedEnumerationWhen:['세 단계입니다.']})(tree);
  assert.equal(tree.children.find(n=>n.tagName==='ol').children.length,3);
});

test('명시한 최근 글과 기준일 이후 글에만 내용 변환을 적용한다', () => {
  const scope={slugs:['selected'],since:'2026-09-14'};
  assert.equal(appliesToArticle('/guides/selected.md','2026-09-08',scope),true);
  assert.equal(appliesToArticle('/guides/old.md','2026-09-08',scope),false);
  assert.equal(appliesToArticle('/guides/new.md','2026-09-14',scope),true);
  const tree={type:'root',children:[el('p',[text('첫 문장입니다. 다음 문장입니다.')])]};
  const original=structuredClone(tree);
  transform({scope})(tree,{path:'/guides/old.md',data:{astro:{frontmatter:{pubDate:'2026-09-08'}}}});
  assert.deepEqual(tree,original);
});
test('요약의 풀이도 조사와 이미 설명한 괄호를 보존한다', () => {
  const glossary={'2WD':'이륜구동(2WD)','4WD':'사륜구동(4WD)'};
  assert.equal(explainKoreanAbbreviations('2WD는 기준이다.',glossary),'이륜구동(2WD)은 기준이다.');
  assert.equal(explainKoreanAbbreviations('이륜구동(2WD)은 기준이다.',glossary),'이륜구동(2WD)은 기준이다.');
  assert.equal(explainKoreanAbbreviations('선택(4WD)이다.',glossary),'선택(사륜구동 4WD)이다.');
});
