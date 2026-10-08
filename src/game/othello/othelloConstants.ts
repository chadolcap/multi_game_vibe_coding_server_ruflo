// 오델로 전용 규칙 상수 (2026-10-07 추가). 플랫폼 공용 상수는 common/constants.ts 에 있다.
// 출처 표기: "시트" = 멀티게임_바이브.xlsx 의 othello 시트에 명시된 값,
//           "RPS 관례" = 시트에 값이 없어 가위바위보(rpsConstants.ts)와 같은 값으로 맞춘 것.

export const OTHELLO_BOARD_SIZE = 8; // 8x8 (나무위키 오델로 규칙)

// 돌 색 선택(DOLL_SELECT) 제한 시간. 시간 내 아무도 안 고르면 서버가 랜덤 배정한다.
// 시트에 DOLL_SELECT_REMAIN_TIME 은 있는데 제한 시간 값이 없어서 RPS 관례(10초)를 따랐다.
export const OTHELLO_DOLL_SELECT_TIMEOUT_SEC = 10;

// GAME_START 전송 후 돌 선택을 시작하기까지의 지연(클라이언트 연출 시간). RPS 관례.
export const OTHELLO_GAME_START_DELAY_SEC = 5;

// 돌 선택이 끝난 뒤 첫 TURN_START 까지의 지연. 시트("돌선택이 종료 되면 5초후에 TURN_START").
export const OTHELLO_DOLL_SELECT_DELAY_SEC = 5;

// 한 턴의 선택 제한 시간. 시트("10초 동안 선택을 안 한 경우 랜덤으로 배치를 해 준다").
export const OTHELLO_TURN_TIMEOUT_SEC = 10;

// SELECT_GAME 결과 전송 후 다음 TURN_START 까지의 지연. 시트("SELECT_GAME 결과 전달 후 2초후에
// 다시 TURN_START 으로 넘거 간다").
export const OTHELLO_SELECT_RESULT_DELAY_SEC = 2;

// GAME_RESULT 후 재게임/나가기 선택 제한 시간. 시트("10초 내에 재시작,/로비나가기 선택").
export const OTHELLO_REMATCH_CHOICE_TIMEOUT_SEC = 10;

// 랭킹 점수 — 승리 시 고정 20점, 패자·무승부 0점 (사용자 결정 2026-10-07).
// RPS 는 2:0=20점 / 2:1=10점으로 승부 정도를 반영하지만, 오델로는 "승리 20점"으로 단순하게 둬서
// 두 게임의 점수 스케일을 같게 맞췄다.
export const OTHELLO_SCORE_WIN = 20;
export const OTHELLO_SCORE_LOSE = 0;
export const OTHELLO_SCORE_DRAW = 0;
