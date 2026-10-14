// 가위바위보(RPS) 전용 규칙 상수. `common/constants.ts` 에서 분리했다(2026-10-02) — 다른 게임
// (예: 오델로)을 추가할 때 이 파일과 같은 패턴으로 `game/othello/othelloConstants.ts` 를 만들면 된다.
// CLAUDE.md "게임별 분리 구조" 참고. 채널/포트/캐시 TTL 같은 플랫폼 공용 숫자는 여전히
// `common/constants.ts` 에 있다 — 거긴 어떤 게임이든 똑같이 쓰는 값만 남겼다.

export const RPS_CHOICE_TIMEOUT_SEC = 10;           // 가위바위보 선택 제한 (지나면 자동 선택)
export const RPS_GAME_START_DELAY_SEC = 5;          // GAME_START 전송 후 첫 판 ONE_START 까지 대기 (클라이언트 연출 시간 확보)
export const RPS_ONE_RESULT_DELAY_SEC = 5;          // 2번째 판부터: ONE_RESULT 전송 후 다음 ONE_START 까지 대기 (결과 연출 시간 확보)
export const RPS_LAST_RESULT_DELAY_SEC = 3;         // 마지막 판 ONE_RESULT 전송 후 GAME_RESULT 까지 대기 (마지막 판 결과 연출 시간 확보)
export const RPS_REMATCH_CHOICE_TIMEOUT_SEC = 10;   // 재게임/나가기 선택 제한 (지나면 나가기)

export const RPS_WIN_COUNT_TO_FINISH = 2;           // 2선승제
export const RPS_MAX_DECISIVE_ROUNDS = 3;           // 무승부를 뺀 최대 판 수
export const RPS_SCORE_WIN_STRAIGHT = 20;           // 2:0 승리
export const RPS_SCORE_WIN_NORMAL = 10;             // 2:1 승리
export const RPS_SCORE_LOSE = 0;
