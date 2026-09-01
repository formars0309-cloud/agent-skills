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
 *   5) 열기   — 최근 글이 쌓이는 속도.             블로그 검색 sort=date  (--hot 일 때만)
 *   6) 수익   — 광고 슬롯 수 · 경쟁도 · 광고 CTR.  검색광고 API 같은 응답  (--revenue)
 *
 * 세 번째 축이 핵심이다. 문서가 많아도 전부 광고면 정보 공백은 그대로 남는다.
 * 그래서 포화도를 광고 비율만큼 깎은 '실질포화도'로 순위를 매긴다.
 *
 * 다만 실질포화도만으로 줄을 세우면 못 쓸 1위가 나온다. 수요 10에 글 0편인 키워드는
 * 포화 0 으로 A등급 최상위에 오르지만 아무도 안 찾는 주제다. 트래픽을 원한다면
 * --hot 을 쓴다. 수요와 공백을 곱해 '이 글로 실제로 몇 명이 오는가'로 줄을 세운다.
 *
 * 사용법
 *   blueocean.mjs --seeds 요양병원 요양원 장기요양등급     시드 확장 후 상위 후보 판정
 *   blueocean.mjs --exact 욕창 섬망 본인부담상한제         이 키워드들만 판정
 *   blueocean.mjs --seeds n8n 업무자동화 --min 1000 --top 60
 *   blueocean.mjs --seeds 요양병원 --exclude '채용|자격증|학원'
 *   blueocean.mjs --seeds 명조 명조공략 --hot 30      트래픽 기대치 상위 30개
 *   blueocean.mjs --exact 욕창 --json
 *
 * 옵션
 *   --seeds <k...>   시드 키워드. 연관키워드로 확장한다
 *   --exact <k...>   확장 없이 이 키워드만 잰다
 *   --hot <n>        기회점수 순 상위 n개. 열기(신규글 속도) 축을 함께 잰다
 *   --revenue <n>    수익점수 순 상위 n개. 광고 단가 축으로 줄을 세운다
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
    // 수익 축. 같은 응답에 이미 들어 있으므로 추가 호출이 없다.
    adDepth: Number(k.plAvgDepth ?? 0),          // 그 검색어에 붙는 광고 슬롯 수. 0 이면 광고주가 없다
    adCtr: Math.round(((Number(k.monthlyAvePcCtr ?? 0) + Number(k.monthlyAveMobileCtr ?? 0)) / 2) * 100) / 100,
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

/* ------------------------------------------ 열기 · 최근 글 쌓이는 속도 */

/**
 * 같은 '글 1,000편'이라도 2년에 걸쳐 쌓인 것과 지난주에 쏟아진 것은 완전히 다르다.
 * 앞은 죽은 주제고 뒤는 지금 터지는 이슈다. 포화도는 이 둘을 구분하지 못한다.
 *
 * sort=date 로 최신 100편을 받아 날짜 간격을 본다.
 *   postsPerDay  최신 100편이 며칠에 걸쳐 쌓였나 → 하루에 몇 편씩 올라오는가
 *   fresh30      그 100편 중 30일 이내가 몇 %인가 → 지금도 살아 있는 주제인가
 *   lastDays     가장 최근 글이 며칠 전인가 → 아무도 안 쓰면 커진다
 *
 * 표본이 10편이면 안 된다. 뜨거운 키워드는 최신 10편이 전부 같은 날이라 속도가 10 에서
 * 천장에 걸리고, 하루 12편짜리와 하루 200편짜리가 같은 값으로 찍힌다. 100편은 API 호출
 * 수가 같으면서 해상도만 열 배다.
 *
 * 해석은 양날이다. 속도가 빠르면 트래픽이 있다는 뜻이면서 동시에 남들도 달려들고
 * 있다는 뜻이다. 그래서 점수에 넣지 않고 칼럼으로만 보여준다. 판단은 사람이 한다.
 */
