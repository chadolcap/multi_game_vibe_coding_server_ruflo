// 가위바위보(RPS) 전용 메시지 payload 타입. `common/types.ts` 에서 분리했다(2026-10-02) —
// 나중에 다른 게임(예: 오델로)을 추가할 때 이 파일과 같은 패턴으로 `game/othello/othelloTypes.ts` 를
// 만들면 된다. CLAUDE.md "게임별 분리 구조" 참고.
//
// ⚠️ 여기 있는 타입들은 와이어 메시지의 payload "모양"만 정의한다 — 실제 메시지 `type` 문자열
// (SELECT_GAME, GAME_RESULT 등)은 이미 만들어진 클라이언트가 그 이름에 의존하므로 바꾸지 않았고,
// 여전히 `common/types.ts` 의 `MessageType`(플랫폼 공용 와이어 상수) 안에 그대로 있다.

// 가위바위보 선택 값 — 문서 표기(한글) 그대로 쓴다
export type RpsChoice = "가위" | "바위" | "보";

// SELECT_GAME 으로 클라이언트가 보내는 값 (한 판에 대한 가위/바위/보 선택)
export interface RpsSelectGamePayload {
    select: RpsChoice;
}

// ONE_START — 한 판 시작을 알린다 (S→C). count 는 이 판의 선택 제한 남은 초(=RPS_CHOICE_TIMEOUT_SEC).
export interface RpsOneStartPayload {
    count: number;
}

// ONE_REMAIN_TIME — ONE_START 이후 선택 제한 남은 초를 1초 단위로 전달한다 (S→C).
// count 가 0 이면 선택 시간이 끝났다는 신호(=이 판은 자동 선택으로 마무리됨)다.
export interface RpsOneRemainTimePayload {
    count: number;
}

// ONE_RESULT — 한 판 결과 (S→C). win 은 그 판을 이긴 유저의 userid.
// 무승부면 win 필드를 아예 보내지 않는다 — 무승부 판은 승수에 들어가지 않으므로 같은 판을 다시 진행한다.
export interface RpsOneResultPayload {
    player1: RpsChoice;
    player2: RpsChoice;
    win?: string;
}

// GAME_RESULT 의 winner/loser — win_count 는 이번 게임에서 이긴 판 수(무승부 제외), win_per 은
// total_win_count 기준 승률(0~100 정수, 0판이면 0).
export interface RpsGameResultPlayerInfo {
    userid: string;
    win_count: number;
    win_per: number;
}

// GAME_RESULT — 최종 결과 (S→C). 승자 userid 는 winner.userid 로 알 수 있어 별도 win 필드는 없다.
// 점수(2:0=20점/2:1=10점)는 클라이언트에 보내지 않는다 — DB/랭킹에만 쓰는 값이다.
export interface RpsGameResultPayload {
    winner: RpsGameResultPlayerInfo;
    loser: RpsGameResultPlayerInfo;
}

// GAME_RESULT 로 클라이언트가 보내는 값 (재시작/나가기 선택, 같은 type 재사용).
export interface RpsReplayPayload {
    replay: "Y" | "N";
}
