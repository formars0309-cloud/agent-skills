# 대구 → Mac 공통 설정·스킬 이전

2026-09-07, 원본 호스트: daegu-pc.

전역 작업 규칙을 ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md 및 Orca 관리 Codex 홈에 설치했다. Mac 경로·python3·Aside 웹 조작 선호를 덧붙였다.

스킬 원본은 ~/Projects/agent-skills/skills/에 보관하고 Claude·Codex·공용 스킬 경로에서 심볼릭 링크로 사용한다. Codex용 humanize-korean은 codex/humanize-korean/에 별도 진입 문서를 두고 Claude용과 참고 자료를 공유한다.

## 설치한 스킬

- blueocean
- bohoja-note-seven-step-writing
- citation-verify
- clinical-writing
- fact-integrity
- humanize-korean
- title-check
- title-draft
- 현자

## 검증 및 제한

- Orca 설치 목록에서 9개 이름 확인. 스크립트 11개의 구문 검사 통과.
- askall --help 정상 실행. 현자 HTML 열기를 macOS open에 대응시켰다.
- 네이버 API 자격증명은 이 Mac에 없어 blueocean·title-check의 실제 조회는 미검증이다.
- Gemini CLI 0.58.0을 추가 설치했다. Google OAuth 인증은 성공했지만 실제 호출은 Google 서버의 UNSUPPORTED_CLIENT / IneligibleTierError로 실패했다. 서버는 개인용 Code Assist 클라이언트 미지원 및 Antigravity 이전을 안내했다. 현재 Gemini는 사용 준비 완료 상태가 아니다. claude,codex,grok는 실행 파일만 확인했으며 로그인·응답은 이번 작업에서 검사하지 않았다.
- 프로젝트 전용 AGENTS.md/CLAUDE.md, 프로젝트 코드, 앱 UI 설정, 모델·MCP 설정, 인증정보는 이번 공통 스킬 이전 범위에 포함하지 않았다.
- 대구와의 자동 동기화는 설정하지 않았다. 이후 변경 사항은 다시 가져와야 한다.
- 가져온 원본은 ~/.codex/daegu-import/에 보관했다.

## Antigravity 전환

공식 설치 프로그램으로 agy 1.1.27 설치 및 SHA-512 검증 완료. 현자의 기본 네 번째 대상을 antigravity로 변경했고 `-a gemini`도 agy로 연결한다. 인자·응답 처리 검증 통과. Google OAuth 로그인 완료. 현자의 실제 antigravity 어댑터를 통해 ANTIGRAVITY_OK 응답을 9.5초에 수신해 호출을 검증했다.

## 2026-09-07 저녁 — 대구 세션 종료 후 최종 동기화

대구 PC의 현자 세션을 끝낸 뒤 원격 `agent-skills`를 다시 받아 비교했다. 대구가 이전 이후에 올린 커밋은 현자 하나(2363174, 제미나이 열을 agy로 전환)뿐이었고, 그 안의 메모(제미나이 CLI 차단 사유, agy 로그인 절차)를 Mac 쪽 `SKILL.md`에 합쳤다. Mac 쪽이 별도로 만든 `antigravity` 이름·`open` 호출·python3 표기는 그대로 둔다.

이 폴더는 이때부터 원격과 연결된 git 체크아웃이다. 오늘 Mac에서 고친 보호자 노트 교차 검수 규칙, fact-integrity의 python3 표기, humanize-korean·codex 진입 문서도 같이 커밋했다. `~/.codex/daegu-import/`의 원본 사본은 이 커밋에 모두 포함됐으므로 삭제했다.

대구 PC의 현자 작업 폴더(`~/orca/projects/현자`)는 원격이 없어 그쪽 `answers/` 기록은 가져오지 못했다. Mac 쪽 기록은 비공개 저장소 `formars0309-cloud/hyunja`에 백업한다.

## 2026-09-07 밤 — 현자 스킬을 별도 저장소로 분리

현자를 남에게도 나눠 주기 위해 `formars0309-cloud/hyunja`(스킬 코드, 공개 예정)로 옮겼다. 이 저장소의 `skills/현자`는 지웠고, `~/.claude/skills/현자`·`~/.codex/skills/현자` 링크와 `~/.local/bin/현자`·`askall` 실행기는 `~/Projects/hyunja`를 가리킨다. 개인 설정(작업 폴더 `~/orca/projects/현자`, 자동 커밋)은 `~/.config/hyunja/env`에 있다. 질문 기록 저장소는 `hyunja-answers`로 이름을 바꿨다.
