// flagRules.ts 단위 테스트 — 청기백기 문제 생성, 답 형식·판정(정지 버튼), 점수, 정답률 (2026-10-22).
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as flagConstants from "./flagConstants.js";
import * as flagRules from "./flagRules.js";
import type { FlagQuest, FlagSay } from "./flagTypes.js";

// 고정 시드 난수 — 매번 같은 결과가 나오게 한다
function SeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

describe("ReadAnswer — C→S QUEST_SHOW 형식 (2026-10-23 정지 버튼: 0 = 정지, 안 누름 = 키 없음/null)", () => {
    it("b, w 가 -1/0/1 이거나 빠진(null) 객체를 받아 안 누름을 null 로 정리한다", () => {
        assert.deepEqual(flagRules.ReadAnswer({ b: 1, w: 0 }), { b: 1, w: 0 });
        assert.deepEqual(flagRules.ReadAnswer({ b: -1, w: -1 }), { b: -1, w: -1 });
        assert.deepEqual(flagRules.ReadAnswer({ b: 1 }), { b: 1, w: null });
        assert.deepEqual(flagRules.ReadAnswer({ w: 0, b: null }), { b: null, w: 0 });
    });

    it("형식이 틀렸거나 아무것도 안 누른 답은 null(무시)", () => {
        assert.equal(flagRules.ReadAnswer({ b: 2, w: 0 }), null);
        assert.equal(flagRules.ReadAnswer({ b: "1", w: 0 }), null);
        assert.equal(flagRules.ReadAnswer({}), null);
        assert.equal(flagRules.ReadAnswer({ b: null, w: null }), null);
        assert.equal(flagRules.ReadAnswer(null), null);
        assert.equal(flagRules.ReadAnswer("Y"), null);
    });
});

describe("CreateQuest — 문제 생성", () => {
    it("값은 올려(1)/내려(-1)/정지(0) 뿐이다", () => {
        const random = SeededRandom(7);
        let previous: FlagQuest | null = null;
        for (let i = 0; i < 500; i++) {
            const quest = flagRules.CreateQuest(previous, random);
            assert.ok(flagRules.IsFlagMove(quest.b) && flagRules.IsFlagMove(quest.w));
            previous = quest;
        }
    });

    it("정답 포즈 9종(양손 정지 포함)이 모두 나온다 (2026-10-23 사용자 변경: 동작 이미지 9장)", () => {
        const random = SeededRandom(11);
        const seen = new Set<string>();
        let previous: FlagQuest | null = null;
        for (let i = 0; i < 500; i++) {
            const quest = flagRules.CreateQuest(previous, random);
            seen.add(`${quest.b},${quest.w}`);
            previous = quest;
        }
        assert.deepEqual([...seen].sort(), ["-1,-1", "-1,0", "-1,1", "0,-1", "0,0", "0,1", "1,-1", "1,0", "1,1"]);
    });

    it("바로 앞 문제와 같은 문제는 내지 않는다", () => {
        const random = SeededRandom(3);
        let previous = flagRules.CreateQuest(null, random);
        for (let i = 0; i < 500; i++) {
            const quest = flagRules.CreateQuest(previous, random);
            assert.notDeepEqual(quest, previous);
            previous = quest;
        }
    });
});

describe("CreateSay — 문제 문구 코드 (2026-10-23)", () => {
    it("움직이는 손은 up/down 으로만 말한다", () => {
        const random = SeededRandom(5);
        for (let i = 0; i < 100; i++) {
            assert.deepEqual(flagRules.CreateSay({ b: 1, w: -1 }, random), { b: "up", w: "down" });
        }
    });

    it("정지인 손은 올리지마/내리지마/말 안 함 3종으로 나온다 — '오른손 올림, 왼손 정지' 예시", () => {
        const random = SeededRandom(9);
        const seen = new Set<string>();
        for (let i = 0; i < 300; i++) {
            const say = flagRules.CreateSay({ b: 1, w: 0 }, random);
            assert.equal(say.b, "up");
            seen.add(say.w);
        }
        assert.deepEqual([...seen].sort(), ["", "no_down", "no_up"]);
    });

    it("양손 정지 문제는 적어도 한 손은 말한다 (빈 문제 없음)", () => {
        const random = SeededRandom(13);
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) {
            const say = flagRules.CreateSay({ b: 0, w: 0 }, random);
            assert.ok(say.b !== "" || say.w !== "", "아무 말도 없는 문제가 나왔다");
            assert.ok(say.b !== "up" && say.b !== "down" && say.w !== "up" && say.w !== "down");
            seen.add(`${say.b},${say.w}`);
        }
        assert.equal(seen.size, 8, "3×3 에서 둘 다 말 안 함을 뺀 8가지");
    });
});