async function fetchRecency(query) {
  const qs = new URLSearchParams({ query, display: '100', sort: 'date' });
  const res = await fetch(`${HUB_BASE}/search/v1/blog?${qs}`, { headers: hubHeaders() });
  if (!res.ok) return null;
  const json = await res.json();
  const items = json.items ?? [];

  const days = [];
  for (const it of items) {
    const m = String(it.postdate ?? '').match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) continue;
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    days.push(Math.floor((Date.now() - d) / 86400000));
  }
  if (days.length < 2) return null;
  days.sort((a, b) => a - b); // 오래된 정도 오름차순 = 최신이 앞

  // 속도는 최신 절반으로만 잰다. 표본 전체를 쓰면 꼬리가 결과를 뒤집는다.
  // 명조청초는 출시 11일차인데 표본 100편 중 29편이 30일보다 오래됐다 — 네이버가
  // '청초' 를 따로 매칭해 옛 글을 물어온 탓이다. 그 29편이 span 을 400일로 늘리면
  // 하루 62편짜리 키워드가 0.2 로 찍힌다. 중앙값 쪽만 보면 꼬리에 흔들리지 않는다.
  const half = Math.max(2, Math.ceil(days.length / 2));
  const span = days[half - 1] - days[0];
  return {
    postsPerDay: Math.round((half / Math.max(span, 1)) * 10) / 10,
    fresh30: Math.round((days.filter((d) => d <= 30).length / days.length) * 100) / 100,
    lastDays: days[0],
    sampleTitle: stripTags(items[0]?.title ?? ''),
  };
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

/**
 * 기회점수 — 이 키워드로 글을 썼을 때 한 달에 몇 명이 올 것인가.
 *
 * 실질포화도는 '빈 자리인가'만 답한다. 수요 10에 글 0편이면 포화 0 으로 1위가 되지만
 * 그 글은 월 10회 노출된다. 반대로 수요 4,000에 포화 0.2 인 키워드가 진짜 자리다.
 * 그래서 수요와 공백을 곱한다.
 *
 *   reach = 1 / (1 + 실질포화/3)      공백이 클수록 상위에 붙을 확률이 높다
 *                                     포화 0 → 1.00, 3 → 0.50, 10 → 0.23, 40 → 0.07
 *   scale = 1 / (1 + 문서수/20000)    포화도가 같아도 절대 문서량이 크면 신규 블로그가 못 뚫는다
 *                                     684편 → 0.97, 2.2만편 → 0.47, 12.6만편 → 0.14
 *   점수  = 수요 × 0.3 × reach × scale        0.3 은 상위 노출 시 클릭률 가정
 *
 * scale 이 없으면 헤드 키워드가 무조건 1위가 된다. 명조(수요 41,100 · 글 12.6만)는
 * 포화 3.06 이라 reach 만으로는 6,100점으로 최상위지만, 개인 블로그가 12.6만 편을
 * 제치고 올라갈 확률은 그렇지 않다. scale 을 곱하면 836점으로 내려가 신규 캐릭터
 * 키워드(명조청초 1,079점) 아래에 놓인다. 실제로 뚫리는 쪽이 위로 온다.
 *
 * 절대값은 의미 없다. 같은 실행 안에서 키워드끼리 비교하는 용도다.
 */
function opportunityScore(volume, effSat, blogDocs) {
  if (!volume || effSat === null) return 0;
  const reach = 1 / (1 + effSat / 3);
  const scale = 1 / (1 + (blogDocs ?? 0) / 20000);
  return Math.round(volume * 0.3 * reach * scale);
}

