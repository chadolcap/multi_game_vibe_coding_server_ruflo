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

// **자동 모드** 턴의 제한 시간 (사용자 결정 2026-10-13: "기존 A턴의 턴 제한 시간은 2초로 한다").
// 자동 모드 = 연결이 끊긴 채 봇 투입 시간이 지났거나, 게임 중 아예 나가 버려 재입장하지 않는 유저.
// 사람 차례는 OTHELLO_TURN_TIMEOUT_SEC(10초)를 그대로 쓰지만, 오델로는 한 게임에서 한 사람이 30수
// 가까이 두기 때문에 자동 모드에도 10초를 적용하면 남은 유저가 최대 5분을 멍하니 기다리게 된다.
// RPS 는 한 게임이 최대 3판이라 봇도 그냥 10초 타임아웃을 재사용했지만, 오델로는 턴 수가 많아 같은
// 방식을 쓸 수 없다.
// ⚠️ 이 값은 사람 턴과 **똑같이** TURN_REMAIN_TIME 카운트다운으로 흘러간다(사용자 결정 2026-10-13) —
//    2초면 count:1 → count:0 이 가고 count:0 에서 서버가 놓는다. 2026-10-12 에는 1초였고 카운트다운을
//    아예 보내지 않았는데, 그러면 클라이언트 타이머가 TURN_START 때의 10 에서 갱신되지 않고 멈춰
//    보이는 문제가 있었다.
export const OTHELLO_AUTO_TURN_TIMEOUT_SEC = 2;

// GAME_RESULT 후 재게임/나가기 선택 제한 시간. 시트("10초 내에 재시작,/로비나가기 선택").
export const OTHELLO_REMATCH_CHOICE_TIMEOUT_SEC = 10;

// 랭킹 점수 — 승리 시 고정 20점, 패자·무승부 0점 (사용자 결정 2026-10-07).
// RPS 는 2:0=20점 / 2:1=10점으로 승부 정도를 반영하지만, 오델로는 "승리 20점"으로 단순하게 둬서
// 두 게임의 점수 스케일을 같게 맞췄다.
export const OTHELLO_SCORE_WIN = 20;
export const OTHELLO_SCORE_LOSE = 0;
export const OTHELLO_SCORE_DRAW = 0;
