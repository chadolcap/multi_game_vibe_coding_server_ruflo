// steppingRules.ts 단위 테스트 — 점핑 규칙 전체 (2026-10-14).
// MOVE_INFO 순번 검사, 라이프/탈락, 게임 점수, 동점 시 "먼저 도착" 판정을 못박아 둔다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as steppingConstants from "./steppingConstants.js";
import * as steppingRules from "./steppingRules.js";
import type { SteppingMoveInfoPayload, SteppingPlayerState } from "./steppingTypes.js";

const BLOCKS = 5;
const GAP = steppingConstants.STEPPING_MIN_MOVE_INTERVAL_MS;

function Move(count: number, save: "yes" | "no", x = 1, y = 2): SteppingMoveInfoPayload {
    return { count, location: { x, y }, save };
}

// 검사를 통과해야 하는 MOVE_INFO 를 반영한다 (통과 못 하면 테스트 실패)
function Apply(state: SteppingPlayerState, message: SteppingMoveInfoPayload, now_ms: number): void {
    assert.equal(steppingRules.ValidateMove(state, message, BLOCKS, now_ms), null);
    steppingRules.ApplyMove(state, message, BLOCKS, now_ms);
}

describe("CreatePlayerState / ComputeScore", () => {
    it("라이프 3개, 0칸에서 시작한다 — 점수 30", () => {
        const state = steppingRules.CreatePlayerState();
        assert.equal(state.life, 3);
        assert.equal(state.count, 0);
        assert.equal(steppingRules.ComputeScore(state), 30);
    });

    it("점수 = 남은 라이프 × 10 + 칸 수 × 5", () => {
        const state = steppingRules.CreatePlayerState();
        state.life = 1;
        state.count = 7;
        assert.equal(steppingRules.ComputeScore(state), 45);
    });
});

describe("PickRandomMap / IsValidMap", () => {
    it("1~3 중 하나를 고른다", () => {
        assert.equal(steppingRules.PickRandomMap(() => 0), 1);
        assert.equal(steppingRules.PickRandomMap(() => 0.999), 3);
        for (let i = 0; i < 50; i++) assert.ok(steppingRules.IsValidMap(steppingRules.PickRandomMap()));
    });

    it("범위 밖은 유효하지 않다", () => {
        assert.equal(steppingRules.IsValidMap(0), false);
        assert.equal(steppingRules.IsValidMap(4), false);
        assert.equal(steppingRules.IsValidMap(1.5), false);
    });

    it("모든 맵에 칸 수가 정의돼 있다", () => {
        for (let map = 1; map <= steppingConstants.STEPPING_MAP_COUNT; map++) {
            assert.ok(steppingRules.GetMapBlockCount(map) > 0, `맵 ${map} 칸 수 없음`);
        }
    });
});

describe("ValidateMove — 순번 검사", () => {
    it("첫 점프는 count:1 이어야 한다", () => {
        const state = steppingRules.CreatePlayerState();
        assert.equal(steppingRules.ValidateMove(state, Move(1, "yes"), BLOCKS, 0), null);
        assert.equal(steppingRules.ValidateMove(state, Move(2, "yes"), BLOCKS, 0), "OUT_OF_ORDER");
        assert.equal(steppingRules.ValidateMove(state, Move(0, "yes"), BLOCKS, 0), "OUT_OF_ORDER");
    });

    it("같은 count 재전송은 무시한다 (중복 반영 방지)", () => {
        const state = steppingRules.CreatePlayerState();
        Apply(state, Move(1, "yes"), 0);
        assert.equal(steppingRules.ValidateMove(state, Move(1, "yes"), BLOCKS, GAP), "OUT_OF_ORDER");
    });

    it("큰 값을 한 번에 보내도 받지 않는다 (count:999 조작)", () => {
        const state = steppingRules.CreatePlayerState();
        assert.equal(steppingRules.ValidateMove(state, Move(999, "yes"), BLOCKS, 0), "OUT_OF_ORDER");
    });

    it("맵의 칸 수를 넘을 수 없다", () => {
        const state = steppingRules.CreatePlayerState();
        state.count = BLOCKS;
        assert.equal(steppingRules.ValidateMove(state, Move(BLOCKS + 1, "yes"), BLOCKS, 0), "OVER_MAP");
    });

    it("최소 간격보다 빠른 연속 입력은 무시한다", () => {
        const state = steppingRules.CreatePlayerState();
        Apply(state, Move(1, "yes"), 1000);
        assert.equal(steppingRules.ValidateMove(state, Move(2, "yes"), BLOCKS, 1000 + GAP - 1), "TOO_FAST");
        assert.equal(steppingRules.ValidateMove(state, Move(2, "yes"), BLOCKS, 1000 + GAP), null);
    });

    it("형식이 틀리면 무시한다", () => {
        const state = steppingRules.CreatePlayerState();
        assert.equal(steppingRules.ValidateMove(state, null, BLOCKS, 0), "BAD_FORMAT");
        assert.equal(steppingRules.ValidateMove(state, { count: 1, save: "yes" }, BLOCKS, 0), "BAD_FORMAT");
        assert.equal(steppingRules.ValidateMove(state, { count: "1", location: { x: 0, y: 0 }, save: "yes" }, BLOCKS, 0), "BAD_FORMAT");
        assert.equal(steppingRules.ValidateMove(state, { count: 1, location: { x: 0, y: 0 }, save: "Y" }, BLOCKS, 0), "BAD_FORMAT");
        assert.equal(steppingRules.ValidateMove(state, { count: 1, location: { x: Number.NaN, y: 0 }, save: "yes" }, BLOCKS, 0), "BAD_FORMAT");
    });
});

