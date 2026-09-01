#!/usr/bin/env node
/**
 * blueocean 결과 → 제목 생성 브리프
 *
 * 이 스크립트는 제목을 만들지 않는다. 만드는 건 에이전트가 한다.
 * 여기서 하는 일은 셋뿐이다.
 *
 *   1) blueocean.json 에서 한 키워드의 실측값을 꺼낸다
 *   2) 그 값으로 "어떤 유형을 낼 수 있는가"를 판정한다
 *   3) 금칙어와 제약을 붙여 생성 브리프로 낸다
 *
 * ## 유형을 조건부로 두는 이유
 *
 * 반전형(통념을 뒤집는 제목)은 후킹이 가장 세지만, 뒤집을 통념이 없는 주제에
 * 이 유형을 요구하면 **에이전트가 없는 통념을 지어낸다.** "많은 분들이 오해하시는데"
 * 같은 문장이 그렇게 나온다. 금칙어 필터는 이걸 잡지 못한다. 어휘 문제가 아니라
 * 없는 사실을 만든 것이기 때문이다.
 *
 * 그래서 반전형은 --myth 로 반박할 통념을 명시적으로 줬을 때만 켜진다.
 * 후보가 2개만 나오는 것은 정상이다. 빈 각도를 채우지 않는 것이 이 도구의 목적이다.
 *
 * ## 순위를 내지 않는 이유
 *
 * 제목의 클릭률은 네이버 API로 잴 수 없다. 잴 수 없는 것에 점수를 붙이면
 * 가짜 정밀도가 된다. 유형에 순서를 매기는 것도 같은 문제다 — 사람은 순서를
 * 순위로 읽는다. 그래서 유형은 이름으로만 부르고 순서를 두지 않는다.
 *
 * 사용법:
 *   node brief.mjs --in blueocean.json --keyword 본인부담상한제
 *   node brief.mjs --in blueocean.json --keyword 욕창 --myth "욕창은 잘 씻기면 안 생긴다"
 *   node brief.mjs --in blueocean.json --top 5          # 상위 5개 키워드를 한 번에
 *   node brief.mjs --in blueocean.json --keyword 욕창 --json
 */

import { readFile } from 'node:fs/promises';

/** 의료·건강 콘텐츠 금칙어. 제목 생성 단계에서 하드 컷으로 걸린다. */
const FORBIDDEN = [
  '완치', '무조건', '100%', '부작용이 없다', '부작용 없는',
  '모든 환자', '누구나 효과', '즉시 완화', '영구적으로',
];

/** 양산형 상투어. 있으면 그 후보는 다시 쓴다. */
const CLICHE = [
  '총정리', '놓치지 마세요', '완벽 정리', '한방에', '꿀팁',
  '충격', '경악', '이것만 알면', '단 하나',
];

function parseArgs(argv) {
  const out = { in: 'blueocean.json', keyword: null, myth: null, top: 0, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--keyword') out.keyword = argv[++i];
    else if (a === '--myth') out.myth = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]) || 0;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  }
  return out;
}

function usage() {
  console.log(`
제목 생성 브리프 — blueocean 결과를 생성 조건으로 바꾼다.

  --in <path>       blueocean 결과 JSON (기본 blueocean.json)
  --keyword <k>     대상 키워드
  --top <n>         상위 n개 키워드를 한 번에 (--keyword 대신)
  --myth <문장>     반박할 통념. 주면 반전형이 열린다. 없으면 반전형은 내지 않는다
  --json            JSON 출력
`);
}

/**
 * 어떤 유형을 낼 수 있는가.
 * 낼 수 없는 유형은 목록에서 빼고, 왜 뺐는지 남긴다.
 */
function applicableTypes(row, myth) {
  const types = [];

  // 질문형 — 검색어 자체가 질문의 대상이므로 언제나 가능하다.
  types.push({
    name: '질문형',
    can: true,
    guide: '독자가 실제로 검색창에 치는 말에 가깝게. 답을 제목에서 주지 않는다.',
  });

  // 대상·상황형 — 누가 언제 읽어야 하는지 말할 수 있을 때만.
  // 검색량이 지나치게 넓은 머리 키워드는 독자를 특정할 수 없다.
  const tooBroad = row.volume >= 100000;
  types.push({
    name: '대상·상황형',
    can: !tooBroad,
    why: tooBroad ? `검색량 ${row.volume.toLocaleString()} — 독자를 특정하기엔 너무 넓다` : null,
    guide: '누가, 언제 읽어야 하는지를 제목 안에 넣는다. 예: 퇴원 전, 보호자, 수술 다음 날.',
  });

  // 반전형 — 반박할 통념이 명시적으로 주어졌을 때만.
  types.push({
    name: '반전형',
    can: Boolean(myth),
    why: myth ? null : '반박할 통념(--myth)이 없다. 없는 통념을 지어내면 안 되므로 내지 않는다',
    guide: myth
      ? `통념: "${myth}" — 이것을 뒤집되 결과를 약속하지 않는다. 과정이나 조건을 뒤집는다.`
      : null,
  });

  return types;
}

