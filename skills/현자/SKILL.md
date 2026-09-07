---
name: 현자
description: 현자(賢者) — 같은 질문을 claude·codex·grok·gemini CLI에 동시에 던지고 네 답을 한 HTML 화면(가로 4단)과 마크다운으로 모아 보여준다. 코딩이 아니라 "여러 AI 의견을 나란히 보고 싶을 때" 쓴다. 트리거 — "현자", "현자에게 물어봐", "현자 소집", "다 같이 물어봐", "여러 AI에게 동시에", "클로드 코덱스 그록 비교", "askall", "동시 답변", "AI 여러 개 의견", "ask all".
---

# 현자

`ask_all.py` 하나가 전부다. 표준 라이브러리만 쓰고, 각 CLI의 비대화형 모드를 병렬로 실행한다.

| CLI | 실행 방식 |
|---|---|
| claude | `claude -p "질문"` |
| codex | `codex exec --skip-git-repo-check -s read-only -o <파일> "질문"` (최종 답만 파일로) |
| grok | `grok -p "질문"` |
| gemini | `gemini -p "질문"` |

## 사용

```
현자 "질문"                      # 터미널 어디서나 (~/.local/bin/현자.cmd, askall.cmd 도 같음)
askall -a claude,grok "질문"     # 일부만
askall -t 600 "질문"             # 타임아웃 초 (기본 300)
askall --no-open "질문"          # 브라우저 안 열기
python ask_all.py "질문"         # 직접 실행
```

결과: `~/askall/<시각>.md`, `~/askall/<시각>.html` (기본 브라우저로 자동 열림). 터미널에도 마크다운을 그대로 찍는다.

## 에이전트가 쓸 때

사용자가 "여러 AI에게 같이 물어봐"라고 하면 위 명령을 실행하고, 네 답의 **차이점**을 짧게 요약해 준다. 답 전체를 다시 옮겨 적지 않는다(HTML이 이미 열려 있다).

## 한계

- 각 CLI는 빈 임시 폴더에서 돌아 현재 프로젝트 파일을 보지 않는다. 프로젝트 문맥이 필요한 질문엔 맞지 않는다.
- 로그인·API 키는 각 CLI가 이미 갖고 있어야 한다. 없는 CLI는 "(CLI 없음)"으로 표시된다.
- 응답 시간은 가장 느린 CLI에 맞춰진다.
