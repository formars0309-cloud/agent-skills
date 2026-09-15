---
name: imagegen-cli
description: 이미지 생성 도구가 없는 Claude Code 세션에서 구독 로그인된 CLI(Codex 내장 image_gen·Grok 내장 image_gen/image_edit)를 비대화형으로 불러 이미지를 생성·편집한다. API 키·추가 과금 없이 ChatGPT·grok.com 로그인 인증을 그대로 쓴다. "이미지 만들어줘", "컷 생성", "이 그림 수정해줘", "표정만 바꿔줘", "삽화·썸네일·캐릭터 시트 생성", "웹툰 컷 다시 그려줘", "그록으로 그려줘" 요청과, 웹툰 원고 제작에서 컷을 새로 그리거나 국소 편집할 때 사용한다. 프롬프트만 요청하면 생성을 실행하지 않는다.
---

# 구독 CLI 이미지 생성 래퍼

Claude Code에는 이미지 생성 도구가 없다. 이 스킬은 로그인된 CLI를 자식 프로세스로 실행해 내장 이미지 도구로 그림을 만들고, 결과를 지정 경로로 가져온다. 한 스크립트로 두 백엔드를 고른다.

| 백엔드 | 도구·모델 | 인증 | 결과 | 실측(2026-09-15) |
|---|---|---|---|---|
| `codex` (기본) | Codex 내장 `image_gen`(gpt-image) | `~/.codex/auth.json` ChatGPT 로그인 | PNG, 1024×1536 등 | 생성 50~410초, 편집 50초 |
| `grok` | Grok CLI 내장 `image_gen` / `image_edit`(xAI Imagine) | `~/.grok/auth.json` grok.com 로그인(7일 만료, 자동 갱신·필요시 `grok login`) | JPG, 2:3은 832×1248 | 생성 31초, 편집 23초 |

품질 비교(같은 애니 선화 프롬프트, `이미지/백엔드비교-20260915/` 참조):
- **Codex**: 표정 뉘앙스(미세한 눈썹·다문 입·곁눈질)를 지시대로 재현, 피부색·선 정확. 느리다.
- **Grok 생성**: 선은 깨끗하지만 피부가 회보라색으로 나오고 요청하지 않은 검은 테두리를 넣었으며 표정이 단순화됐다. 프롬프트에 피부색·테두리 금지를 명시해야 한다.
- **Grok 편집**: 표정 변경을 강하게 반영하고 머리·뿔·의상·선 스타일을 잘 보존. 다만 해상도가 832×1248로 줄고 얼굴 인상이 약간 변한다. 빠른 표정 시안·반복 수정에 유리하다.

## 실행

```bash
S=~/.claude/skills/imagegen-cli/scripts/imagegen_cli.py

# 생성(codex)
python3 "$S" --prompt "..." --out 원고/03화-v01/원본/05.png --size "1024x1536 portrait"

# 생성(grok) — 비율은 도구 인자로 전달
python3 "$S" --backend grok --aspect 2:3 --prompt "..." --out 원고/03화-v01/원본/05-grok.jpg

# 편집 — 원본을 Image 1로 첨부, 바꿀 것과 지킬 것을 명시
python3 "$S" --edit 원본/05.png --prompt "Change only the eyebrows to a worried angle; keep face, pose, lettering, background unchanged." --out 원본/05-v02.png
python3 "$S" --backend grok --edit 원본/05.png --prompt "..." --out 원본/05-v02-grok.jpg

# 참조 이미지(캐릭터 시트 등) + 690px JPG 납품본 동시 생성
python3 "$S" --ref 기획/캐릭터시트.png --prompt "..." --out 원본/05.png --jpg-width 690 --jpg-out 업로드/05.jpg

# 긴 프롬프트는 파일로
python3 "$S" --prompt-file 프롬프트/05.txt --out 원본/05.png
```

옵션: `--backend codex|grok`, `--aspect 2:3`(grok 도구 인자·codex 힌트), `--size`(codex 힌트), `--transparent`(codex만), `--timeout`(기본 600초), `--force`(기존 파일 덮어쓰기 허용), `--model`, `--keep-source`. `--out` 확장자가 백엔드 원본과 다르면 sips로 변환한다(grok→.png, codex→.jpg 가능).