/** 이 키워드에서 특별히 주의할 점. 실측값에서만 끌어낸다. */
function cautions(row) {
  const out = [];
  if (row.seasonal && row.peakMonth) {
    out.push(`성수기 ${row.peakMonth}월에 몰린다. 제목보다 발행 시점이 먼저다.`);
  }
  if (row.yoy !== null && row.yoy !== undefined) {
    if (row.yoy >= 1.3) out.push(`전년 대비 ${row.yoy}배 — 수요가 늘고 있다.`);
    else if (row.yoy <= 0.7) out.push(`전년 대비 ${row.yoy}배 — 수요가 줄고 있다. 주제 자체를 재검토.`);
  }
  if (row.commercialRatio !== null && row.commercialRatio >= 0.5) {
    out.push(`상위 ${Math.round(row.commercialRatio * 100)}%가 파는 글이다. 정보 글로 차별화할 여지가 크다.`);
  }
  if (row.tier === 'D') {
    out.push('레드오션이다. 제목을 다듬기 전에 주제를 다시 고르는 편이 낫다.');
  }
  return out;
}

function renderText(row, types, notes, myth) {
  const L = [];
  L.push(`제목 생성 브리프 — ${row.keyword}`);
  L.push('='.repeat(60));
  L.push('');
  L.push('## 실측값');
  L.push(`  월간검색수    ${row.volume?.toLocaleString() ?? '-'}`);
  L.push(`  블로그 글 수  ${row.blogDocs?.toLocaleString() ?? '-'}`);
  L.push(`  실질포화도    ${row.effectiveSaturation ?? '-'}   등급 ${row.tier} (${row.label})`);
  if (row.commercialRatio !== null && row.commercialRatio !== undefined) {
    L.push(`  상업성        상위 10건 중 ${Math.round(row.commercialRatio * 100)}%가 파는 글`);
  }
  if (row.yoy !== null && row.yoy !== undefined) {
    L.push(`  추세          전년 동기 대비 ${row.yoy}${row.seasonal ? `  · 성수기 ${row.peakMonth}월` : ''}`);
  }
  L.push('');

  if (notes.length) {
    L.push('## 이 키워드에서 주의할 것');
    for (const n of notes) L.push(`  · ${n}`);
    L.push('');
  }

  L.push('## 낼 수 있는 유형');
  L.push('  순서에 의미 없음. 유형은 품질 등급이 아니라 서로 다른 각도다.');
  L.push('');
  for (const t of types) {
    if (t.can) {
      L.push(`  [ 낸다 ]   ${t.name}`);
      L.push(`             ${t.guide}`);
    } else {
      L.push(`  [ 안 낸다 ] ${t.name}`);
      L.push(`             ${t.why}`);
    }
    L.push('');
  }

  L.push('## 하드 컷 — 하나라도 걸리면 그 후보는 버린다');
  L.push(`  금칙어   ${FORBIDDEN.join(' · ')}`);
  L.push(`  상투어   ${CLICHE.join(' · ')}`);
  L.push('  결과 약속 금지 — 낫는다·해결된다·받을 수 있다 로 끝맺지 않는다');
  L.push('  없는 사실 금지 — 브리프에 없는 통념·수치·사례를 만들지 않는다');
  L.push('');

  L.push('## 다음 단계');
  L.push('  1. 위 유형별로 후보를 하나씩 쓴다. 낼 수 없는 유형은 비워 둔다');
  L.push('  2. title-check 로 잰다:');
  L.push(`     node ~/.claude/skills/title-check/scripts/title-check.mjs \\`);
  L.push(`       --keyword ${row.keyword} --title "후보1" --title "후보2"`);
  L.push('  3. 측정값은 항목별 진단이다. 합산해서 우열을 만들지 않는다');
  L.push('  4. 최종 선택은 사람이 한다. 의료 콘텐츠는 발행 전 의료인 검토를 거친다');

  return L.join('\n');
}

async function main() {
  const opt = parseArgs(process.argv);

  let payload;
  try {
    payload = JSON.parse(await readFile(opt.in, 'utf8'));
  } catch (e) {
    console.error(`blueocean 결과를 읽지 못했다: ${opt.in}`);
    console.error('먼저 blueocean 을 돌려 JSON 을 만든다.');
    process.exit(2);
  }

  const rows = payload.rows || [];
  if (!rows.length) {
    console.error('결과에 행이 없다.');
    process.exit(2);
  }

  let targets;
  if (opt.keyword) {
    const hit = rows.find((r) => r.keyword === opt.keyword);
    if (!hit) {
      console.error(`'${opt.keyword}' 가 결과에 없다. 있는 키워드 예: ${rows.slice(0, 5).map((r) => r.keyword).join(', ')}`);
      process.exit(2);
    }
    targets = [hit];
  } else if (opt.top) {
    targets = rows.slice(0, opt.top);
  } else {
    console.error('--keyword 또는 --top 을 지정한다.');
    usage();
    process.exit(2);
  }

  const briefs = targets.map((row) => {
    // --myth 는 한 키워드를 겨냥한 것이므로 --top 다건에는 적용하지 않는다.
    const myth = targets.length === 1 ? opt.myth : null;
    return { row, types: applicableTypes(row, myth), notes: cautions(row), myth };
  });

  if (opt.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      forbidden: FORBIDDEN,
      cliche: CLICHE,
      briefs: briefs.map((b) => ({
        keyword: b.row.keyword,
        measured: {
          volume: b.row.volume,
          blogDocs: b.row.blogDocs,
          effectiveSaturation: b.row.effectiveSaturation,
          tier: b.row.tier,
          commercialRatio: b.row.commercialRatio,
          yoy: b.row.yoy ?? null,
          peakMonth: b.row.peakMonth ?? null,
        },
        cautions: b.notes,
        types: b.types,
      })),
    }, null, 2));
    return;
  }

  console.log(briefs.map((b) => renderText(b.row, b.types, b.notes, b.myth)).join('\n\n' + '─'.repeat(60) + '\n\n'));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