/**
 * 수익 계수 — 트래픽 1회가 얼마짜리인가.
 *
 * 애드포스트 수익은 노출 × 단가다. 그런데 지금까지의 축은 전부 노출만 재고 있었다.
 * 그래서 트래픽이 크고 돈이 안 되는 주제를 1위로 올린다. 실제로 손흥민은 월 413,400회
 * 검색인데 plAvgDepth 0, compIdx 낮음, 광고 CTR 0.00 이다. 광고주가 아예 붙지 않는다.
 * 같은 시점 실손보험은 검색량이 22분의 1(18,480)인데 광고 깊이 10, 경쟁 높음, CTR 3.32 다.
 *
 *   compIdx    낮음 0.2 · 중간 0.6 · 높음 1.0
 *   adDepth    0~15. 그 검색어에 붙는 광고 슬롯 수. 광고주 수요의 직접 지표다
 *   계수       comp × (0.15 + adDepth/10)
 *
 * 0.15 은 바닥값이다. 광고 슬롯이 0 이어도 콘텐츠 광고로 소액은 붙으므로 0 으로 죽이지 않는다.
 * 손흥민 0.03 · 명조 0.33 · 실손보험 1.15 — 대략 1 : 11 : 38 이다.
 *
 * 절대 단가가 아니라 키워드 사이의 상대 배율이다. 실제 CPC 는 네이버가 공개하지 않는다.
 */
const COMP_WEIGHT = { '낮음': 0.2, '중간': 0.6, '높음': 1.0 };
function revenueFactor(compIdx, adDepth) {
  const comp = COMP_WEIGHT[compIdx] ?? 0.4; // 미상은 중간 아래로 본다
  return Math.round(comp * (0.15 + (adDepth ?? 0) / 10) * 100) / 100;
}

/** 상위가 전부 광고면 문서가 많아도 정보 공백이 남는다. 포화도를 그만큼 깎는다. */
function effectiveSaturation(saturation, comRatio) {
  if (saturation === null) return null;
  if (comRatio === null) return saturation;
  return Math.round(saturation * (1 - comRatio * 0.5) * 100) / 100;
}

/* ------------------------------------------------------------ 표 출력 */

// 한글은 터미널에서 두 칸을 먹는다. 글자 수로 padEnd 하면 표가 어긋난다.
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const vw = (x) => [...String(x)].reduce((w, c) => w + (CJK.test(c) ? 2 : 1), 0);
const padR = (x, n) => String(x) + ' '.repeat(Math.max(0, n - vw(x)));
const padL = (x, n) => ' '.repeat(Math.max(0, n - vw(x))) + String(x);
function clip(x, n) {
  let w = 0, o = '';
  for (const c of String(x)) {
    const cw = CJK.test(c) ? 2 : 1;
    if (w + cw > n) break;
    o += c; w += cw;
  }
  return o;
}

const pct = (v) => (v === null || v === undefined ? '-' : Math.round(v * 100) + '%');
const num = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());

/* -------------------------------------------------------------- main */

