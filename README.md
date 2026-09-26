# agent-skills

Personal agent skills, kept here so they survive a machine and can be installed
anywhere. Works with Claude Code, and with any other agent that reads the
[skills.sh](https://skills.sh) layout.

## Skills

| Skill | What it does |
|---|---|
| [`citation-verify`](skills/citation-verify) | Resolves DOIs / PMIDs / PMCIDs against PubMed, Crossref and Europe PMC to catch fabricated, misattributed and retracted citations. |
| [`clinical-writing`](skills/clinical-writing) | Discipline for clinical content a clinician will act on: guideline lookup before drafting, a source label on every dose and target, and cross-model review before delivery. |
| [`bohoja-note-seven-step-writing`](skills/bohoja-note-seven-step-writing) | Produces Bohoja Note elder-care decision articles through evidence design, source tracing, value-density review, clinical approval, and publication gating. |
| [`blueocean`](skills/blueocean) | Finds content topics where search demand is high but nobody has answered well, by measuring Naver monthly search volume against existing blog posts, discounted by how much of the top of the page is advertising. |
| [`title-check`](skills/title-check) | Measures title candidates: which of several synonyms people actually search for, whether the keyword survives in the title, how closely it resembles existing posts, SERP truncation, and formulaic filler. |
| [`title-draft`](skills/title-draft) | Turns a blueocean-picked keyword into a title brief: which title types the measurements support, hard cuts for banned phrases, and the hand-off to title-check. |
| [`fact-integrity`](skills/fact-integrity) | Compares a source text with its derivative (summary, polish, platform port) to catch dropped or altered numbers and lost qualifiers. |
| [`humanize-korean`](skills/humanize-korean) | Rewrites AI-written Korean so it reads as human prose without touching content; `codex/humanize-korean` is the Codex entry document sharing the same references. |
| [`suno`](skills/suno) | Aside로 Suno에서 게임 배경음·효과음·환경음을 기획·생성·검수·다운로드한다. |
| [`imagegen-cli`](skills/imagegen-cli) | Claude Code처럼 이미지 생성 도구가 없는 세션에서 구독 로그인된 CLI(Codex `image_gen`, Grok `image_gen`/`image_edit`)를 비대화형으로 불러 그림을 생성·편집한다. API 키 없음. Claude 경로에만 연결한다. |
| [`naver-mate`](skills/naver-mate) | 네이버 메이트 공식 기준과 GEO를 바탕으로 채널 전략·인용 정확성 검수·30일 실험·월별 성과 평가를 만든다. |
| [`naver-blog-writing`](skills/naver-blog-writing) | 프로젝트별 독자·브랜드·권한을 적용해 네이버 글과 이미지를 편집하고 저장 결과를 검수한다. |
| [`uu`](skills/uu) | Unknown unknowns 두 모드: (A) 위험 점검 — 사각지대를 드러내 확인·가드레일·감지·수용으로 처리, (B) 지식 추천 — 기획 단계에서 모르는 개념·방법을 적용법과 첫 실험이 붙은 카드로 추천. |
| [`워크트리-운영`](skills/워크트리-운영) | Orca 조율자 절차: 워커에게 넘기는 명세, 워크트리 이름·삭제 함정, 1시간 휴지 판정 후 커밋 전 검토, 갈라진 브랜치 푸시 규칙. |
| [`네이버-로그인`](skills/네이버-로그인) | 네이버 블로그 여러 개를 Aside로 다룰 때 블로그별 전용 브라우저 프로필을 고르고, 입력·임시저장·발행 직전에 로그인 계정이 대상 블로그와 맞는지 확인한다. |
| [`와우포에버-글쓰기`](skills/와우포에버-글쓰기) | WoW Forever 글의 블로그·사이트 공통 규칙: 채널 배분, 이미지·썸네일, 표·그래프 같은 시각 요소, 모바일 가독성, 사실 표기. |
| [`content-cleaner`](skills/content-cleaner) | 콘텐츠 프로젝트의 중간 원고·이미지·캐시·중복 자료를 보존 근거와 참조 관계를 확인한 뒤 정리한다. |
| [`mobile-blog-readability`](skills/mobile-blog-readability) | 한국어 정보성 블로그 원고와 공개 화면을 문장별 여백·목록 번호·약어 설명 중심으로 모바일에 맞게 편집하고 의미 보존을 검사한다. |
| [`task-wait`](skills/task-wait) | 이미 실행한 작업자의 결과를 회수할 때 완료 신호와 유한 대기를 정해 sleep·재조회 반복을 막는다. |
| [`webtoon-expression`](skills/webtoon-expression) | 웹툰 컷의 표정·몸짓을 설계하고 시각 검수하며 캐릭터 동일성을 유지한다. |
| [`webtoon-production`](skills/webtoon-production) | 웹툰 회차 제작 도구: 콘티 관리, 컷 프롬프트 조립·시안→정본 생성, 대사 OCR 대조, 690/390px 렌더링, 채택 기록. |
| 현자 | Moved to its own repo, [formars0309-cloud/hyunja](https://github.com/formars0309-cloud/hyunja), on 2026-09-07 so it can be shared on its own. |

## Install on another machine

```bash
npx --yes skills add https://github.com/formars0309-cloud/agent-skills \
  --skill citation-verify --skill clinical-writing --skill bohoja-note-seven-step-writing \
  --skill blueocean --skill title-check \
  --global --agent claude-code -y
```

공개 저장소이므로 코드를 읽고 내려받는 데 GitHub 로그인이 필요하지 않습니다. 블루오션 실측에는 각자의 네이버 API 인증정보가 필요합니다.

Or without the installer — clone and point the agent's skill directory at it:

```bash
git clone https://github.com/formars0309-cloud/agent-skills ~/projects/agent-skills
# Windows (no admin needed):
cmd //c mklink //J "%USERPROFILE%\.claude\skills\citation-verify" ^
  "%USERPROFILE%\projects\agent-skills\skills\citation-verify"
# macOS / Linux:
ln -s ~/projects/agent-skills/skills/citation-verify ~/.claude/skills/citation-verify
```

## How this checkout is wired on the main machine

The main machine is a Mac since 2026-09-07: the checkout lives at `~/Projects/agent-skills`, and
`~/.claude/skills/<skill>` and `~/.codex/skills/<skill>` are symlinks into `skills/`
(`~/.codex/skills/humanize-korean` points at `codex/humanize-korean`), so editing a skill here
takes effect immediately — there is no copy to keep in sync. Committing is the backup step, nothing else.

## Requirements

Node.js 18+ (for the built-in `fetch`).

`citation-verify` and `clinical-writing` need no API keys — PubMed, Crossref and
Europe PMC are all queried anonymously.

`blueocean` and `title-check` need Naver credentials, which are read from `~/.claude/.naver-api.env`
(or a project-local `.env`, or the environment). **That file lives outside this repo
and must never be committed to it.** Two sets are required:

| Keys | What for | Where to get them |
|---|---|---|
| `NAVER_AD_API_KEY`, `NAVER_AD_SECRET_KEY`, `NAVER_AD_CUSTOMER_ID` | Monthly search volume — the only source for demand | searchad.naver.com → 도구 → API 사용 관리. Free, no payment details |
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | Blog/news document counts and search trend | ncloud.com → NAVER API HUB → register an Application, tick 검색 (블로그·뉴스) and Data Lab |

## Adding a skill

One directory per skill under `skills/`, each with a `SKILL.md` whose front
matter carries `name` and a `description` that says *when* to use it — the
description is the whole trigger, so write it as a list of situations and
phrases, not as a summary.
