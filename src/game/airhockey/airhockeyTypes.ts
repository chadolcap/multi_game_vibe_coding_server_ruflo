// 에어하키(airhockey) 전용 payload / 상태 타입 (2026-10-15 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `airhockey` 시트가 기준이다.
// 공통 payload(EnterRoomPayload, ReadyPayload, OutUserPayload 등)는 common/types.ts 에 있다.
//
// 게임 개요: 2인 실시간 대전. 서버가 퍽의 물리를 계산해 PUCK_MOVE 로 알리고, 클라이언트는 자기 레버
// 좌표(LEVER_MOVE)만 보낸다. 퍽을 상대 골대에 넣으면 1골(= 한 판, ONE_RESULT), 3골 먼저 넣으면 승리.
// ⚠️ 모든 좌표는 **받는 유저 기준**이다 — 내 골대가 아래(y < 0). airhockeyConstants.ts 좌표계 주석 참고.

export interface AirhockeyPoint {
    x: number;
    y: number;
}

// --- C→S ---

// LEVER_MOVE 요청 — 내 레버의 현재 위치(내 기준 좌표). 서버는 내 쪽 절반 안으로 잘라서 받는다.
export interface AirhockeyLeverMovePayload {
    loc: AirhockeyPoint;
}

// GAME_RESULT 재게임 응답 (C→S)
export interface AirhockeyReplayPayload {
    replay: "Y" | "N";
}

// --- S→C ---

// PUCK_MOVE — 퍽의 현재 위치(받는 유저 기준). 움직이는 동안 30Hz 로 보내고, 멈춰 있으면 보내지 않는다.
// vel 🔸 은 시트에 없는 확장(2026-10-15 사용자 결정) — 퍽 속도(단위/초, 받는 유저 기준). 클라이언트가 다음
// 패킷까지 `loc + vel × 경과초` 로 위치를 예측해 부드럽게 그릴 수 있다. 멈추면 {0,0} 이 한 번 온다.
export interface AirhockeyPuckMovePayload {
    loc: AirhockeyPoint;
    vel: AirhockeyPoint;
}

// LEVER_MOVE 중계 — 상대(또는 상대를 대신 조종하는 봇)의 레버 위치(받는 유저 기준).
export interface AirhockeyLeverMoveResultPayload {
    user: string; // 레버 주인의 userid
    loc: AirhockeyPoint;
}

// ONE_RESULT — 골이 들어갔다. win 은 골을 넣은 유저, win_count 는 그 유저의 누적 골 수.
export interface AirhockeyOneResultPayload {
    win: string;
    win_count: number;
}

// GAME_RESULT 의 winner/loser.
//   win_count: 넣은 골 수
//   score:     이번 게임에서 얻은 랭킹 점수(골 수 × 5)
export interface AirhockeyGameResultPlayerInfo {
    userid: string;
    win_count: number;
    score: number;
    win_per: number; // total_win_count 기준 승률 (0~100 정수)
}

// GAME_RESULT — 최종 결과. draw 는 **항상** 보낸다("Y"/"N") — 클라이언트는 draw 값으로 결과 화면을 고른다(사용자 결정 2026-10-15).
// draw:"Y" 면 winner/loser 자리의 두 유저는 그냥 두 참가자다(오델로와 같은 관례). draw:"Y" 가 되는 경우:
//   - 둘 다 나갔는데 골 수가 같을 때
//   - 게임 무효(퍽 정체 재시작 AIRHOCKEY_STUCK_MAX_RESTARTS 번 뒤 또 정체) — winner/loser = player1/player2,
//     win_count = 그때까지 골 수, score 0, win_per = 이번 게임 미반영. DB 에는 아무것도 남지 않는다.
export interface AirhockeyGameResultPayload {
    winner: AirhockeyGameResultPlayerInfo;
    loser: AirhockeyGameResultPlayerInfo;
    draw: "Y" | "N";
}

// GAME_STATUS — 게임 중 재접속한 **그 유저에게만** 보내는 현재 상태 스냅샷 (받는 유저 기준 좌표).
// 시트: `puck:loc:{x,y}`, `LEVER0`, `LEVER1`.
//   LEVER0 / LEVER1: ENTER_ROOM 의 player1 / player2 레버 (오델로 status0/status1 과 같은 순서 관례)
//   win_count0 / win_count1 🔸: 시트에 없는 확장 — 재접속한 유저가 점수판을 되찾을 방법이 이것뿐이다
export interface AirhockeyGameStatusPayload {
    puck: { loc: AirhockeyPoint; vel: AirhockeyPoint }; // vel 🔸 은 PUCK_MOVE 와 같은 확장
    LEVER0: AirhockeyPoint;
    LEVER1: AirhockeyPoint;
    win_count0: number;
    win_count1: number;
}

// --- 서버 내부 상태 (절대 좌표: player1 이 아래, player2 가 위) ---

// 0 = 아래쪽(player1), 1 = 위쪽(player2)
export type AirhockeySide = 0 | 1;

export interface AirhockeyPuckState {
    x: number;
    y: number;
    vx: number; // 단위/초
    vy: number;
}

// 한 레버의 상태.
//   x, y:       서버가 물리 계산에 쓰는 실제 위치 (target 을 최대 속도로 따라간다)
//   target_x/y: 클라이언트(또는 봇)가 요청한 위치
//   vx, vy:     직전 틱에 실제로 움직인 속도 — 퍽을 칠 때 힘으로 더해진다
//   follow_speed:      target 까지 따라가는 속도(단위/초). 다음 입력이 올 때쯤 도착하도록 SetLeverTarget 이 정한다
//   last_input_at_ms:  마지막 LEVER_MOVE 를 받은 시각 (봇/처음이면 null)
//   input_interval_sec: LEVER_MOVE 도착 간격의 이동평균
export interface AirhockeyLeverState {
    side: AirhockeySide;
    x: number;
    y: number;
    target_x: number;
    target_y: number;
    vx: number;
    vy: number;
    follow_speed: number;
    last_input_at_ms: number | null;
    input_interval_sec: number;
}

// 퍽 정체 감시 (UpdateStuckWatch). anchor = 퍽이 머물기 시작한 자리, still_sec = 그 근처에 머문 시간(초).
export interface AirhockeyStuckWatch {
    anchor_x: number;
    anchor_y: number;
    still_sec: number;
}

// 한 틱 계산 결과. goal 은 골이 들어갔을 때 **골을 넣은 쪽**이다.
export interface AirhockeyStepResult {
    goal: AirhockeySide | null;
}

// --- DB ---

// airhockey_game_log.plays 의 골 기록 한 건.
export interface AirhockeyPlayRecord {
    userid: string; // 골을 넣은 유저
    sec: number; // 게임 시작(GAME_START)부터 몇 초 뒤
}