function parseArgs(argv) {
  const out = { seeds: [], exact: [], min: 500, top: 80, exclude: null, out: 'blueocean.json', json: false, trend: true, hot: 0, revenue: 0 };
  let mode = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') { mode = 'seeds'; continue; }
    if (a === '--exact') { mode = 'exact'; continue; }
    if (a === '--json') { out.json = true; mode = null; continue; }
    if (a === '--no-trend') { out.trend = false; mode = null; continue; }
    if (a === '--min') { out.min = Number(argv[++i]); mode = null; continue; }
    if (a === '--top') { out.top = Number(argv[++i]); mode = null; continue; }
    if (a === '--hot') { out.hot = Number(argv[++i]) || 30; mode = null; continue; }
    if (a === '--revenue') { out.revenue = Number(argv[++i]) || 30; mode = null; continue; }
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
  // --hot / --revenue 는 넓게 깔아 놓고 그중 상위를 뽑는 방식이다. 후보가 좁으면 뽑을 게 없다.
  const pick = Math.max(opt.hot, opt.revenue);
  if (pick && opt.top < pick * 2) opt.top = Math.min(pick * 3, 200);

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
      (k) => byKey.get(normalize(k)) ?? { keyword: normalize(k), volume: 0, pc: 0, mobile: 0, adCompetition: '', adDepth: 0, adCtr: 0 }
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
      opportunity: opportunityScore(t.volume, eff, blog.total),
      adDepth: t.adDepth ?? 0,
      adCompetition: t.adCompetition ?? '',
      adCtr: t.adCtr ?? 0,
      revenueFactor: revenueFactor(t.adCompetition, t.adDepth),
      revenueScore: Math.round(opportunityScore(t.volume, eff, blog.total) * revenueFactor(t.adCompetition, t.adDepth)),
      ...grade(eff),
    });
  }
  process.stderr.write('\n');

  // --revenue 면 기대 수익 순, --hot 이면 기대 트래픽 순, 아니면 종전대로 빈 자리 순.
  const ranked = rows
    .filter((r) => r.effectiveSaturation !== null)
    .sort((a, b) => {
      if (opt.revenue) return b.revenueScore - a.revenueScore;
      if (opt.hot) return b.opportunity - a.opportunity;
      return a.effectiveSaturation - b.effectiveSaturation;
    });

  // 4) 열기 — --hot 일 때만. 상위 N 개에 키워드당 1회 더 쓴다. --revenue 는 필요 없다.
  if (opt.hot && !opt.revenue) {
    const head = ranked.slice(0, opt.hot);
    for (let i = 0; i < head.length; i++) {
      process.stderr.write(`열기 측정 ${i + 1}/${head.length}  ${head[i].keyword}          \r`);
      const rec = await fetchRecency(head[i].keyword);
      if (rec) Object.assign(head[i], rec);
      await sleep(HUB_THROTTLE);
    }
    process.stderr.write('\n');
  }

  // 5) 추세 — 상위 40개에만. 5개씩 끊어 호출한다.
  if (opt.trend) {
    const list = ranked.slice(0, Math.max(40, opt.hot, opt.revenue)).map((r) => r.keyword);
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

  const peakOf = (r) => (r.peakMonth ? r.peakMonth + '월' + (r.seasonal ? '!' : '') : '-');

  if (opt.revenue) printRevenue(ranked.slice(0, opt.revenue), peakOf);
  else if (opt.hot) printHot(ranked.slice(0, opt.hot), peakOf);
  else printFull(ranked.slice(0, 60), peakOf);

  console.error(`\n${opt.out} 에 저장했습니다. ${ranked.length}개.`);
}

/** 기본 표 — 빈 자리 순. 종전 형식 그대로다. */
function printFull(list, peakOf) {
  console.log('');
  console.log(
    padR('키워드', 22) + padL('수요', 9) + padL('블로그글', 12) + padL('포화', 9) +
    padL('광고', 7) + padL('실질포화', 10) + padL('YoY', 7) + padL('성수기', 8) + '  등급'
  );
  console.log('-'.repeat(96));
  for (const r of list) {
    console.log(
      padR(clip(r.keyword, 20), 22) +
        padL(num(r.volume), 9) + padL(num(r.blogDocs), 12) +
        padL(r.saturation ?? '-', 9) + padL(pct(r.commercialRatio), 7) +
        padL(r.effectiveSaturation ?? '-', 10) + padL(r.yoy ?? '-', 7) +
        padL(peakOf(r), 8) + '  ' + r.tier + ' ' + r.label
    );
  }
  console.log('-'.repeat(96));
  console.log('포화     = 블로그 글 수 / 월간검색수. 낮을수록 빈 자리.');
  console.log('광고     = 상위 10건 중 파는 글의 비율. 높으면 글이 많아도 정보 공백이 남는다.');
  console.log('실질포화 = 포화를 광고 비율만큼 깎은 값. 이 순서로 정렬했다.');
  console.log('YoY      = 최근 12개월 / 그 이전 12개월. 계절성을 상쇄한 값. 1.0 이상이면 성장.');
  console.log('성수기   = 연중 최고점의 달. ! 는 최고점이 평균의 2배를 넘는 계절 키워드.');
  console.log('등급     = A 블루오션(<3) · B 양호(<10) · C 경쟁(<40) · D 레드오션');
}

/**
 * --revenue 표 — 기대 수익 순.
 * 트래픽만 크고 광고주가 없는 주제를 걸러낸다. 연예·스포츠·시사가 여기서 무너진다.
 */