describe("ApplyMove — 착지 / 추락 / 라이프", () => {
    it("착지하면 칸 수와 도착 시각이 바뀐다", () => {
        const state = steppingRules.CreatePlayerState();
        Apply(state, Move(1, "yes", 3, 6), 500);
        assert.equal(state.count, 1);
        assert.equal(state.reached_at, 500);
        assert.deepEqual(state.location, { x: 3, y: 6 });
    });

    it("추락하면 라이프 1개를 쓰고 칸 수는 그대로, 같은 칸을 다시 노린다", () => {
        const state = steppingRules.CreatePlayerState();
        Apply(state, Move(1, "yes"), 0);
        Apply(state, Move(2, "no"), GAP);
        assert.equal(state.life, 2);
        assert.equal(state.count, 1);
        assert.equal(state.reached_at, 0, "추락은 도착이 아니다");
        assert.deepEqual(state.location, { x: 0, y: 0 }, "앞 블록 중앙에서 다시 시작");
        // 다시 2번 칸을 노린다
        assert.equal(steppingRules.ValidateMove(state, Move(2, "yes"), BLOCKS, GAP * 2), null);
    });

    it("라이프 3개를 다 쓴 뒤 **4번째** 추락에서 탈락한다", () => {
        const state = steppingRules.CreatePlayerState();
        for (let i = 1; i <= 3; i++) {
            Apply(state, Move(1, "no"), GAP * i);
            assert.equal(state.eliminated, false, `${i}번째 추락에서 탈락하면 안 된다`);
        }
        assert.equal(state.life, 0);
        Apply(state, Move(1, "no"), GAP * 4);
        assert.equal(state.eliminated, true);
        assert.equal(steppingRules.ValidateMove(state, Move(1, "yes"), BLOCKS, GAP * 10), "FINISHED");
    });

    it("마지막 칸에 착지하면 completed 이고 더 받지 않는다", () => {
        const state = steppingRules.CreatePlayerState();
        for (let i = 1; i <= BLOCKS; i++) Apply(state, Move(i, "yes"), GAP * i);
        assert.equal(state.completed, true);
        assert.equal(steppingRules.ValidateMove(state, Move(BLOCKS + 1, "yes"), BLOCKS, GAP * 100), "FINISHED");
    });
});

describe("IsGameOverByState", () => {
    it("한 명이라도 탈락하면 끝난다", () => {
        const a = steppingRules.CreatePlayerState();
        const b = steppingRules.CreatePlayerState();
        assert.equal(steppingRules.IsGameOverByState([a, b]), false);
        b.eliminated = true;
        assert.equal(steppingRules.IsGameOverByState([a, b]), true);
    });

    it("양쪽 **모두** 모든 칸을 가야 끝난다", () => {
        const a = steppingRules.CreatePlayerState();
        const b = steppingRules.CreatePlayerState();
        a.completed = true;
        assert.equal(steppingRules.IsGameOverByState([a, b]), false);
        b.completed = true;
        assert.equal(steppingRules.IsGameOverByState([a, b]), true);
    });
});

describe("DecideWinner", () => {
    function State(life: number, count: number, reached_at: number | null): SteppingPlayerState {
        return { ...steppingRules.CreatePlayerState(), life, count, reached_at };
    }

    it("게임 점수가 높은 쪽이 이긴다 — 칸 수가 적어도 라이프가 많으면 이길 수 있다", () => {
        // a: 3×10 + 4×5 = 50, b: 0×10 + 8×5 = 40
        assert.equal(steppingRules.DecideWinner(State(3, 4, 100), State(0, 8, 50)), 1);
        assert.equal(steppingRules.DecideWinner(State(0, 8, 50), State(3, 4, 100)), -1);
    });

    it("탈락한 쪽도 점수로 비교한다 (탈락 = 게임 종료 사유일 뿐)", () => {
        const eliminated = { ...State(0, 12, 100), eliminated: true }; // 60
        assert.equal(steppingRules.DecideWinner(eliminated, State(3, 5, 50)), 1); // 60 vs 55
    });

    it("점수가 같으면 먼저 도착한 쪽이 이긴다", () => {
        // 둘 다 40점: (2,4) / (0,8)
        assert.equal(steppingRules.DecideWinner(State(2, 4, 300), State(0, 8, 500)), 1);
        assert.equal(steppingRules.DecideWinner(State(2, 4, 900), State(0, 8, 500)), -1);
    });

    it("점수가 같고 한쪽만 한 칸도 못 갔으면 도착한 쪽이 이긴다", () => {
        // a: 3×10 + 0 = 30, b: 0×10 + 6×5 = 30
        assert.equal(steppingRules.DecideWinner(State(3, 0, null), State(0, 6, 400)), -1);
    });

    it("둘 다 한 칸도 못 갔으면 무승부", () => {
        assert.equal(steppingRules.DecideWinner(State(3, 0, null), State(3, 0, null)), 0);
    });
});
