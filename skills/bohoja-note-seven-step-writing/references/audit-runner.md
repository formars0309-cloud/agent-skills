# 검수 실행기 사용법

> 2026-09-27 `SKILL.md`에서 옮겨 온 원문이다(내용 변경 없음). SKILL.md에는 요약과 읽을 시점만 남겼다.

## 검수 실행기 — 2026-09-08 판정·종료 방식 개선

3·6단계의 반대쪽 검수는 스킬의 실행기로만 띄운다. 세션마다 즉석 스크립트를 만들지 않는다.

```text
node <스킬>/scripts/run-audit.mjs <slug> --kind stage3|final-fact|final-value --input <입력 폴더> [--focus "<중립 점검 범위>"] [--timeout-min 45]
node <스킬>/scripts/audit-status.mjs <slug> [--wait <실행 폴더> --timeout-min N]
node <스킬>/scripts/confirm-findings.mjs <slug> --run <실행 폴더> --input <수정된 입력 폴더> --method "<대조 방법>"
```

- 입력 폴더는 `brief.md`, `draft.md`, `prompt.txt`, `sources/manifest.json`과 원천 파일만 담는다. 최종 검수의 `draft.md`는 사이트 정본과 같아야 한다(draft 상태만 제외).
- 실행기는 시작 전에 스키마 상한(quickAnswer 400자 등)·필수 입력·manifest를 검증해 실패하면 Codex를 시작하지 않는다(종료 코드 5). 실행마다 `content-work/<slug>/audits/<감사>-r<N>/`에 프롬프트·원출력·판정·`execution.json`을 남기고, 판정은 `BEGIN_BOHOJA_AUDIT_JSON` 블록으로 회수한다.
- 종료 코드: 0 통과 · 2 수정 후 확인 · 3 반려 · 4 반복 상한 소진(`audits/<감사>-hold.md`에 보류 반환) · 5 입력 검증 실패 · 6 실행 보류(타임아웃·신호·CLI 실패·출력 계약 위반·입력 변경).
- 실행기를 백그라운드로 돌렸다면 `audit-status.mjs --wait`로 기다린다. `until`/`grep` 무한 루프와 별도 terminal read 감시는 금지다. `--timeout-min`은 0 초과 45 이하이며 기록된 마감이 잘못되면 실행 보류로 종료한다. 대기 종료 코드 0은 실행 종료일 뿐, 판정 통과를 뜻하지 않는다. runner가 사라지면 `lost`로 확정되며 그 기록으로 통과 처리하지 않는다.
- 재검수 프롬프트에는 현행 원고 전체·현재 근거·`--focus`의 중립적 점검 범위만 넣고 이전 판정·대화·통과 예상은 넣지 않는다.
- `validate-workflow.mjs`는 감사 종류별 마지막 실행기 기록이 `통과` 또는 기계 대조 종결인지, 검수한 원고 SHA가 현재 정본과 같은지, 상한을 넘기지 않았는지 검사한다. 실행기 이전의 즉석 기록은 이력으로만 남기고 재분류하지 않는다.
