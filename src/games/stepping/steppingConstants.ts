// 점핑(stepping) 전용 규칙 상수 (2026-10-14 추가). 플랫폼 공용 상수는 common/constants.ts 에 있다.
// 출처 표기: "시트" = 멀티게임_바이브.xlsx 의 stepping 시트에 명시된 값,
//           "사용자 결정" = 2026-10-14 대화에서 정한 규칙,
//           "오델로 관례" = 시트/규칙에 값이 없어 othelloConstants.ts 와 같은 값으로 맞춘 것.

// 맵 종류 수. 서버가 1~STEPPING_MAP_COUNT 중 하나를 랜덤으로 골라 MAP_SELECT 로 알린다. 시트("1~3").
export const STEPPING_MAP_COUNT = 3;

// 맵별 전체 블록(칸) 수 — "양쪽 모두 모든 칸 이동 완료" 종료 판정과 count 상한 검사에 쓴다.
// ⚠️ **임시 값이다.** 실제 맵 데이터의 블록 수를 받아서 바꿔야 한다. 실제 값보다 크게 잡아 두었다 —
//    작게 잡으면 마지막 칸들의 MOVE_INFO 가 상한 검사에 걸려 무시되지만, 크게 잡으면 "모두 완료" 조기
//    종료만 안 일어나고 제한 시간 종료로 끝나서 게임이 깨지지는 않는다.
export const STEPPING_MAP_BLOCK_COUNTS: Readonly<Record<number, number>> = {
    1: 100,
    2: 100,
    3: 100,
};

// MAP_SELECT 전송 후 GAME_START 까지 대기(맵 로딩/연출 시간). 시트("MAP_SEELCT 전송 후 2초 대기").
export const STEPPING_MAP_SELECT_DELAY_SEC = 2;

// 한 게임의 제한 시간. GAME_REMAIN_TIME 이 59 … 0 으로 간다.
// 시트는 "총 게임 시간은 20초" 였는데 사용자 결정(2026-10-14)으로 60초로 늘렸다 — 시트 반영 필요.
export const STEPPING_GAME_TIME_SEC = 60;

// 게임이 끝난 순간(탈락/제한 시간/양쪽 완주)부터 GAME_RESULT 를 보내기까지 대기 (사용자 요청 2026-10-14:
// "마지막 추락 모션을 볼 수가 없어"). 이 동안 MOVE_INFO 와 카운트다운은 멈추지만 게임은 아직 "진행 중"이다.
export const STEPPING_RESULT_DELAY_SEC = 3;

// 라이프 수. 추락(save:"no")할 때마다 1개씩 줄고, 0개인 상태에서 또 추락하면 게임이 끝난다.
// 사용자 결정 ("라이프 3개" / "라이프 3개 소진한 후 1명 추락 → 게임 종료") — 즉 **4번째 추락**에서 끝난다.
export const STEPPING_LIFE_COUNT = 3;

// 승패 판정용 게임 점수 = 남은 라이프 × 10 + 이동한 칸 수 × 5 (사용자 결정).
// 점수가 같으면 "먼저 도착한" 유저가 이긴다(steppingRules.DecideWinner 참고).
export const STEPPING_SCORE_PER_LIFE = 10;
export const STEPPING_SCORE_PER_BLOCK = 5;

// 같은 유저의 MOVE_INFO 최소 간격(ms). 이보다 빨리 오면 매크로/조작으로 보고 무시한다.
// 점프 한 번은 탭 + 점프 연출이라 사람이 이 간격보다 빠를 수 없다 — 영상 기준 대략 1초에 1칸.
// ⚠️ 무시된 MOVE_INFO 는 count 가 오르지 않아 그 클라이언트의 다음 count 도 순번 검사에 걸린다.
//    정상 플레이를 막지 않도록 넉넉히 짧게 잡았다.
export const STEPPING_MIN_MOVE_INTERVAL_MS = 150;

// GAME_RESULT 후 재게임/나가기 선택 제한 시간. 시트("10초 내에 재시작,/로비나가기 선택").
export const STEPPING_REMATCH_CHOICE_TIMEOUT_SEC = 10;

// 랭킹/통계 점수 — 승리 시 고정 20점, 패자·무승부 0점 (오델로 관례).
// ⚠️ 위 게임 점수(라이프×10 + 칸×5)는 **승패 판정용**이고, 랭킹에 쌓이는 점수는 이 값이다.
export const STEPPING_SCORE_WIN = 20;
export const STEPPING_SCORE_LOSE = 0;
export const STEPPING_SCORE_DRAW = 0;
