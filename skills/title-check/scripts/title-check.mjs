#!/usr/bin/env node
/**
 * 제목 판정 — 후보 제목을 실측으로 비교한다.
 *
 * 이 도구는 제목을 만들지 않는다. 만드는 건 사람이나 모델이 한다.
 * 도구는 감으로 못 하는 것만 잰다.
 *
 * 왜 필요한가 — 같은 뜻인데 사람들이 치는 말은 하나뿐이다.
 * '환급' 3,310 / '돌려받기' 15. 221배다. 제목에 어느 쪽을 쓰느냐로 갈린다.
 * 이건 취향이 아니라 측정 대상이다.
 *
 * 네 가지를 잰다.
 *   1) 표현 수요   — 제목에 쓴 말과 그 동의 표현의 실제 검색량   [가장 중요]
 *   2) 키워드 포함 — 타깃 키워드가 실제 검색 표기로 들어 있는가
 *   3) 경쟁 제목   — 같은 키워드의 기존 글 제목과 무엇이 겹치는가
 *   4) 길이·상투어 — SERP 잘림 추정과 양산형 표현 검출
 *
 * 재지 못하는 것 — 명시한다.
 *   · 클릭률. 클릭 데이터가 없다. 어떤 제목이 더 눌릴지는 이 도구가 모른다.
 *   · 실제 검색 순위. 검색 API 는 유사도 정렬이지 순위가 아니다.
 *
 * 사용법
 *   title-check.mjs --keyword 본인부담상한제 --title "제목 후보 하나" --title "제목 후보 둘"
 *   title-check.mjs --keyword 욕창 --title "..." --compare 환급,환급금,돌려받기
 *   title-check.mjs --file src/content/guides/x.md
 *   title-check.mjs --keyword 섬망 --title "..." --json
 *
 * 옵션
 *   --keyword <k>    타깃 키워드. 경쟁 제목 조회와 포함 검사의 기준
 *   --title <t>      후보 제목. 여러 번 쓸 수 있다
 *   --file <path>    마크다운 프론트매터에서 title 과 keywords 를 읽는다
 *   --compare <a,b>  같은 뜻의 다른 표현들. 어느 쪽을 사람들이 치는지 잰다
 *   --no-rivals      경쟁 제목 조회 생략
 *   --json           JSON 출력
 *
 * 자격증명은 blueocean 스킬과 같다. ~/.claude/.naver-api.env 또는 ./.env.
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AD_BASE = 'https://api.searchad.naver.com';
const HUB_BASE = 'https://naverapihub.apigw.ntruss.com';
const HINT_MAX = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- env */

