#!/usr/bin/env node
/**
 * 블루오션 키워드 판정 — 수요는 있는데 공급이 얇은 자리를 찾는다.
 *
 * 어떤 니치든 시드 키워드 몇 개만 주면 끝까지 돈다.
 *   시드 → 연관키워드 확장 → 월간검색수 → 블로그 문서 수 → 광고 비율 → 추세 → 등급
 *
 * 왜 필요한가 — 검색량만 보고 주제를 고르면 레드오션에 들어간다.
 * 검색량 1만짜리 키워드에 이미 좋은 글이 10만 개 있으면 그건 기회가 아니다.
 * 반대로 검색량 3천에 제대로 답한 글이 없으면 그게 빈 자리다.
 *
 * 네 축으로 판정한다.
 *   1) 수요   — 월간검색수(PC+모바일).           네이버 검색광고 키워드도구
 *   2) 공급   — 이미 존재하는 블로그 글 수.       NAVER API HUB 검색
 *   3) 상업성 — 상위 10건 중 파는 글의 비율.      같은 검색 결과에서 계산
 *   4) 추세   — 전년 동기 대비 + 성수기 달.       DataLab 검색어트렌드
 *
 * 세 번째 축이 핵심이다. 문서가 많아도 전부 광고면 정보 공백은 그대로 남는다.
 * 그래서 포화도를 광고 비율만큼 깎은 '실질포화도'로 순위를 매긴다.
 *
 * 사용법
 *   blueocean.mjs --seeds 요양병원 요양원 장기요양등급     시드 확장 후 상위 후보 판정
 *   blueocean.mjs --exact 욕창 섬망 본인부담상한제         이 키워드들만 판정
 *   blueocean.mjs --seeds n8n 업무자동화 --min 1000 --top 60
 *   blueocean.mjs --seeds 요양병원 --exclude '채용|자격증|학원'
 *   blueocean.mjs --exact 욕창 --json
 *
 * 옵션
 *   --seeds <k...>   시드 키워드. 연관키워드로 확장한다
 *   --exact <k...>   확장 없이 이 키워드만 잰다
 *   --min <n>        확장 결과 중 이 검색량 이상만 (기본 500)
 *   --top <n>        판정할 키워드 개수 (기본 80). 키워드당 검색 API 2회를 쓴다
 *   --exclude <re>   제외할 키워드 정규식. 아래 '오염 키워드' 참고
 *   --out <path>     JSON 저장 경로 (기본 blueocean.json)
 *   --json           표 대신 JSON 을 표준출력으로
 *   --no-trend       추세 조회 생략 (빠르게 볼 때)
 *
 * 자격증명 — 다음 순서로 찾는다. 하나만 있으면 된다.
 *   1) 환경변수
 *   2) ./.env               (프로젝트 로컬)
 *   3) ~/.claude/.naver-api.env  (전역)
 *
 *   NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID   검색광고. 수요의 유일한 출처
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET                           API HUB. 공급과 추세
 *
 * 한계 — 공급은 네이버 블로그 생태계의 것이다. 구글을 노리는 사이트라면 절대값이 아니라
 * 키워드 사이의 상대 비교로만 읽는다. 광고 비율은 휴리스틱이고 정확한 분류가 아니다.
 */
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AD_BASE = 'https://api.searchad.naver.com';
// 2026 년에 NAVER API HUB 로 이관됐다. 구형 openapi.naver.com + X-Naver-Client-* 는 401 이 난다.
const HUB_BASE = 'https://naverapihub.apigw.ntruss.com';

const HINT_MAX = 5; // 검색광고 API 는 한 번에 힌트 5개까지
const AD_THROTTLE = 400; // 더 빠르면 429 가 난다
const HUB_THROTTLE = 110;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- env */

