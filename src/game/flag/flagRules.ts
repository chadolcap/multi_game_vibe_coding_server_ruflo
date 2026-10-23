// 청기백기(flag) 규칙 — 순수 함수만 둔다(테스트: flagRules.test.ts). 방 상태/타이머는 FlagGameRoom 이 갖는다.

import * as flagConstants from "./flagConstants.js";
import type { FlagAnswer, FlagMove, FlagQuest, FlagSay, FlagSayCode } from "./flagTypes.js";

// 한 손의 정답 포즈 — 올림/내림/정지 (2026-10-23 동작 이미지 9장 = 3×3)
const POSE_MOVES: readonly FlagMove[] = [flagConstants.FLAG_UP, flagConstants.FLAG_DOWN, flagConstants.FLAG_KEEP];

export function IsFlagMove(value: unknown): value is FlagMove {
    return value === flagConstants.FLAG_DOWN || value === flagConstants.FLAG_KEEP || value === flagConstants.FLAG_UP;
}

// C→S QUEST_SHOW 의 quest 가 { b, w } 모양이고 값이 -1/0/1 인지
// 2026-10-23 사용자 변경(정지 버튼 추가): 0 = 정지 버튼, 누르지 않은 깃발은 키 없음/null.
// 형식이 맞으면 { b, w }(안 누름 = null)로 정리해 돌려주고, 틀렸거나 둘 다 안 눌렀으면 null.
export function ReadAnswer(value: unknown): FlagAnswer | null {
    if (typeof value !== "object" || value === null) return null;
    const quest = value as Record<string, unknown>;
    const read_one = (move: unknown): FlagMove | null | undefined => {
        if (move === undefined || move === null) return null;
        return IsFlagMove(move) ? move : undefined; // undefined = 형식 오류
    };
    const b = read_one(quest.b);
    const w = read_one(quest.w);
    if (b === undefined || w === undefined) return null;
    if (b === null && w === null) return null;
    return { b, w };
}

// 아무것도 안 누른 답 — 시간 초과 기록용
export function EmptyAnswer(): FlagAnswer {
    return { b: null, w: null };
}

// 문제 하나를 랜덤으로 만든다 — 한쪽 명령(청기/백기 × 올려/내려 4종) 또는 양쪽 명령(4종).
// 바로 앞 문제와 똑같은 문제는 내지 않는다. random 은 테스트에서 고정값을 넣으려고 받는다.
// 2026-10-23 사용자 변경(동작 이미지 9장): 정답 포즈 = 양손 각각 올림/내림/정지(3×3=9)를 균등하게 고른다.
// 양손 정지 {0,0} 도 나온다. 문구(올리지마/내리지마/말 안 함)는 CreateSay 가 정한다.
export function CreateQuest(previous: FlagQuest | null, random: () => number = Math.random): FlagQuest {
    for (;;) {
        const pick_move = (): FlagMove => POSE_MOVES[Math.floor(random() * POSE_MOVES.length)];
        const quest: FlagQuest = { b: pick_move(), w: pick_move() };
        if (!previous || quest.b !== previous.b || quest.w !== previous.w) return quest;
    }
}

// 문제 문구 코드를 정한다 — 움직이는 손은 그대로 "up"/"down", 정지(0)인 손은 "no_up"/"no_down"/""(말 안 함) 중 랜덤.
// 양손 다 말하지 않는 문구는 없으므로 다시 고른다.
export function CreateSay(quest: FlagQuest, random: () => number = Math.random): FlagSay {
    const say_of = (move: FlagMove): FlagSayCode => {
        if (move === flagConstants.FLAG_UP) return "up";
        if (move === flagConstants.FLAG_DOWN) return "down";
        return flagConstants.FLAG_KEEP_SAY_CODES[Math.floor(random() * flagConstants.FLAG_KEEP_SAY_CODES.length)];
    };
    for (;;) {
        const say: FlagSay = { b: say_of(quest.b), w: say_of(quest.w) };
        if (say.b !== "" || say.w !== "") return say;
    }
}

// ⚠️ 2026-10-23 사용자 변경(정지 버튼 추가)으로 답 누적(MergeAnswer)과 조기 판정(IsAnswerSettled)을 없앴다.
//    "청기 올려, 백기 내리지마"에서 청기만 누르면 정답이 돼, 간발의 차이로 백기를 내려도 정답 처리됐기 때문이다.
//    지금은 클라이언트가 문제에 나온 깃발의 버튼을 모두 받아 한 번에 보내고, 서버는 처음 온 답 하나로 판정한다.

// 깃발 하나가 문구대로인지 — answer null = 안 누름, 0 = 정지 버튼 (사용자 결정 2026-10-23)
//   "up" 올림만 / "down" 내림만 / "no_up" 내림·정지 / "no_down" 올림·정지
//   "" (문제에 없는 깃발) 안 누름·정지 통과, 올림·내림은 오답
export function IsFlagCorrect(say: FlagSayCode, answer: FlagMove | null): boolean {
    switch (say) {
        case "up":
            return answer === flagConstants.FLAG_UP;
        case "down":
            return answer === flagConstants.FLAG_DOWN;
        case "no_up":
            return answer === flagConstants.FLAG_DOWN || answer === flagConstants.FLAG_KEEP;
        case "no_down":
            return answer === flagConstants.FLAG_UP || answer === flagConstants.FLAG_KEEP;
        case "":
            return answer === null || answer === flagConstants.FLAG_KEEP;
    }
}

// 정답 = 양쪽 깃발 모두 문구대로. 판정 기준은 quest(대표 포즈)가 아니라 say 다(2026-10-23).
// 양손 정지 문제도 문제에 나온 깃발은 버튼을 눌러야 정답이다 — 시간 초과(둘 다 null)는 항상 오답.
export function IsCorrect(say: FlagSay, answer: FlagAnswer): boolean {
    return IsFlagCorrect(say.b, answer.b) && IsFlagCorrect(say.w, answer.w);
}

export function ComputeScore(correct_count: number): number {
    return correct_count * flagConstants.FLAG_SCORE_PER_CORRECT;
}

// 정답률(0~100 정수) — 사용자 결정(2026-10-22): "맞춘 횟수/5 를 기존 승률에 합산 평균".
// 한 게임은 항상 FLAG_QUEST_COUNT 문제라, 게임마다 (맞춘 수/5)를 평균한 값 = 누적 맞춘 수 / (게임 수 × 5) 다.
// 그래서 통계 테이블의 total_win_count 에 **맞춘 개수**를 누적한다(다른 게임의 "이긴 판 수" 자리).
// 중도 퇴장한 게임도 5문제 기준으로 센다(못 푼 문제는 틀린 것).
export function ComputeWinPer(total_correct_count: number, total_game_count: number): number {
    if (total_game_count === 0) return 0;
    return Math.round((total_correct_count / (total_game_count * flagConstants.FLAG_QUEST_COUNT)) * 100);
}
