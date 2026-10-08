// 오델로 전용 payload / 보드 타입 (2026-10-07 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `othello` 시트가 기준이다.
// 공통 payload(EnterRoomPayload, ReadyPayload, OutUserPayload 등)는 common/types.ts 에 있다 —
// 어떤 2인용 게임이든 재사용하는 것들이라 게임 폴더로 내리지 않는다.

// 돌 색. 시트 기준 0=흰색, 1=검정. ⚠️ 오델로 표준 규칙상 **검정(1)이 선공**이다.
export const OTHELLO_WHITE = 0;
export const OTHELLO_BLACK = 1;
export type OthelloColor = typeof OTHELLO_WHITE | typeof OTHELLO_BLACK;

// 빈 칸. 보드 한 칸은 EMPTY | OTHELLO_WHITE | OTHELLO_BLACK 중 하나다.
export const OTHELLO_EMPTY = -1;
export type OthelloCell = typeof OTHELLO_EMPTY | OthelloColor;

// 8x8 보드. board[y][x] 로 접근한다 (y=행, x=열).
// ⚠️ 좌표는 **0~7**(0-based)이다 — 와이어 프로토콜도 같은 기준(사용자 결정 2026-10-07).
export type OthelloBoard = OthelloCell[][];

export interface OthelloPoint {
    x: number;
    y: number;
}

// --- C→S ---

// DOLL_SELECT 요청 — 고르고 싶은 돌 색
export interface OthelloDollSelectPayload {
    color: OthelloColor;
}

// SELECT_GAME 요청 — 돌을 놓을 자리
export interface OthelloSelectGamePayload {
    select: OthelloPoint;
}

// --- S→C ---

// DOLL_SELECT 결과 — 색(0/1) → 그 색을 가진 userid. 시트 예시: select:{0:userid1, 1:userid2}
export interface OthelloDollSelectResultPayload {
    select: Record<string, string>;
}

// DOLL_SELECT_REMAIN_TIME / TURN_REMAIN_TIME — 남은 초
export interface OthelloRemainTimePayload {
    count: number;
}

// TURN_START — 돌을 놓을 유저와 놓을 수 있는 자리 목록.
// ⚠️ `can` 은 시트에 없는 확장이다(사용자 결정 2026-10-07) — 클라이언트가 놓을 자리를 표시하는 데
//    사실상 필수이고, 서버/클라가 같은 합법수 판정을 중복 구현하는 것도 막는다.
export interface OthelloTurnStartPayload {
    turn: string;
    can: OthelloPoint[];
}

// SELECT_GAME 결과 — 누가 어디에 놓았고, 그래서 뒤집히는 돌이 어디인지
export interface OthelloSelectGameResultPayload {
    select: { userid: string; x: number; y: number };
    change: OthelloPoint[];
}

// GAME_RESULT — 최종 결과.
// ⚠️ win_count 는 **최종 돌 개수**다(사용자 결정 2026-10-07). 시트 예시의 2/1 은 RPS 2선승제 값이
//    복사된 흔적이라 오델로에는 맞지 않는다.
// ⚠️ draw 는 시트에 없는 확장이다 — 오델로는 돌 개수가 같은 무승부가 실제로 나오는데 winner/loser
//    구조로는 표현할 수 없어서 추가했다. draw:"Y" 면 winner/loser 자리의 두 유저는 "승자/패자"가
//    아니라 그냥 두 참가자다.
export interface OthelloGameResultPlayerInfo {
    userid: string;
    win_count: number; // 최종 돌 개수
    win_per: number; // total_win_count 기준 승률 (0~100 정수)
}

export interface OthelloGameResultPayload {
    winner: OthelloGameResultPlayerInfo;
    loser: OthelloGameResultPlayerInfo;
    draw?: "Y";
}

// GAME_RESULT 재게임 응답 (C→S)
export interface OthelloReplayPayload {
    replay: "Y" | "N";
}

// GAME_STATUS — 게임 중 같은 방으로 재접속한 **그 유저에게만** 보내는 현재 상태 스냅샷
// (시트 othello 19행, 2026-10-08 추가. 비고: "재접속 당사자에게만 전달").
// 재접속한 클라이언트는 그동안의 DOLL_SELECT/SELECT_GAME/TURN_START 를 놓쳤으므로 화면을 처음부터
// 다시 그려야 한다 — 이 메시지 하나로 복원할 수 있게 담는다.
//   select:  DOLL_SELECT 결과와 같은 모양 — 키가 색("0"/"1"), 값이 그 색을 가진 userid
//   status0: 흰색(0) 돌이 놓인 좌표 전부
//   status1: 검정(1) 돌이 놓인 좌표 전부
//   turn/can: TURN_START 와 같은 의미(지금 둘 차례인 userid + 놓을 수 있는 자리)
//
// ⚠️ turn/can 은 시트에 없는 확장이다(2026-10-08 사용자 결정). 없으면 재접속 유저가 "지금 누구
//    차례인지"를 알 수 없어, 자기 차례였다면 제한 시간이 그냥 흐르다 서버가 랜덤으로 놓아 버린다.
// ⚠️ **둘은 선택적이다** — SELECT_GAME 결과 전송 후 다음 TURN_START 까지의
//    OTHELLO_SELECT_RESULT_DELAY_SEC(2초) 공백에는 활성 턴이 없어서 채울 수 없다. 그 경우 두 필드를
//    아예 보내지 않는다(ONE_RESULT 의 win, GAME_RESULT 의 draw 와 같은 생략 관례). 클라이언트는
//    곧(2초 안에) 도착하는 TURN_START 로 따라잡으면 된다.
export interface OthelloGameStatusPayload {
    select: Record<string, string>;
    status0: OthelloPoint[];
    status1: OthelloPoint[];
    turn?: string;
    can?: OthelloPoint[];
}

// --- DB ---

// othello_game_log.plays 의 한 수. 좌표는 0~7.
export interface OthelloPlayRecord {
    userid: string;
    x: number;
    y: number;
}