// 2026-10-23 사용자 변경(정지 버튼 추가): 답 누적·조기 판정(MergeAnswer/IsAnswerSettled)을 없애고
// 문구(say)로 판정한다. 0 = 정지 버튼, null = 안 누름.
describe("IsCorrect — 문구(say) 기준 판정 (정지 버튼)", () => {
    const Answer = (b: -1 | 0 | 1 | null, w: -1 | 0 | 1 | null) => ({ b, w });

    it("신고 사례: '청기 올려, 백기 내리지마' 는 청기만 누른 답으로는 정답이 아니다(백기 버튼 필요)", () => {
        const say: FlagSay = { b: "up", w: "no_down" };
        assert.equal(flagRules.IsCorrect(say, Answer(1, null)), false, "청기만 눌렀는데 정답 처리됐다");
        assert.equal(flagRules.IsCorrect(say, Answer(1, 0)), true, "백기 정지 = 정답");
        assert.equal(flagRules.IsCorrect(say, Answer(1, 1)), true, "내리지마 → 올림도 정답 (사용자 결정)");
        assert.equal(flagRules.IsCorrect(say, Answer(1, -1)), false, "백기를 내리면 오답");
    });

    it("올리지마 → 내림·정지 정답, 올림 오답", () => {
        assert.equal(flagRules.IsFlagCorrect("no_up", -1), true);
        assert.equal(flagRules.IsFlagCorrect("no_up", 0), true);
        assert.equal(flagRules.IsFlagCorrect("no_up", 1), false);
        assert.equal(flagRules.IsFlagCorrect("no_up", null), false, "안 누르면 오답");
    });

    it("올려/내려 는 그 버튼만 정답 — 정지 버튼은 오답", () => {
        assert.equal(flagRules.IsFlagCorrect("up", 1), true);
        assert.equal(flagRules.IsFlagCorrect("up", 0), false);
        assert.equal(flagRules.IsFlagCorrect("down", -1), true);
        assert.equal(flagRules.IsFlagCorrect("down", 1), false);
        assert.equal(flagRules.IsFlagCorrect("down", null), false);
    });

    it("문제에 없는 깃발: 안 누름·정지는 통과, 올림·내림은 오답 (사용자 결정)", () => {
        const say: FlagSay = { b: "up", w: "" };
        assert.equal(flagRules.IsCorrect(say, Answer(1, null)), true);
        assert.equal(flagRules.IsCorrect(say, Answer(1, 0)), true);
        assert.equal(flagRules.IsCorrect(say, Answer(1, 1)), false);
        assert.equal(flagRules.IsCorrect(say, Answer(1, -1)), false);
    });

    it("양손 정지 문제도 버튼을 눌러야 정답 — 시간 초과(안 누름)는 오답 (사용자 결정)", () => {
        const say: FlagSay = { b: "no_up", w: "no_down" };
        assert.equal(flagRules.IsCorrect(say, flagRules.EmptyAnswer()), false);
        assert.equal(flagRules.IsCorrect(say, Answer(0, 0)), true);
        assert.equal(flagRules.IsCorrect(say, Answer(-1, 1)), true);
        assert.equal(flagRules.IsCorrect({ b: "no_down", w: "" }, Answer(0, null)), true, "'청기 내리지마' 한쪽 문제");
        assert.equal(flagRules.IsCorrect({ b: "no_down", w: "" }, flagRules.EmptyAnswer()), false);
    });

    it("시간 초과는 어떤 문제든 오답", () => {
        for (const say of [{ b: "up", w: "" }, { b: "down", w: "up" }, { b: "", w: "no_up" }] as FlagSay[]) {
            assert.equal(flagRules.IsCorrect(say, flagRules.EmptyAnswer()), false, JSON.stringify(say));
        }
    });
});

describe("ComputeScore / ComputeWinPer", () => {
    it("게임 점수 = 맞춘 수 × 5 (시트: 1판에 5점), 만점 25", () => {
        assert.equal(flagRules.ComputeScore(0), 0);
        assert.equal(flagRules.ComputeScore(3), 15);
        assert.equal(flagRules.ComputeScore(flagConstants.FLAG_QUEST_COUNT), 25);
    });

    it("정답률 = 게임마다 (맞춘 수 / 5) 의 평균 (사용자 결정 2026-10-22)", () => {
        // 5/5, 2/5, 0/5 → (100 + 40 + 0) / 3 = 46.7 → 47
        assert.equal(flagRules.ComputeWinPer(5 + 2 + 0, 3), 47);
        assert.equal(flagRules.ComputeWinPer(5, 1), 100);
        assert.equal(flagRules.ComputeWinPer(0, 0), 0);
    });
});
