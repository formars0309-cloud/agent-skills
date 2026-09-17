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
| [`naver-mate`](skills/naver-mate) | 네이버 메이트 공식 기준과 채널 진단을 바탕으로 콘텐츠 전략·30일 실험·월별 인용 성과 평가를 만든다. |
| 현자 | Moved to its own repo, [formars0309-cloud/hyunja](https://github.com/formars0309-cloud/hyunja), on 2026-09-07 so it can be shared on its own. |

## Install on another machine

```bash
npx --yes skills add https://github.com/formars0309-cloud/agent-skills \
  --skill citation-verify --skill clinical-writing --skill bohoja-note-seven-step-writing \
  --skill blueocean --skill title-check \
  --global --agent claude-code -y
```

The repo is private, so that machine needs to be authenticated to GitHub first
(`gh auth login`, or an SSH key with access).

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
(`~/.codex/skills/humanize-korean` points at `codex/humanize-korean`). On the retired Windows box
`~/.claude/skills/citation-verify` was a directory junction into this repo, so
editing a skill here takes effect immediately in Claude Code — there is no copy
to keep in sync. Committing is the backup step, nothing else.

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