async function loadEnv() {
  for (const f of ['.env', join(homedir(), '.claude', '.naver-api.env')]) {
    if (!existsSync(f)) continue;
    const raw = await readFile(f, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (v && !process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}

/* ------------------------------------------------------- 수요 측정 */

function adHeaders(method, path) {
  const ts = Date.now().toString();
  return {
    'X-Timestamp': ts,
    'X-API-KEY': process.env.NAVER_AD_API_KEY,
    'X-Customer': process.env.NAVER_AD_CUSTOMER_ID,
    'X-Signature': createHmac('sha256', process.env.NAVER_AD_SECRET_KEY)
      .update(`${ts}.${method}.${path}`)
      .digest('base64'),
    'Content-Type': 'application/json',
  };
}

const toCount = (v) => {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (s.startsWith('<')) return 5; // '< 10' 은 바닥값. 보수적으로 읽는다
  const n = Number(s.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const squash = (s) => s.replace(/\s+/g, ''); // 키워드도구는 공백을 무시한다

/** 여러 표현의 월간검색수를 한 번에 잰다. 힌트 5개씩 끊는다. */
async function measureTerms(terms) {
  const out = new Map();
  const uniq = [...new Set(terms.map(squash))].filter(Boolean);
  for (let i = 0; i < uniq.length; i += HINT_MAX) {
    const chunk = uniq.slice(i, i + HINT_MAX);
    const path = '/keywordstool';
    const qs = new URLSearchParams({ hintKeywords: chunk.join(','), showDetail: '1' });
    try {
      const res = await fetch(`${AD_BASE}${path}?${qs}`, { headers: adHeaders('GET', path) });
      if (res.ok) {
        const json = await res.json();
        for (const k of json.keywordList ?? []) {
          const v = toCount(k.monthlyPcQcCnt) + toCount(k.monthlyMobileQcCnt);
          const prev = out.get(k.relKeyword);
          if (prev === undefined || v > prev) out.set(k.relKeyword, v);
        }
      }
    } catch {
      /* 한 묶음이 실패해도 나머지는 잰다 */
    }
    await sleep(400);
  }
  return out;
}

/* ------------------------------------------------------- 경쟁 제목 */

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ');

async function fetchRivalTitles(query, display = 20) {
  const res = await fetch(
    `${HUB_BASE}/search/v1/blog?${new URLSearchParams({ query, display: String(display), sort: 'sim' })}`,
    {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
        'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET,
      },
    }
  );
  if (!res.ok) return [];
  const json = await res.json();
  return (json.items ?? []).map((x) => stripTags(x.title).trim());
}

/* ------------------------------------------------------- 제목 분석 */

/**
 * 검색어가 될 수 없는 말들. 형태소 분석기 없이 거르는 최소한의 장치다.
 * 이걸 빼지 않으면 '생각 3,150' 같은 값이 진짜 신호를 덮는다.
 */
const STOPWORDS = new Set([
  '생각', '생각보다', '정말', '진짜', '완전', '너무', '그냥', '아주', '매우', '조금',
  '무엇', '어떻게', '어디서', '언제', '누가', '이것', '그것', '저것', '여기', '거기',
  '경우', '때문', '위해', '통해', '대해', '관해', '따라', '보다', '말고', '하지만',
  '그리고', '그러나', '또한', '다만', '역시', '이제', '지금', '오늘', '내일', '어제',
  '적게', '많이', '크게', '작게', '높게', '낮게', '빨리', '천천히', '함께', '따로',
  '돌아오나', '받아가세요', '알아보자', '알아보기', '해보자', '봅시다', '드립니다',
]);

/**
 * 한글 어휘를 뽑는다. 조사가 붙어 있으므로 완벽하지 않다.
 * 정확한 형태소 분석이 아니라 '무엇을 재볼지' 고르는 용도다.
 * 어미로 끝나는 활용형과 불용어는 뺀다 — 검색어가 아니기 때문이다.
 */
const VERB_ENDING = /(나|다|요|죠|까|네|군|는가|을까|ㄹ까|세요|습니다|합니다|해요|이다)$/;

function extractTerms(title) {
  const chunks = title.match(/[가-힣]{2,}/g) ?? [];
  const out = new Set();
  for (const c of chunks) {
    if (!STOPWORDS.has(c) && !VERB_ENDING.test(c)) out.add(c);
    // 흔한 조사를 떼어 본 형태도 후보에 넣는다
    const stripped = c.replace(/(을|를|이|가|은|는|의|에|에서|으로|로|와|과|도|만|까지|부터)$/, '');
    if (stripped.length >= 2 && stripped !== c && !STOPWORDS.has(stripped) && !VERB_ENDING.test(stripped)) {
      out.add(stripped);
    }
  }
  return [...out];
}

/** 글자 2-gram. 복합어가 조금 달라도 유사도가 잡힌다. */
function bigrams(s) {
  const t = s.replace(/[^가-힣a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * SERP 잘림 추정. 한글은 대체로 전각, 라틴·숫자는 반각이다.
 * 폰트·기기마다 다르므로 정확한 값이 아니라 눈금이다.
 */
function estimateWidth(title) {
  let em = 0;
  for (const ch of title) {
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch)) em += 1;
    else if (/\s/.test(ch)) em += 0.3;
    else if (/[—–…·「」『』《》]/.test(ch)) em += 1;
    else em += 0.5;
  }
  return Math.round(em * 10) / 10;
}

// 양산형·AI 글 신호. 애드센스 심사에서 불리하고 독자에게도 아무 정보가 없다.
const CLICHES = [
  '총정리', '완벽정리', '완벽 정리', '한눈에', '알아보자', '알아보기', '파헤치',
  '모든것', '모든 것', 'A to Z', 'AtoZ', '꿀팁', '필수', '주목', '놓치지', '숨은',
  '이것만', '싹', '핵심정리', '깔끔정리', '정리해봤', '정리해 봤', '대박', '충격',
];

function findCliches(title) {
  return CLICHES.filter((c) => title.includes(c));
}

/**
 * 기존 글 중 가장 비슷한 제목 하나를 찾는다.
 *
 * 20개 전체와의 합집합 비교는 쓸모가 없다. 제목이 20개면 어휘 합집합이
 * 거의 모든 것을 덮어서 항상 높게 나오거나, 복합어가 조금 달라 항상 0 이 나온다.
 * 실제로 알고 싶은 것은 '내 제목이 기존 어느 글과 같아 보이는가' 하나다.
 */
function closestRival(title, rivals) {
  if (!rivals.length) return null;
  const mine = bigrams(title);
  let best = null;
  for (const r of rivals) {
    const s = jaccard(mine, bigrams(r));
    if (!best || s > best.similarity) best = { title: r, similarity: Math.round(s * 100) / 100 };
  }
  return best;
}

/* ------------------------------------------------- 프론트매터 읽기 */

async function readFrontmatter(path) {
  const raw = await readFile(path, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const kws = [];
  const block = fm.match(/^keywords:\s*\n((?:\s+-\s*.+\n?)+)/m);
  if (block) for (const line of block[1].split(/\r?\n/)) {
    const k = line.match(/^\s+-\s*(.+)$/);
    if (k) kws.push(k[1].trim().replace(/^["']|["']$/g, ''));
  }
  return { title, keywords: kws };
}

/* -------------------------------------------------------------- main */

function parseArgs(argv) {
  const o = { titles: [], keyword: null, file: null, compare: [], rivals: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') o.titles.push(argv[++i]);
    else if (a === '--keyword') o.keyword = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--compare') o.compare = (argv[++i] ?? '').split(/[,:]/).map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-rivals') o.rivals = false;
    else if (a === '--json') o.json = true;
  }
  return o;
}

async function main() {
  await loadEnv();
  const opt = parseArgs(process.argv.slice(2));

  if (opt.file) {
    const fm = await readFrontmatter(opt.file);
    if (fm.title && !opt.titles.length) opt.titles.push(fm.title);
    if (!opt.keyword && fm.keywords?.length) opt.keyword = fm.keywords[0];
  }

  if (!opt.titles.length) {
    console.error('\n후보 제목이 없습니다. --title 로 주거나 --file 로 원고를 가리키세요.');
    console.error('  title-check.mjs --keyword 본인부담상한제 --title "후보1" --title "후보2"\n');
    process.exit(1);
  }

  for (const k of ['NAVER_AD_API_KEY', 'NAVER_AD_SECRET_KEY', 'NAVER_AD_CUSTOMER_ID']) {
    if (!process.env[k]) {
      console.error(`\n${k} 가 없습니다. ~/.claude/.naver-api.env 또는 ./.env 에 넣으세요.`);
      console.error('발급: searchad.naver.com → 도구 → API 사용 관리\n');
      process.exit(1);
    }
  }

  // 잴 표현을 모은다. 후보 제목들의 어휘 + 타깃 키워드 + 사용자가 준 동의 표현.
  const terms = new Set(opt.compare);
  if (opt.keyword) terms.add(opt.keyword);
  for (const t of opt.titles) for (const x of extractTerms(t)) terms.add(x);

  process.stderr.write(`표현 ${terms.size}개 수요 조회 중\n`);
  const vol = await measureTerms([...terms]);
  const v = (t) => vol.get(squash(t));

  let rivals = [];
  let rivalsUnreliable = false;
  if (opt.rivals && opt.keyword && process.env.NAVER_CLIENT_ID) {
    rivals = await fetchRivalTitles(opt.keyword, 20);
    // 검색 API 는 유사도 정렬이라 넓은 머리 키워드에서는 엉뚱한 문서가 올라온다.
    // '욕창' 한 단어로 조회하면 청구코드·고시가 나온다. 그 목록으로 제목을 판단하면 안 된다.
    // 타깃 키워드를 실제로 담은 제목이 절반에 못 미치면 신뢰할 수 없다고 표시한다.
    const onTopic = rivals.filter((t) => squash(t).includes(squash(opt.keyword))).length;
    rivalsUnreliable = rivals.length > 0 && onTopic / rivals.length < 0.5;
  }

  /**
   * 타깃 키워드가 제목에 들어 있는가.
   * 여러 단어 키워드('본인부담상한제 환급 신청')를 통째로 붙여 찾으면 늘 실패한다.
   * 사람이 그 순서 그대로 제목에 쓰지 않기 때문이다. 낱말이 모두 있으면 포함으로 본다.
   */
  const keywordParts = opt.keyword ? opt.keyword.split(/\s+/).filter(Boolean) : [];
  const includesKeyword = (title) => {
    if (!keywordParts.length) return null;
    const flat = squash(title);
    const missing = keywordParts.filter((p) => !flat.includes(squash(p)));
    return { ok: missing.length === 0, missing };
  };

  const results = opt.titles.map((title) => {
    const kwHit = includesKeyword(title);
    const termRows = extractTerms(title)
      .map((t) => ({ term: t, volume: v(t) ?? 0 }))
      .sort((a, b) => b.volume - a.volume);
    return {
      title,
      width: estimateWidth(title),
      chars: [...title].length,
      keywordIncluded: kwHit,
      cliches: findCliches(title),
      terms: termRows,
      closest: closestRival(title, rivals),
    };
  });

  if (opt.json) {
    console.log(JSON.stringify({ keyword: opt.keyword, rivals, results }, null, 2));
    return;
  }

  /* ------------------------------------------------------------ 출력 */

  const n = (x) => (x === undefined || x === null ? '?' : Number(x).toLocaleString());

  if (opt.compare.length) {
    console.log('\n■ 같은 뜻, 다른 표현 — 사람들이 실제로 치는 말');
    const rows = opt.compare.map((t) => [t, v(t)]).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const top = rows[0]?.[1] ?? 0;
    for (const [t, val] of rows) {
      const ratio = val > 0 && top > 0 ? (top / val).toFixed(0) : null;
      const note = val === top ? ' ← 이걸 쓰세요' : ratio && ratio > 3 ? `  (${ratio}배 적음)` : '';
      console.log('   ' + n(val).padStart(9) + '  ' + t + note);
    }
  }

  if (opt.keyword) {
    console.log(`\n■ 타깃 키워드  ${opt.keyword}  (월 ${n(v(opt.keyword))}회)`);
  }

  for (const r of results) {
    console.log('\n' + '─'.repeat(78));
    console.log(r.title);
    console.log('─'.repeat(78));

    // 길이
    const widthNote =
      r.width > 34 ? '구글·네이버 모두에서 잘립니다' :
      r.width > 30 ? '구글에서 잘릴 수 있습니다' : '잘림 없음';
    console.log(`  길이       ${r.chars}자 · 폭 ${r.width}em — ${widthNote}`);

    // 키워드 포함
    if (r.keywordIncluded) {
      console.log(
        r.keywordIncluded.ok
          ? '  키워드     포함'
          : `  키워드     빠짐: ${r.keywordIncluded.missing.join(', ')} — 검색어가 제목에 없습니다`
      );
    }

    // 상투어
    if (r.cliches.length) {
      console.log(`  상투어     ${r.cliches.join(', ')} — 양산형 신호입니다. 빼세요`);
    } else {
      console.log('  상투어     없음');
    }

    // 가장 비슷한 기존 글
    if (r.closest) {
      const pct = Math.round(r.closest.similarity * 100);
      const note = pct >= 50 ? ' — 같은 글로 보입니다' : pct >= 30 ? ' — 꽤 비슷합니다' : '';
      console.log(`  최근접     ${pct}%${note}`);
      console.log(`             ${r.closest.title.slice(0, 60)}`);
    }

    // 어휘별 수요
    console.log('  제목 속 표현의 검색 수요');
    for (const t of r.terms.slice(0, 8)) {
      const flag = t.volume === 0 ? '  ← 아무도 안 칩니다' : t.volume < 50 ? '  ← 거의 안 칩니다' : '';
      console.log('    ' + n(t.volume).padStart(9) + '  ' + t.term + flag);
    }
  }

  if (rivals.length) {
    console.log('\n' + '─'.repeat(78));
    console.log(`■ 기존 글 제목 — "${opt.keyword}" 로 조회한 ${rivals.length}건`);
    console.log('─'.repeat(78));
    if (rivalsUnreliable) {
      console.log('  [경고] 절반 넘는 결과에 타깃 키워드가 없습니다. 이 목록은 믿지 마세요.');
      console.log('         검색 API 는 유사도 정렬이라 넓은 키워드에서 엉뚱한 문서를 올립니다.');
      console.log('         독자가 실제로 칠 법한 더 긴 구절로 다시 보세요.');
      console.log('         낱말 두세 개짜리 롱테일이 가장 잘 나옵니다.\n');
    }
    for (const t of rivals.slice(0, 15)) console.log('  ' + t.slice(0, 68));
    const clicheCount = {};
    for (const t of rivals) for (const c of findCliches(t)) clicheCount[c] = (clicheCount[c] ?? 0) + 1;
    const cl = Object.entries(clicheCount).sort((a, b) => b[1] - a[1]);
    if (cl.length) {
      console.log('\n  이 코퍼스의 상투어: ' + cl.map(([c, n2]) => `${c}(${n2})`).join(', '));
      console.log('  같은 말을 쓰면 같은 글로 보입니다.');
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log('재지 못하는 것 — 클릭률과 실제 검색 순위. 클릭 데이터가 없고,');
  console.log('검색 API 는 유사도 정렬이지 순위가 아닙니다. 위 숫자로 순위를 예측하지 마세요.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
