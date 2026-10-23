// 청기백기(flag, 1인) 전용 payload / 상태 타입 (2026-10-22 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `flag` 시트가 기준이다.
// 공통 payload(EnterRoomPayload, ReadyPayload 등)는 common/types.ts 에 있다.
//
// 게임 개요: 혼자 한다. 서버가 "청기 올려 / 백기 내려 …" 문제를 5번 내고, 유저는 5초 안에 오리의 오른손(청기)·
// 왼손(백기) 쪽 위/아래 버튼으로 답한다. 맞추면 5점. (2026-10-22 사용자 변경: 손 방향은 **오리 기준**.
// 서버는 b/w 값만 판정하고 손·화면 방향은 모른다 — 화면 배치는 클라이언트가 정한다)

// 깃발 상태 값 — -1: 내려, 0: 고정(이번 문제에서 안 움직임), 1: 올려 (시트)
export type FlagMove = -1 | 0 | 1;

// 문제/답 한 개. b = 청기(오리 오른손), w = 백기(오리 왼손).
export interface FlagQuest {
    b: FlagMove;
    w: FlagMove;
}

// 문제 문구 코드 (2026-10-23 사용자 추가: 동작 이미지 9장 — 양손 각각 올림/내림/정지 3×3).
// 판정은 quest 값으로만 하고, say 는 클라이언트가 문장을 만들 때 쓴다.
//   "up" = 올려(1), "down" = 내려(-1)
//   "no_up" = 올리지마, "no_down" = 내리지마, "" = 그 깃발은 말하지 않음 — 셋 다 정답은 정지(0)
// 예: quest {b:1, w:0} 는 "청기 올려, 백기 올리지마" / "청기 올려, 백기 내리지마" / "청기 올려" 세 가지로 나올 수 있다.
// ⚠️ 2026-10-23 사용자 변경(정지 버튼 추가): **판정은 say 로 한다**(flagRules.IsCorrect). quest 는 대표 정답 포즈(이미지용).
//   "up" → 올림(1)만 / "down" → 내림(-1)만 / "no_up" → 내림·정지(-1, 0) / "no_down" → 올림·정지(1, 0)
//   "" → 안 누름(null)·정지(0) 통과, 올림·내림은 오답
export type FlagSayCode = "up" | "down" | "no_up" | "no_down" | "";

export interface FlagSay {
    b: FlagSayCode;
    w: FlagSayCode;
}

// --- C→S ---

// QUEST_SHOW (C→S) — 답. 누른 버튼만 ±1, 안 누른 쪽은 0.
// ⚠️ 한 문제에 여러 번 보내도 된다 — 서버가 **누적**한다(0 이 아닌 값만 반영, 같은 깃발은 나중 값이 이긴다).
//    그래서 버튼을 누를 때마다 보내도 되고, 5초 안에 모아서 한 번에 보내도 된다(flagRules.MergeAnswer).
// ⚠️ 2026-10-23 사용자 변경(정지 버튼 추가)으로 위 두 줄은 폐기:
//    값은 1 올림 / 0 **정지 버튼** / -1 내림, 누르지 않은 깃발은 키를 빼거나 null.
//    클라이언트는 문제에 나온 깃발 수만큼 버튼을 받은 뒤 **한 번에** 보낸다 — 서버는 처음 온 답 하나로 즉시
//    판정하고(누적·조기 판정 없음) 그 뒤 답은 무시한다. "청기 올려"만 누르고 백기를 누르기 직전에 정답 처리되던
//    문제(간발의 차이) 때문이다.
export interface FlagAnswerPayload {
    quest: { b?: FlagMove | null; w?: FlagMove | null };
}

// 서버가 정리한 답 — 누르지 않은 깃발은 null (2026-10-23)
export interface FlagAnswer {
    b: FlagMove | null;
    w: FlagMove | null;
}

// GAME_RESULT 재게임 응답 (C→S)
export interface FlagReplayPayload {
    replay: "Y" | "N";
}

// --- S→C ---

// ONE_START — 한 문제 시작. no(몇 번째 문제, 1부터)·total(전체 문제 수)은 시트에 없는 확장이다 —
// "문제 2/5" 표시용.
export interface FlagOneStartPayload {
    no: number;
    total: number;
}

// QUEST_SHOW (S→C) — 문제. 0 인 깃발은 이번 문제에서 움직이면 안 되는 쪽이다(정지).
// time(답할 수 있는 초)은 시트에 없는 확장이다 — 클라이언트 타이머 표시용.
// say(문제 문구 코드)는 2026-10-23 추가 — 정지를 "올리지마/내리지마/말 안 함" 중 어떻게 말할지.
// quest 가 {0,0}(양손 정지)인 함정 문제도 나온다 — 5초 동안 아무것도 안 눌러야 정답.
// ⚠️ 2026-10-23 사용자 변경: 양손 정지 문제도 문제에 나온 깃발의 버튼(정지 등)을 눌러야 정답 — 안 누르면 N.
export interface FlagQuestShowPayload {
    quest: FlagQuest;
    say: FlagSay;
    time: number;
}

// ONE_RESULT — 한 문제 결과. 시트는 quest:"Y"/"N" 만 있다.
// score(지금까지 누적 게임 점수)·answer(서버가 판정에 쓴 최종 답)는 시트에 없는 확장이다.
// answer 의 null = 누르지 않은 깃발(시간 초과면 둘 다 null).
export interface FlagOneResultPayload {
    quest: "Y" | "N";
    score: number;
    answer: FlagAnswer;
}

// GAME_RESULT — 최종 결과. 시트는 score 만 있다.
// correct_count(맞춘 개수)·win_per(이번 결과가 반영된 정답률)는 시트에 없는 확장이다.
export interface FlagGameResultPayload {
    score: number;
    correct_count: number;
    win_per: number;
}

// --- 서버 내부 / DB ---

// 문제 하나의 기록 — flag_game_log.plays 에 쓴다. answer 는 판정 시점의 최종 답(아무것도 안 눌렀으면 0,0).
// say 는 2026-10-23 추가(그 전 로그에는 없다). 정지 버튼 추가 뒤 answer 의 null = 안 누름, 0 = 정지 버튼.
export interface FlagPlayRecord {
    quest: FlagQuest;
    say: FlagSay;
    answer: FlagAnswer;
    result: "Y" | "N";
}
