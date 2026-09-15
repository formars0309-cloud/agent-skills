---
name: codex-imagegen
description: 이미지 생성 도구가 없는 Claude Code 세션에서 Codex CLI 내장 image_gen(gpt-image)을 비대화형으로 불러 이미지를 생성·편집한다. API 키 없이 로그인된 Codex(ChatGPT 구독) 인증을 그대로 쓴다. "이미지 만들어줘", "컷 생성", "이 그림 수정해줘", "삽화·썸네일·캐릭터 시트 생성", "웹툰 컷 다시 그려줘" 요청과, 웹툰 원고 제작에서 컷을 새로 그리거나 국소 편집할 때 사용한다. 프롬프트만 요청하면 생성을 실행하지 않는다.
---

# Codex 내장 image_gen 래퍼

Claude Code에는 이미지 생성 도구가 없다. 이 스킬은 `codex exec`를 자식 프로세스로 실행해 Codex의 내장 `image_gen`으로 그림을 만들고, 결과 PNG를 지정 경로로 가져온다.

- 인증: `~/.codex/auth.json`의 ChatGPT 로그인. `OPENAI_API_KEY` 불필요, 추가 과금 없음(구독 한도 소모).
- 실측(2026-09-15, macOS, codex-cli 0.154): 생성 1장 약 50~60초, 편집 1장 약 50초. 세션당 입력 4만~7만 토큰.
- 결과 원본은 `~/.codex/generated_images/<세션>/`에 생기며, 스크립트가 `--out`으로 복사한 뒤 기본으로 원본을 지운다(`--keep-source`로 보존).

## 실행

```bash
S=~/.claude/skills/codex-imagegen/scripts/codex_imagegen.py

# 생성
python3 "$S" --prompt "..." --out 원고/03화-v01/원본/05.png --size "1024x1536 portrait"

# 편집 — 원본을 Image 1로 첨부, 바꿀 것과 지킬 것을 명시
python3 "$S" --edit 원고/03화-v01/원본/05.png \
  --prompt "Change only the eyebrows to a worried angle; keep face, pose, lettering, background unchanged." \
  --out 원고/03화-v01/원본/05-v02.png

# 참조 이미지(캐릭터 시트 등) 첨부 + 690px JPG 납품본 동시 생성
python3 "$S" --ref 기획/캐릭터시트.png --prompt "..." --out 원본/05.png --jpg-width 690 --jpg-out 업로드/05.jpg

# 긴 프롬프트는 파일로
python3 "$S" --prompt-file 프롬프트/05.txt --out 원본/05.png
```

옵션: `--transparent`(투명 배경), `--timeout`(기본 600초), `--force`(기존 파일 덮어쓰기 허용), `--model`(Codex 모델 재정의), `--sandbox read-only|workspace-write`(기본 read-only; Codex의 셸 실행만 제한하며 image_gen에는 영향 없음).

마지막 표준출력 한 줄이 JSON이다: `out`, `bytes`, `sha256`, `pixelWidth/Height`, `format`, `mode`, `attachments`, `seconds`, `usage`, `jpg{...}`. 제작 기록·파일검증 JSON에 그대로 옮겨 적는다.

## 규칙

1. **한 번 호출에 한 컷.** 스트립·그리드·콜라주를 한 이미지로 만들지 않는다. 컷마다 독립 호출·독립 검수.
2. **기존 파일을 덮어쓰지 않는다.** 스크립트가 기본으로 거부한다. 수정본은 `05-v02.png`처럼 새 이름으로 만들고 원본을 보존한다.
3. **편집은 불변 조건을 명시한다.** `change only X; keep Y unchanged` 형식으로 쓰고, 반복 편집 때마다 같은 불변 조건을 다시 적는다. 글자 교정만 필요할 때는 그림을 재생성하지 말고 국소 레터링 편집으로 지시한다.
4. **결과를 반드시 눈으로 확인한다.** `Read`로 PNG를 열어 피사체·구도·글자·손·표정을 검수하고, 실패하면 단일 변경으로 다시 편집한다. 편집 결과의 픽셀 크기는 원본과 다를 수 있으므로(예: 512→1254) 최종 폭 변환은 `--jpg-width`나 후처리로 맞춘다.
5. **웹툰 원고에서는 작품 규칙이 우선한다.** `$webtoon-expression`으로 컷별 표정을 먼저 설계하고, 프롬프트에 그 설계와 캐릭터 고정 요소를 옮긴다. 690px JPG·5MB·여백 규칙은 작품 AGENTS.md를 따른다.
6. **프롬프트 작성 요청만 있으면 실행하지 않는다.** 생성은 구독 한도를 쓰므로 사용자가 이미지를 원할 때만 돌린다.
7. **크기 힌트는 프롬프트에 전달된다.** 내장 도구의 정확한 인자가 아니므로 결과 크기를 JSON으로 확인한다. gpt-image 표준 크기는 1024x1024, 1536x1024, 1024x1536이 안정적이다.

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
- 참조 이미지는 "Image N: 역할"로 지정된다(스크립트가 자동 표기). 편집 대상은 항상 Image 1이다.

## 실패 처리

- `생성된 이미지를 찾지 못했습니다`: Codex가 도구를 부르지 못했거나 정책상 거부한 경우. stderr의 마지막 메시지를 읽고 프롬프트를 고친다. `codex login status`로 인증을 확인한다.
- 시간 초과: `--timeout`을 늘린다. 4K 등 큰 크기는 오래 걸린다.
- `codex` 없음: Codex CLI 설치·로그인이 필요하다. 로그인은 사용자 계정 인증 규칙에 따라 진행한다.
- 이 스킬은 Codex 세션에는 연결하지 않는다. Codex는 내장 `imagegen` 시스템 스킬을 직접 쓴다.

## 대안(키 필요)

OpenAI 이미지 API(`gpt-image-2`)나 Gemini 이미지 API를 직접 부르면 크기·품질·마스크를 정확히 제어할 수 있으나 API 키 발급과 종량 과금이 필요하다. Codex 시스템 스킬의 `scripts/image_gen.py`가 그 CLI다. 키 발급은 사용자가 한다.
