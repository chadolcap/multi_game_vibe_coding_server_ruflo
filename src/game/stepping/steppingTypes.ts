// 점핑(stepping) 전용 payload / 상태 타입 (2026-10-14 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `stepping` 시트가 기준이다.
// 공통 payload(EnterRoomPayload, ReadyPayload, OutUserPayload 등)는 common/types.ts 에 있다.
//
// 게임 개요: 두 유저가 **같은 맵**에서 각자 자기 블록을 점프해 나간다(화면은 나란히). 점프 판정
// (블록 안에 착지했는지)은 클라이언트가 하고, 서버는 그 결과(MOVE_INFO)를 검증·중계하고 승패를 낸다.

export interface SteppingPoint {
    x: number;
    y: number;
}

// --- C→S ---

// MOVE_INFO 요청 — 점프 한 번의 결과.
//   count:    이번 점프로 **도착하려던 칸 번호**(1부터). 서버는 "직전 count + 1" 만 받는다(순번 검사).
//             추락(save:"no")도 같은 번호를 보낸다 — 4번 칸으로 뛰다 떨어지면 count:4, save:"no".
//   location: 도착한 칸의 기준 좌표(칸 중앙 = (0,0) 기준 오프셋). 서버는 검증하지 않고 중계만 한다.
//   save:     "yes" = 칸 안에 착지, "no" = 추락
export interface SteppingMoveInfoPayload {
    count: number;
    location: SteppingPoint;
    save: "yes" | "no";
}

// --- S→C ---

// MAP_SELECT — 이번 게임의 맵 번호(1~STEPPING_MAP_COUNT). 양쪽이 같은 맵을 쓴다.
export interface SteppingMapSelectPayload {
    map: number;
}

// GAME_REMAIN_TIME — 남은 초
export interface SteppingRemainTimePayload {
    count: number;
}

// MOVE_INFO 결과 — 받아들인 점프를 **양쪽 모두에게** 보낸다(시트: C12/C13 처럼 userid 를 붙여서).
// ⚠️ life 는 시트에 없는 확장이다 — 추락 후 남은 라이프를 서버 기준으로 알려 줘야 두 화면의 라이프
//    표시가 어긋나지 않는다.
export interface SteppingMoveInfoResultPayload {
    userid: string;
    count: number;
    location: SteppingPoint;
    save: "yes" | "no";
    life: number;
}

// GAME_RESULT 의 winner/loser.
// ⚠️ win_count 는 **이동한 칸 수**다(오델로의 "최종 돌 개수"와 같은 자리). 시트 예시의 2/1 은 RPS 값이
//    복사된 흔적이다.
// ⚠️ score / life 는 시트에 없는 확장이다 — 승패가 칸 수가 아니라 게임 점수(라이프×10 + 칸×5)로
//    갈리므로, 결과 화면이 "왜 이겼는지"를 보여 주려면 둘 다 필요하다.
export interface SteppingGameResultPlayerInfo {
    userid: string;
    win_count: number; // 이동한 칸 수
    win_per: number; // total_win_count 기준 승률 (0~100 정수)
    score: number; // 게임 점수 (남은 라이프 × 10 + 칸 수 × 5)
    life: number; // 남은 라이프
}

// GAME_RESULT — 최종 결과. draw:"Y" 면 winner/loser 자리의 두 유저는 그냥 두 참가자다(오델로와 같은 관례).
export interface SteppingGameResultPayload {
    winner: SteppingGameResultPlayerInfo;
    loser: SteppingGameResultPlayerInfo;
    draw?: "Y";
}

// GAME_RESULT 재게임 응답 (C→S)
export interface SteppingReplayPayload {
    replay: "Y" | "N";
}

// GAME_STATUS — 게임 중 재접속한 **그 유저에게만** 보내는 현재 상태 스냅샷.
// ⚠️ 시트의 GAME_STATUS 행은 오델로 것(select/status0/status1/turn/can)이 그대로 복사돼 있어 점핑에
//    맞지 않는다. 점핑에 필요한 값으로 새로 정했다(2026-10-14) — 시트 반영 필요.
//   map:     MAP_SELECT 와 같은 맵 번호
//   count:   남은 초. GAME_START 전(맵 연출 2초)이면 생략한다
//   player1 / player2: ENTER_ROOM 과 같은 순서. 각자의 현재 칸·라이프·마지막 착지 좌표
export interface SteppingPlayerStatus {
    userid: string;
    count: number;
    life: number;
    location: SteppingPoint;
}

export interface SteppingGameStatusPayload {
    map: number;
    count?: number;
    player1: SteppingPlayerStatus;
    player2: SteppingPlayerStatus;
}

// --- 서버 내부 상태 ---

// 한 유저의 진행 상태. steppingRules 의 순수 함수들이 이 값을 받아 판정한다.
//   count:      지금까지 착지한 칸 수(= 마지막으로 성공한 칸 번호)
//   life:       남은 라이프
//   location:   마지막 착지 좌표 (GAME_STATUS 용)
//   reached_at: 지금 count 에 **도착한 시각**(ms). 동점일 때 "먼저 도착한 유저 승리" 판정에 쓴다.
//               한 칸도 못 갔으면 null
//   last_move_at: 마지막으로 받아들인 MOVE_INFO 시각(ms) — 최소 간격 검사용
//   eliminated: 라이프를 다 쓴 뒤 또 추락했다 (이게 생기면 게임이 끝난다)
//   completed:  맵의 모든 칸을 다 갔다
export interface SteppingPlayerState {
    count: number;
    life: number;
    location: SteppingPoint;
    reached_at: number | null;
    last_move_at: number | null;
    eliminated: boolean;
    completed: boolean;
}

// --- DB ---

// stepping_game_log.plays 의 한 점프 기록.
export interface SteppingPlayRecord {
    userid: string;
    count: number;
    x: number;
    y: number;
    save: "yes" | "no";
}