마지막 표준출력 한 줄이 JSON이다: `out`, `backend`, `bytes`, `sha256`, `pixelWidth/Height`, `format`, `mode`, `attachments`, `seconds`, `usage`(codex) 또는 `tool`(grok), `jpg{...}`. 제작 기록·파일검증 JSON에 그대로 옮겨 적는다.

## 규칙

1. **한 번 호출에 한 컷.** 스트립·그리드·콜라주를 한 이미지로 만들지 않는다. 컷마다 독립 호출·독립 검수.
2. **기존 파일을 덮어쓰지 않는다.** 스크립트가 기본으로 거부한다. 수정본은 `05-v02.png`처럼 새 이름으로 만들고 원본을 보존한다.
3. **편집은 불변 조건을 명시한다.** `change only X; keep Y unchanged` 형식으로 쓰고, 반복 편집 때마다 같은 불변 조건을 다시 적는다. 글자 교정만 필요할 때는 그림을 재생성하지 말고 국소 레터링 편집으로 지시한다.
4. **결과를 반드시 눈으로 확인한다.** `Read`로 열어 피사체·구도·글자·손·표정을 검수하고, 실패하면 단일 변경으로 다시 편집한다. 편집 결과의 픽셀 크기는 원본과 다를 수 있으므로(codex 512→1254, grok 1024→832) 최종 폭은 `--jpg-width`나 후처리로 맞춘다.
5. **웹툰 원고에서는 작품 규칙이 우선한다.** `$webtoon-expression`으로 컷별 표정을 먼저 설계하고, 프롬프트에 그 설계와 캐릭터 고정 요소를 옮긴다. 690px JPG·5MB·여백 규칙은 작품 AGENTS.md를 따른다.
6. **프롬프트 작성 요청만 있으면 실행하지 않는다.** 생성은 구독 한도를 쓰므로 사용자가 이미지를 원할 때만 돌린다.
7. **백엔드 선택.** 정본 컷·미묘한 표정은 codex, 빠른 시안·표정 변형 다수·반복 편집은 grok. 두 결과를 비교할 때는 같은 프롬프트 파일을 두 백엔드에 넣고 나란히 검수한다. grok 프롬프트에는 "natural skin tone, no frame/border"를 덧붙인다.

## 프롬프트 형식

Codex 시스템 스킬(`~/.codex/skills/.system/imagegen/references/prompting.md`, `sample-prompts.md`)의 지침을 따른다. 요약:

```text
Use case: illustration-story | product-mockup | ui-mockup | ... (생성) / precise-object-edit | identity-preserve | text-localization | ... (편집)
Primary request: 핵심 요청
Subject / Scene / Style / Composition / Lighting / Palette
Text (verbatim): "정확한 글자"  ← 한글 대사는 글자 단위로 철자를 풀어 적고 verbatim 요구
Constraints: 지킬 것 / Avoid: 피할 것
```

- 구체적인 프롬프트는 구조만 정리하고 창작 요소를 덧붙이지 않는다. 막연한 프롬프트만 구도·용도 힌트를 더한다.
- 참조 이미지는 codex에서 "Image N: 역할"로, grok에서 `image_edit`의 절대 경로 목록으로 전달된다(스크립트가 자동 처리). 편집 대상은 항상 첫 번째다.

## 실패 처리

- `생성된 이미지를 찾지 못했습니다`: CLI가 도구를 부르지 못했거나 정책상 거부한 경우. stderr의 진단을 읽고 프롬프트를 고친다. 인증은 `codex login status` / `grok login`으로 확인한다.
- 시간 초과: `--timeout`을 늘린다. codex는 혼잡 시 7분 가까이 걸린 기록이 있다.
- grok은 `--tools image_gen,image_edit` 허용 목록으로 실행되므로 셸을 쓰지 못한다. 도구가 실패하면 대체 그림 없이 그대로 실패한다(의도된 동작).
- 이 스킬은 Codex·Grok 세션에는 연결하지 않는다. 각 CLI는 내장 도구를 직접 쓴다.

## 대안(키 필요)

OpenAI 이미지 API(`gpt-image-2`)나 Gemini API(`gemini-3-pro-image`, 나노바나나 프로)를 직접 부르면 크기·품질·마스크·참조 14장을 정확히 제어할 수 있으나 API 키 발급과 종량 과금이 필요하다. 키 발급은 사용자가 한다. Antigravity CLI(`agy`)에도 `generate_image`가 있으나 서버가 정한 Flash 모델·소비자 한도라 시험용이다.