async function loadEnv() {
  const candidates = ['.env', join(homedir(), '.claude', '.naver-api.env')];
  for (const f of candidates) {
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

function requireKeys(keys, what, where) {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error(`\n${what} 자격증명이 없습니다: ${missing.join(', ')}`);
  console.error(`발급: ${where}`);
  console.error(`넣을 곳: ./.env 또는 ${join(homedir(), '.claude', '.naver-api.env')}\n`);
  process.exit(1);
}

/* ------------------------------------------------- 수요 · 검색광고 API */

/** 서명 대상은 `timestamp.METHOD.path` 이고 쿼리스트링은 제외한다. */
function adHeaders(method, path) {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', process.env.NAVER_AD_SECRET_KEY)
    .update(`${ts}.${method}.${path}`)
    .digest('base64');
  return {
    'X-Timestamp': ts,
    'X-API-KEY': process.env.NAVER_AD_API_KEY,
    'X-Customer': process.env.NAVER_AD_CUSTOMER_ID,
    'X-Signature': sig,
    'Content-Type': 'application/json',
  };
}

/** '< 10' 같은 문자열이 섞여 온다. 바닥값이므로 보수적으로 5 로 읽는다. */
function toCount(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (s.startsWith('<')) return 5;
  const n = Number(s.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// 검색광고 API 는 hintKeywords 에 공백을 허용하지 않는다. 키워드도구가 공백을 무시하므로 붙여 보낸다.
const normalize = (s) => s.replace(/\s+/g, '');

async function fetchKeywords(hints) {
  const path = '/keywordstool';
  const qs = new URLSearchParams({ hintKeywords: hints.map(normalize).join(','), showDetail: '1' });
  const res = await fetch(`${AD_BASE}${path}?${qs}`, { headers: adHeaders('GET', path) });
  if (!res.ok) throw new Error(`검색광고 API ${res.status} — ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  return (json.keywordList ?? []).map((k) => ({
    keyword: k.relKeyword,
    pc: toCount(k.monthlyPcQcCnt),
    mobile: toCount(k.monthlyMobileQcCnt),
    volume: toCount(k.monthlyPcQcCnt) + toCount(k.monthlyMobileQcCnt),
    adCompetition: k.compIdx ?? '',
  }));
}

async function expandSeeds(seeds, onProgress) {
  const merged = new Map();
  for (let i = 0; i < seeds.length; i += HINT_MAX) {
    const chunk = seeds.slice(i, i + HINT_MAX);
    onProgress?.(Math.min(i + chunk.length, seeds.length), seeds.length);
    try {
      for (const row of await fetchKeywords(chunk)) {
        const prev = merged.get(row.keyword);
        if (!prev || row.volume > prev.volume) merged.set(row.keyword, row);
      }
    } catch (e) {
      console.error(`\n[${chunk.join(', ')}] 실패 — ${e.message}`);
    }
    await sleep(AD_THROTTLE);
  }
  return [...merged.values()].sort((a, b) => b.volume - a.volume);
}

/* ------------------------------------------------ 공급 · API HUB 검색 */

const hubHeaders = () => ({
  'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
  'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET,
});

/** 404 = 그런 검색 종류가 없다. 401 = 콘솔에서 그 API 를 등록하지 않았다. */
async function searchDocs(kind, query, display = 10) {
  const qs = new URLSearchParams({ query, display: String(display), sort: 'sim' });
  const res = await fetch(`${HUB_BASE}/search/v1/${kind}?${qs}`, { headers: hubHeaders() });
  if (!res.ok) return { total: null, items: [], status: res.status };
  const json = await res.json();
  return { total: Number(json.total ?? 0), items: json.items ?? [] };
}

/**
 * 상위 결과 중 파는 글의 비율.
 * 블로그 이름·제목·요약에서 업체·상담 유도 신호를 센다.
 * 정확한 분류가 아니라 '이 검색어의 상위가 광고로 덮여 있는가' 를 보는 거친 지표다.
 */
const AD_SIGNAL =
  /병원|의원|한의원|약국|클리닉|센터|원장|대표|상담|문의|예약|견적|카톡|오픈채팅|무료상담|추천업체|업체|대행|공식블로그|체험단|협찬|제공받아/;
const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '');

function commercialRatio(items) {
  if (!items.length) return null;
  let hit = 0;
  for (const it of items) {
    const blob = [it.bloggername, stripTags(it.title), stripTags(it.description)].join(' ');
    if (AD_SIGNAL.test(blob)) hit++;
  }
  return Math.round((hit / items.length) * 100) / 100;
}

/* --------------------------------------- 추세 · DataLab 검색어트렌드 */

/**
 * 24개월을 받아 전년 동기 대비로 낸다.
 *
 * 12개월치의 '최근 3개월 / 첫 3개월' 로는 안 된다. 계절성이 큰 키워드에서 거짓 하락이 나온다.
 * 실제로 본인부담상한제는 매년 8~9월에 환급 안내문이 나가 그때만 5배로 뛴다.
 * 12개월 창의 앞쪽에 그 스파이크가 걸리면 0.24 로 찍히지만, 같은 달끼리 비교하면 1.74 다.
 *
 * 경로 주의 — 하이픈이 들어간 search-trend 다. datalab/* 계열은 전부 404 다.
 */
async function fetchTrend(keywords) {
  const end = new Date();
  end.setMonth(end.getMonth() - 1); // 당월은 집계가 덜 찼다
  const start = new Date(end);
  start.setMonth(start.getMonth() - 24);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const res = await fetch(`${HUB_BASE}${process.env.NAVER_TREND_PATH || '/search-trend/v1/search'}`, {
    method: 'POST',
    headers: { ...hubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: fmt(start),
      endDate: fmt(end),
      timeUnit: 'month',
      keywordGroups: keywords.slice(0, 5).map((k) => ({ groupName: k, keywords: [k] })),
    }),
  });
  if (!res.ok) return {};
  const json = await res.json();
  const out = {};
  for (const g of json.results ?? []) {
    const d = g.data ?? [];
    if (d.length < 18) continue; // 전년 대비를 내려면 최소 1년 반은 있어야 한다
    const cut = d.length - 12;
    const prev = d.slice(0, cut).reduce((a, x) => a + x.ratio, 0) / cut;
    const curr = d.slice(cut).reduce((a, x) => a + x.ratio, 0) / 12;
    const peak = d.slice(cut).reduce((b, x) => (x.ratio > b.ratio ? x : b), d[cut]);
    out[g.title] = {
      yoy: prev > 0 ? Math.round((curr / prev) * 100) / 100 : null,
      peakMonth: Number(peak.period.slice(5, 7)),
      // 최고점이 평균의 2배를 넘으면 계절 키워드로 본다. 발행 시점이 중요해진다.
      seasonal: curr > 0 && peak.ratio / curr > 2,
    };
  }
  return out;
}

/* ---------------------------------------------------------------- 판정 */

/** 포화도 = 블로그 글 수 / 월간검색수. 검색 1회당 이미 존재하는 글이 몇 편인가. */
function grade(saturation) {
  if (saturation === null) return { tier: '?', label: '측정불가' };
  if (saturation < 3) return { tier: 'A', label: '블루오션' };
  if (saturation < 10) return { tier: 'B', label: '양호' };
  if (saturation < 40) return { tier: 'C', label: '경쟁' };
  return { tier: 'D', label: '레드오션' };
}

/** 상위가 전부 광고면 문서가 많아도 정보 공백이 남는다. 포화도를 그만큼 깎는다. */
function effectiveSaturation(saturation, comRatio) {
  if (saturation === null) return null;
  if (comRatio === null) return saturation;
  return Math.round(saturation * (1 - comRatio * 0.5) * 100) / 100;
}

/* -------------------------------------------------------------- main */

function parseArgs(argv) {
  const out = { seeds: [], exact: [], min: 500, top: 80, exclude: null, out: 'blueocean.json', json: false, trend: true };
  let mode = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') { mode = 'seeds'; continue; }
    if (a === '--exact') { mode = 'exact'; continue; }
    if (a === '--json') { out.json = true; mode = null; continue; }
    if (a === '--no-trend') { out.trend = false; mode = null; continue; }
    if (a === '--min') { out.min = Number(argv[++i]); mode = null; continue; }
    if (a === '--top') { out.top = Number(argv[++i]); mode = null; continue; }
    if (a === '--exclude') { out.exclude = new RegExp(argv[++i]); mode = null; continue; }
    if (a === '--out') { out.out = argv[++i]; mode = null; continue; }
    if (a.startsWith('--')) { mode = null; continue; }
    if (mode) out[mode].push(a);
  }
  return out;
}

async function main() {
  await loadEnv();
  const opt = parseArgs(process.argv.slice(2));

  if (!opt.seeds.length && !opt.exact.length) {
    console.error('\n시드가 없습니다. --seeds 또는 --exact 로 키워드를 주세요.');
    console.error('  blueocean.mjs --seeds 요양병원 요양원 장기요양등급');
    console.error('  blueocean.mjs --exact 욕창 섬망 본인부담상한제\n');
    process.exit(1);
  }

  requireKeys(
    ['NAVER_AD_API_KEY', 'NAVER_AD_SECRET_KEY', 'NAVER_AD_CUSTOMER_ID'],
    '검색광고 API(수요)',
    'searchad.naver.com → 도구 → API 사용 관리 (무료, 결제정보 불필요)'
  );
  requireKeys(
    ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'],
    'NAVER API HUB(공급·추세)',
    'ncloud.com → NAVER API HUB → Application 등록 → 검색(블로그·뉴스)과 Data Lab 체크'
  );

  // 1) 수요
  let targets;
  if (opt.exact.length) {
    process.stderr.write(`수요 조회 ${opt.exact.length}개\n`);
    const rows = await expandSeeds(opt.exact);
    const byKey = new Map(rows.map((r) => [r.keyword, r]));
    targets = opt.exact.map(
      (k) => byKey.get(normalize(k)) ?? { keyword: normalize(k), volume: 0, pc: 0, mobile: 0, adCompetition: '' }
    );
  } else {
    targets = await expandSeeds(opt.seeds, (n, total) =>
      process.stderr.write(`시드 확장 ${n}/${total}\r`)
    );
    process.stderr.write(`\n연관키워드 ${targets.length}개\n`);
    targets = targets.filter((r) => r.volume >= opt.min);
    if (opt.exclude) targets = targets.filter((r) => !opt.exclude.test(r.keyword));
    targets = targets.slice(0, opt.top);
  }

  if (!targets.length) {
    console.error('판정할 키워드가 없습니다. --min 을 낮추거나 시드를 바꾸세요.');
    process.exit(1);
  }

  // 2) 공급 + 3) 상업성
  const rows = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    process.stderr.write(`판정 중 ${i + 1}/${targets.length}  ${t.keyword}          \r`);
    const blog = await searchDocs('blog', t.keyword, 10);
    await sleep(HUB_THROTTLE);
    const news = await searchDocs('news', t.keyword, 1);
    await sleep(HUB_THROTTLE);

    const sat = blog.total !== null && t.volume > 0 ? Math.round((blog.total / t.volume) * 100) / 100 : null;
    const com = commercialRatio(blog.items);
    const eff = effectiveSaturation(sat, com);
    rows.push({
      keyword: t.keyword,
      volume: t.volume,
      pc: t.pc,
      mobile: t.mobile,
      blogDocs: blog.total,
      newsDocs: news.total,
      saturation: sat,
      commercialRatio: com,
      effectiveSaturation: eff,
      ...grade(eff),
    });
  }
  process.stderr.write('\n');

  const ranked = rows
    .filter((r) => r.effectiveSaturation !== null)
    .sort((a, b) => a.effectiveSaturation - b.effectiveSaturation);

  // 4) 추세 — 상위 40개에만. 5개씩 끊어 호출한다.
  if (opt.trend) {
    const list = ranked.slice(0, 40).map((r) => r.keyword);
    const trend = {};
    for (let i = 0; i < list.length; i += 5) {
      Object.assign(trend, await fetchTrend(list.slice(i, i + 5)));
      await sleep(HUB_THROTTLE);
    }
    for (const r of ranked) {
      const t = trend[r.keyword];
      if (!t) continue;
      r.yoy = t.yoy;
      r.peakMonth = t.peakMonth;
      r.seasonal = t.seasonal;
    }
  }

  const payload = { generatedAt: new Date().toISOString(), seeds: opt.seeds, rows: ranked };
  await writeFile(opt.out, JSON.stringify(payload, null, 1), 'utf8');

  if (opt.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const n = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());
  console.log('');
  console.log(
    '키워드'.padEnd(22) + '수요'.padStart(9) + '블로그글'.padStart(12) + '포화'.padStart(9) +
    '광고'.padStart(7) + '실질포화'.padStart(10) + 'YoY'.padStart(7) + '성수기'.padStart(8) + '  등급'
  );
  console.log('-'.repeat(96));
  for (const r of ranked.slice(0, 60)) {
    const ad = r.commercialRatio === null ? '-' : Math.round(r.commercialRatio * 100) + '%';
    const peak = r.peakMonth ? (r.seasonal ? r.peakMonth + '월!' : r.peakMonth + '월') : '-';
    console.log(
      r.keyword.slice(0, 20).padEnd(22) +
        n(r.volume).padStart(9) +
        n(r.blogDocs).padStart(12) +
        String(r.saturation ?? '-').padStart(9) +
        ad.padStart(7) +
        String(r.effectiveSaturation ?? '-').padStart(10) +
        String(r.yoy ?? '-').padStart(7) +
        peak.padStart(8) +
        '  ' + r.tier + ' ' + r.label
    );
  }
  console.log('-'.repeat(96));
  console.log('포화     = 블로그 글 수 / 월간검색수. 낮을수록 빈 자리.');
  console.log('광고     = 상위 10건 중 파는 글의 비율. 높으면 글이 많아도 정보 공백이 남는다.');
  console.log('실질포화 = 포화를 광고 비율만큼 깎은 값. 이 순서로 정렬했다.');
  console.log('YoY      = 최근 12개월 / 그 이전 12개월. 계절성을 상쇄한 값. 1.0 이상이면 성장.');
  console.log('성수기   = 연중 최고점의 달. ! 는 최고점이 평균의 2배를 넘는 계절 키워드.');
  console.log('등급     = A 블루오션(<3) · B 양호(<10) · C 경쟁(<40) · D 레드오션');
  console.error(`\n${opt.out} 에 저장했습니다. ${ranked.length}개.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