function printRevenue(list, peakOf) {
  console.log('');
  console.log(
    padL('#', 3) + ' ' + padR('키워드', 22) + padL('수요', 10) + padL('실질포화', 10) +
    padL('광고깊이', 10) + padL('경쟁', 7) + padL('광고CTR', 9) +
    padL('YoY', 7) + padL('기회점수', 10) + padL('단가배율', 10) + padL('수익점수', 10) + '  등급'
  );
  console.log('='.repeat(116));
  list.forEach((r, i) => {
    console.log(
      padL(i + 1, 3) + ' ' + padR(clip(r.keyword, 20), 22) +
        padL(num(r.volume), 10) + padL(r.effectiveSaturation ?? '-', 10) +
        padL(r.adDepth ?? 0, 10) + padL(r.adCompetition || '-', 7) +
        padL((r.adCtr ?? 0).toFixed(2), 9) + padL(r.yoy ?? '-', 7) +
        padL(num(r.opportunity), 10) + padL((r.revenueFactor ?? 0).toFixed(2), 10) +
        padL(num(r.revenueScore), 10) + '  ' + r.tier
    );
  });
  console.log('='.repeat(116));
  console.log('광고깊이 = 그 검색어에 붙는 광고 슬롯 수(0~15). 0 이면 광고주가 없다 = 애드포스트 수익도 없다.');
  console.log('광고CTR  = 광고 클릭률 평균(%). 0.00 이면 아무도 그 검색에서 광고를 안 누른다.');
  console.log('단가배율 = 경쟁도 × (0.15 + 광고깊이/10). 키워드 사이의 상대 배율이지 실제 CPC 가 아니다.');
  console.log('수익점수 = 기회점수 × 단가배율. 이 순서로 정렬했다.');
  console.log('등급     = A 블루오션(<3) · B 양호(<10) · C 경쟁(<40) · D 레드오션');
}

/**
 * --hot 표 — 기대 트래픽 순.
 * 오른쪽 세 칸이 '지금 뜨거운가'다. 신규글/일이 높고 30일 비율이 100% 면 살아 있는 이슈,
 * 마지막 글이 수백 일 전이면 수요만 남고 아무도 안 쓰는 자리다. 후자가 더 좋은 기회일 때가 많다.
 */
function printHot(list, peakOf) {
  console.log('');
  console.log(
    padL('#', 3) + ' ' + padR('키워드', 22) + padL('수요', 9) + padL('글수', 10) +
    padL('실질포화', 10) + padL('YoY', 7) + padL('성수기', 8) +
    padL('신규글/일', 11) + padL('30일', 6) + padL('최근글', 8) +
    padL('기회점수', 10) + '  등급'
  );
  console.log('='.repeat(114));
  list.forEach((r, i) => {
    console.log(
      padL(i + 1, 3) + ' ' + padR(clip(r.keyword, 20), 22) +
        padL(num(r.volume), 9) + padL(num(r.blogDocs), 10) +
        padL(r.effectiveSaturation ?? '-', 10) + padL(r.yoy ?? '-', 7) +
        padL(peakOf(r), 8) +
        padL(r.postsPerDay ?? '-', 11) + padL(pct(r.fresh30), 6) +
        padL(r.lastDays === undefined ? '-' : r.lastDays + '일', 8) +
        padL(num(r.opportunity), 10) + '  ' + r.tier
    );
  });
  console.log('='.repeat(114));
  console.log('기회점수  = 수요 × 공백 × 뚫을 확률. 이 순서로 정렬했다. 절대값이 아니라 서로 비교용이다.');
  console.log('신규글/일 = 최신 표본의 절반이 쌓인 속도. 높으면 지금 터지는 이슈이자 남들도 달려드는 중이다.');
  console.log('30일      = 최신 100편 중 30일 이내 비율. 100% 면 살아 있는 주제, 0% 면 아무도 안 쓴다.');
  console.log('최근글    = 마지막 글이 며칠 전인가. 수요가 있는데 이 값이 크면 방치된 자리다.');
  console.log('등급      = A 블루오션(<3) · B 양호(<10) · C 경쟁(<40) · D 레드오션');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
