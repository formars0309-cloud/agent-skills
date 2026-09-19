# 블루오션 키워드 조사 스킬

검색량·블로그 문서 수·광고성 신호·월별 추세로 글 주제 후보를 비교합니다. 검색 순위나 수익을 보장하지 않습니다.

## 에이전트에 복사할 한 줄

https://github.com/formars0309-cloud/agent-skills/tree/main/skills/blueocean 의 README.md와 SKILL.md를 읽고 내 프로젝트 목적·독자에 맞게 블루오션 스킬을 설치해줘. 기존 파일은 보존하고 목적을 모르면 한 번만 물어봐. 필요한 실행 환경과 테스트를 확인하고, API 키는 기존 환경에서 안전하게 읽되 없으면 발급·입력 방법을 안내해줘. 키가 준비되면 첫 조사를 실행하고 실측 결과와 한계를 설명해줘.

## 필요한 것

- 파일 다운로드·편집·터미널 실행이 가능한 AI 에이전트. 일반 대화창만으로 실행되지는 않습니다.
- Node.js 22 이상 권장. 별도 npm 패키지 설치는 필요 없습니다.
- 본인 네이버 검색광고 계정 및 네이버 클라우드 API HUB 인증정보.

## 설치

저장소의 이 폴더를 에이전트의 스킬 경로에 설치하거나, 저장소를 내려받은 뒤 이 폴더를 연결합니다. 기존 동명 스킬을 덮어쓰지 않습니다.

```bash
git clone https://github.com/formars0309-cloud/agent-skills.git
cd agent-skills/skills/blueocean
node --test scripts/blueocean.test.mjs
```

`.env.example`을 작업 폴더의 `.env`로 복사해 본인 인증정보를 입력합니다. `.env`는 커밋하지 말고 다른 사람에게 공유하지 않습니다. 기존 환경변수가 우선이며, 작업 폴더 `.env`, 홈의 `.claude/.naver-api.env` 순서로 빈 값을 채웁니다.

- 검색광고: https://naver.github.io/searchad-apidoc/ — 가입 후 도구의 API 관리에서 인증정보 준비.
- 검색·추세: https://guide.ncloud-docs.com/docs/apihub-application — API HUB 신청 후 블로그·뉴스·검색어 트렌드를 선택하고 Application 등록.
- API HUB의 무료 제공과 향후 유료화 계획은 변경될 수 있으므로 신청 화면의 요금·한도를 확인합니다.

## 첫 조사

```bash
node scripts/blueocean.mjs --exact 요양병원 요양원 장기요양등급 --hot 3 --out example.json
```

다른 분야는 키워드를 바꾸면 됩니다. `--seeds`는 연관키워드를 확장하고, `--hot`은 트래픽 기회, `--revenue`는 검색광고 지표를 반영한 상대 수익점수로 정렬합니다. 결과 파일은 실행마다 다른 이름을 지정하면 보존됩니다.

표와 JSON을 함께 확인합니다. `warnings`는 실패·누락, `unmeasured`는 순위 산출 불가 키워드입니다. API 키가 없으면 테스트는 가능하지만 실측은 불가능합니다.

광고성은 거친 규칙 기반 추정이며 검색 결과의 실제 블로그 노출 위치·글 품질·독자 적합성을 직접 판정하지 않습니다. 점수는 같은 조사 안의 비교용입니다.

## 재사용

이 blueocean 폴더는 MIT 라이선스입니다. 출처·라이선스를 보존해 자신의 에이전트에 맞게 수정할 수 있습니다. 이 허가는 다른 스킬 폴더에 자동 적용되지 않습니다.
