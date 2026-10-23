// airhockeyRules.ts 단위 테스트 — 에어하키 좌표 변환, 레버 영역, 물리(벽/레버/골), 봇, 승패 (2026-10-15).
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as airhockeyConstants from "./airhockeyConstants.js";
import * as airhockeyRules from "./airhockeyRules.js";
import type { AirhockeyLeverState, AirhockeyPuckState } from "./airhockeyTypes.js";

const HALF_W = airhockeyConstants.AIRHOCKEY_TABLE_WIDTH / 2;
const HALF_H = airhockeyConstants.AIRHOCKEY_TABLE_HEIGHT / 2;
const PUCK_R = airhockeyConstants.AIRHOCKEY_PUCK_RADIUS;
const LEVER_R = airhockeyConstants.AIRHOCKEY_LEVER_RADIUS;
const DT = airhockeyConstants.AIRHOCKEY_TICK_MS / 1000;
const NO_JITTER = (): number => 0.5; // 봇 조준 흔들기를 0 으로 만드는 난수

function Puck(x: number, y: number, vx = 0, vy = 0): AirhockeyPuckState {
    return { x, y, vx, vy };
}

// 레버 하나를 (x, y)에 멈춰 세운다 (목표·손도 같은 자리)
function LeverAt(side: 0 | 1, x: number, y: number): AirhockeyLeverState {
    const lever = airhockeyRules.CreateLever(side);
    Object.assign(lever, { x, y, target_x: x, target_y: y, hand_x: x, hand_y: y });
    return lever;
}

// 손이 hand_speed(단위/초)로 위로 움직이고, 클라이언트가 실제처럼 2틱(33ms)마다 LEVER_MOVE 를 보낸다.
// 퍽에 처음 닿은 순간의 퍽 속도와, 그 전까지 서버 레버의 틱별 vy 를 돌려준다.
// 퍽은 레버가 무게를 이기고 손 속도까지 다 올라간 뒤에 닿도록 멀리(400) 둔다.
function SwingAt(hand_speed: number): { puck_speed: number; lever_vy: number[] } {
    const lever = LeverAt(0, 0, -500);
    const puck = Puck(0, -100);
    let hand_y = -500;
    let now_ms = 1000;
    const lever_vy: number[] = [];
    for (let tick = 0; tick < 120; tick++) {
        hand_y += hand_speed * DT;
        now_ms += DT * 1000;
        if (tick % 2 === 0) airhockeyRules.SetLeverTarget(lever, { x: 0, y: hand_y }, now_ms);
        airhockeyRules.StepWorld(puck, [lever], DT);
        if (airhockeyRules.IsPuckMoving(puck)) break;
        lever_vy.push(lever.vy);
    }
    return { puck_speed: Math.hypot(puck.vx, puck.vy), lever_vy };
}

// 레버 없이(멀리 치워 두고) 골이 나거나 max_ticks 가 될 때까지 돌린다
function RunUntilGoal(puck: AirhockeyPuckState, levers: AirhockeyLeverState[], max_ticks = 600): 0 | 1 | null {
    for (let tick = 0; tick < max_ticks; tick++) {
        const result = airhockeyRules.StepWorld(puck, levers, DT);
        if (result.goal !== null) return result.goal;
    }
    return null;
}

describe("ToSideFrame — 내가 아래인 좌표계", () => {
    it("side 0(player1)은 그대로다", () => {
        assert.deepEqual(airhockeyRules.ToSideFrame({ x: 31, y: -40 }, 0), { x: 31, y: -40 });
    });

    it("side 1(player2)은 180도 돌린다 — 상대 좌표는 반대 방향 (시트)", () => {
        assert.deepEqual(airhockeyRules.ToSideFrame({ x: 31, y: 40 }, 1), { x: -31, y: -40 });
    });

    it("두 번 바꾸면 원래대로 돌아온다", () => {
        const point = { x: 12.5, y: -300 };
        assert.deepEqual(airhockeyRules.ToSideFrame(airhockeyRules.ToSideFrame(point, 1), 1), point);
    });

    it("중앙(0,0)을 뒤집어도 -0 이 나가지 않는다", () => {
        const flipped = airhockeyRules.ToSideFrame({ x: 0, y: 0 }, 1);
        assert.ok(Object.is(flipped.x, 0) && Object.is(flipped.y, 0));
    });
});

describe("IsValidPoint", () => {
    it("유한한 숫자 x, y 만 받는다", () => {
        assert.equal(airhockeyRules.IsValidPoint({ x: 1, y: -2 }), true);
        assert.equal(airhockeyRules.IsValidPoint({ x: "1", y: 2 }), false);
        assert.equal(airhockeyRules.IsValidPoint({ x: Number.NaN, y: 2 }), false);
        assert.equal(airhockeyRules.IsValidPoint({ x: Infinity, y: 2 }), false);
        assert.equal(airhockeyRules.IsValidPoint({ x: 1 }), false);
        assert.equal(airhockeyRules.IsValidPoint(null), false);
    });
});

describe("ClampLeverPosition — 자기 쪽 절반만", () => {
    it("아래쪽 레버는 중앙선을 넘지 못한다", () => {
        assert.deepEqual(airhockeyRules.ClampLeverPosition(0, { x: 0, y: 500 }), { x: 0, y: -LEVER_R });
    });

    it("위쪽 레버는 중앙선 아래로 못 내려온다", () => {
        assert.deepEqual(airhockeyRules.ClampLeverPosition(1, { x: 0, y: -500 }), { x: 0, y: LEVER_R });
    });

    it("테이블 밖으로 나가지 못한다", () => {
        assert.deepEqual(airhockeyRules.ClampLeverPosition(0, { x: -9999, y: -9999 }), {
            x: -HALF_W + LEVER_R,
            y: -HALF_H + LEVER_R,
        });
    });

    it("SetLeverTarget 도 같은 영역으로 자른다", () => {
        const lever = airhockeyRules.CreateLever(0);
        airhockeyRules.SetLeverTarget(lever, { x: 9999, y: 9999 });
        assert.equal(lever.target_x, HALF_W - LEVER_R);
        assert.equal(lever.target_y, -LEVER_R);
    });
});

describe("CreatePuck / CreateLever", () => {
    it("퍽은 중앙에서 멈춘 채로 시작한다 (시트: 처음 위치는 중앙선)", () => {
        assert.deepEqual(airhockeyRules.CreatePuck(), { x: 0, y: 0, vx: 0, vy: 0 });
    });

    it("레버는 자기 골대 앞에서 시작한다 — 서로 대칭", () => {
        const bottom = airhockeyRules.CreateLever(0);
        const top = airhockeyRules.CreateLever(1);
        assert.ok(bottom.y < 0 && top.y > 0);
        assert.equal(bottom.y, -top.y);
    });
});

describe("StepWorld — 벽", () => {
    it("옆벽에 맞으면 튕기고 속도가 조금 줄어든다", () => {
        const puck = Puck(HALF_W - PUCK_R - 1, 0, 600, 0);
        airhockeyRules.StepWorld(puck, [], DT);
        assert.ok(puck.vx < 0, "튕기지 않았다");
        assert.ok(Math.abs(puck.vx) < 600);
        assert.ok(puck.x <= HALF_W - PUCK_R);
    });

    it("끝벽 중 골대 입구가 아닌 곳은 튕긴다", () => {
        const puck = Puck(HALF_W - PUCK_R - 10, -HALF_H + PUCK_R + 1, 0, -600);
        assert.equal(RunUntilGoal(puck, [], 30), null);
        assert.ok(puck.vy > 0, "끝벽에서 튕기지 않았다");
    });

    it("마찰로 결국 멈춘다", () => {
        const puck = Puck(0, 0, 50, 0);
        for (let tick = 0; tick < 60 * 30; tick++) airhockeyRules.StepWorld(puck, [], DT);
        assert.equal(airhockeyRules.IsPuckMoving(puck), false);
    });
});

describe("StepWorld — 골", () => {
    it("아래 골대에 들어가면 위쪽 유저(side 1)의 골이다", () => {
        assert.equal(RunUntilGoal(Puck(0, -200, 0, -1000), []), 1);
    });

    it("위 골대에 들어가면 아래쪽 유저(side 0)의 골이다", () => {
        assert.equal(RunUntilGoal(Puck(0, 200, 0, 1000), []), 0);
    });

    it("골대 입구 가장자리 바깥으로 오면 들어가지 않는다", () => {
        const outside_x = airhockeyConstants.AIRHOCKEY_GOAL_WIDTH / 2 + 5;
        const puck = Puck(outside_x, 200, 0, 1000);
        assert.equal(RunUntilGoal(puck, [], 60), null);
    });

    it("골이 나면 퍽이 멈춘다", () => {
        const puck = Puck(0, 200, 0, 1000);
        RunUntilGoal(puck, []);
        assert.equal(airhockeyRules.IsPuckMoving(puck), false);
    });
});

describe("StepWorld — 레버", () => {
    it("멈춘 퍽을 레버로 치면 레버가 움직인 방향으로 날아간다", () => {
        const puck = airhockeyRules.CreatePuck();
        const lever = LeverAt(0, 0, -200);
        lever.target_y = -LEVER_R; // 중앙선 쪽으로 빠르게 올린다
        for (let tick = 0; tick < 10; tick++) airhockeyRules.StepWorld(puck, [lever], DT);
        assert.ok(puck.vy > 0, `퍽이 위로 안 날아갔다 vy=${puck.vy}`);
    });

    it("레버는 최대 속도보다 빨리 움직이지 않는다 — 순간이동 좌표로 퍽에 무한대 힘을 줄 수 없다", () => {
        const lever = LeverAt(0, 0, -HALF_H + LEVER_R);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -LEVER_R });
        airhockeyRules.StepWorld(Puck(HALF_W - PUCK_R, HALF_H - 100), [lever], DT);
        const max_move = airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED * DT;
        assert.ok(lever.y - (-HALF_H + LEVER_R) <= max_move + 1e-9);
        assert.ok(Math.hypot(lever.vx, lever.vy) <= airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED + 1e-9);
    });

    it("퍽 속도는 최대 속도를 넘지 않는다", () => {
        const puck = Puck(0, -100, 0, -airhockeyConstants.AIRHOCKEY_PUCK_MAX_SPEED);
        const lever = LeverAt(0, 0, -100 - PUCK_R - LEVER_R + 5);
        lever.vy = airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED;
        airhockeyRules.CollidePuckWithLever(puck, lever);
        assert.ok(Math.hypot(puck.vx, puck.vy) <= airhockeyConstants.AIRHOCKEY_PUCK_MAX_SPEED + 1e-6);
    });

    it("겹친 퍽은 레버 바깥으로 밀려난다", () => {
        const puck = Puck(0, -150);
        const lever = LeverAt(0, 0, -160);
        assert.equal(airhockeyRules.CollidePuckWithLever(puck, lever), true);
        assert.ok(Math.hypot(puck.x - lever.x, puck.y - lever.y) >= PUCK_R + LEVER_R - 1e-9);
    });

    it("정확히 같은 자리에 겹치면 그 레버의 상대 골대 쪽으로 밀어낸다", () => {
        const puck = Puck(0, -150);
        airhockeyRules.CollidePuckWithLever(puck, LeverAt(0, 0, -150));
        assert.ok(puck.y > -150);
    });
});

describe("레버 타격 손맛 — 30Hz 입력 (2026-10-15 수정)", () => {
    it("2틱마다 오는 입력에도 서버 레버 속도가 손 속도로 일정하다 (예전: [0, 2V, 0, 2V …])", () => {
        const { lever_vy } = SwingAt(600);
        // 처음 틱들은 입력 간격을 추정하고 레버가 무게를 이기며 가속하는 중이라 빼고 본다
        assert.ok(lever_vy.length > 25, `퍽에 너무 일찍 닿았다 (${lever_vy.length}틱)`);
        for (const vy of lever_vy.slice(20)) {
            assert.ok(Math.abs(vy - 600) < 60, `레버 속도가 튄다: ${lever_vy.map(Math.round).join(",")}`);
        }
    });

    it("멈춘 퍽을 치면 손 속도의 약 1.3배로 나간다 — (1 + e) × M/(M+1)", () => {
        const expected = (1 + airhockeyConstants.AIRHOCKEY_LEVER_RESTITUTION) *
            (airhockeyConstants.AIRHOCKEY_LEVER_MASS_RATIO / (airhockeyConstants.AIRHOCKEY_LEVER_MASS_RATIO + 1));
        const { puck_speed } = SwingAt(600);
        assert.ok(Math.abs(puck_speed / 600 - expected) < 0.1, `퍽/손 = ${(puck_speed / 600).toFixed(2)}, 기대 ${expected.toFixed(2)}`);
    });

    it("세게 칠수록 세게 날아간다 — 살살(300)과 세게(1200)가 4배 가까이 차이 난다", () => {
        const soft = SwingAt(300).puck_speed;
        const hard = SwingAt(1200).puck_speed;
        assert.ok(hard / soft > 3.5, `soft=${Math.round(soft)} hard=${Math.round(hard)}`);
        assert.ok(hard < airhockeyConstants.AIRHOCKEY_PUCK_MAX_SPEED, "1200/초 타격이 벌써 상한에 걸린다");
    });

    it("맞은 뒤 퍽은 레버보다 빨라서 레버에 달라붙지 않는다", () => {
        const puck = Puck(0, -300);
        const lever = LeverAt(0, 0, -300 - PUCK_R - LEVER_R + 2);
        lever.vy = 800;
        airhockeyRules.CollidePuckWithLever(puck, lever);
        assert.ok(puck.vy > lever.vy, `puck.vy=${puck.vy} lever.vy=${lever.vy}`);
    });

    it("손을 멈추면 레버도 목표에서 멈춘다 (예측해서 지나가지 않는다)", () => {
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -450 }, 1000);
        for (let tick = 0; tick < 30; tick++) airhockeyRules.MoveLeversOnly([lever], DT);
        assert.ok(Math.abs(lever.y - -450) < 1e-9);
        assert.equal(lever.vy, 0);
    });
});

describe("레버 무게 (2026-10-22 — 퍽이 너무 쉽게 튄다)", () => {
    // 손이 한 번에 jump 만큼 위로 갔다가 멈춘다(LEVER_MOVE 한 번). 그동안 레버가 낸 가장 빠른 속도를 돌려준다.
    function JabPeakSpeed(jump: number): number {
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -500 + jump }, 1000);
        let peak = 0;
        for (let tick = 0; tick < 30; tick++) {
            airhockeyRules.MoveLeversOnly([lever], DT);
            peak = Math.max(peak, Math.hypot(lever.vx, lever.vy));
        }
        return peak;
    }

    it("짧게 툭 친 손은 레버가 다 가속하기 전에 끝나서 손 속도의 절반 정도만 낸다", () => {
        // 30Hz 한 패킷에 40 이동 = 손 1200/초
        const hand_speed = 40 / airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_SEC;
        const peak = JabPeakSpeed(40);
        assert.ok(peak < hand_speed * 0.6, `툭 친 레버 최고 속도 ${Math.round(peak)} / 손 ${Math.round(hand_speed)}`);
    });

    it("손을 멈추면 레버는 손을 지나치지 않고 손 자리에서 멈춘다", () => {
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -400 }, 1000);
        let max_y = -Infinity;
        for (let tick = 0; tick < 60; tick++) {
            airhockeyRules.MoveLeversOnly([lever], DT);
            max_y = Math.max(max_y, lever.y);
        }
        assert.ok(max_y <= -400 + 1e-9, `지나쳤다 max_y=${max_y}`);
        assert.deepEqual([lever.y, lever.vy], [-400, 0]);
    });

    it("레버는 손을 무게만큼 늦게 따라간다 — 한 틱에 손과의 거리 중 1 - e^(-dt/τ) 만큼", () => {
        const lever = LeverAt(0, 0, -500);
        Object.assign(lever, { hand_y: -400, target_y: -400 });
        airhockeyRules.MoveLeversOnly([lever], DT);
        const expected = -500 + 100 * airhockeyRules.GetLeverFollowRatio(DT);
        assert.ok(Math.abs(lever.y - expected) < 1e-9, `lever.y=${lever.y} 기대 ${expected}`);
    });
});

describe("MoveLeversOnly — 판 사이", () => {
    it("손은 목표 쪽으로 최대 속도까지, 레버는 그 손을 무게만큼 늦게 따라간다", () => {
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -LEVER_R }, 1000);
        airhockeyRules.MoveLeversOnly([lever], DT);
        const max_move = airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED * DT;
        assert.ok(Math.abs(lever.hand_y - (-500 + max_move)) < 1e-9);
        assert.ok(lever.y > -500 && lever.y < lever.hand_y, `lever.y=${lever.y} hand_y=${lever.hand_y}`);
    });

    it("봇(now_ms 없음)은 무게 없이 손에 바로 붙는다 — 봇 판단이 레버 위치 기준으로 맞춰져 있다", () => {
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SetLeverTarget(lever, { x: 0, y: -490 });
        airhockeyRules.MoveLeversOnly([lever], DT);
        assert.equal(lever.y, -490);
    });
});

describe("ComputeBotTarget — 봇", () => {
    it("퍽이 상대 쪽에 있으면 자기 골대 앞으로 돌아간다", () => {
        const lever = LeverAt(0, 200, -LEVER_R);
        const puck = Puck(0, 300);
        for (let tick = 0; tick < 120; tick++) {
            const target = airhockeyRules.ComputeBotTarget(lever, puck, DT);
            lever.x = target.x;
            lever.y = target.y;
        }
        assert.ok(Math.abs(lever.y - airhockeyRules.GetLeverHome(0).y) < 1);
    });

    it("한 틱에 봇 속도만큼만 움직인다", () => {
        const lever = LeverAt(0, 0, -500);
        const target = airhockeyRules.ComputeBotTarget(lever, Puck(300, -100), DT);
        const moved = Math.hypot(target.x - lever.x, target.y - lever.y);
        assert.ok(moved <= airhockeyConstants.AIRHOCKEY_BOT_SPEED * DT + 1e-9);
    });

    it("항상 자기 쪽 절반 안의 좌표를 고른다 (위쪽 봇)", () => {
        const lever = airhockeyRules.CreateLever(1);
        const target = airhockeyRules.ComputeBotTarget(lever, Puck(0, -400), DT);
        assert.ok(target.y >= LEVER_R);
    });

    it("멈춘 퍽이 봇 쪽에 있으면 봇이 쳐서 상대 쪽으로 보낸다 (위쪽 봇)", () => {
        const puck = Puck(40, 250);
        const levers = [LeverAt(0, -300, -HALF_H + LEVER_R), airhockeyRules.CreateLever(1)];
        let crossed = false;
        for (let tick = 0; tick < 60 * 5 && !crossed; tick++) {
            airhockeyRules.SetLeverTarget(levers[1], airhockeyRules.ComputeBotTarget(levers[1], puck, DT, NO_JITTER));
            const result = airhockeyRules.StepWorld(puck, levers, DT);
            if (puck.y < 0 || result.goal === 1) crossed = true;
        }
        assert.ok(crossed, `봇이 퍽을 못 쳐 냈다 puck=(${puck.x},${puck.y})`);
    });

    it("봇끼리 붙어도 골이 난다 — 조준 흔들기가 대칭 교착을 깬다 (둘 다 끊긴 방이 영원히 안 끝나는 것 방지)", () => {
        // 고정 시드 난수 — 매번 같은 결과가 나오게 한다
        let seed = 12345;
        const SeededRandom = (): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let round = 0; round < 5; round++) {
            const puck = airhockeyRules.CreatePuck();
            const levers = [airhockeyRules.CreateLever(0), airhockeyRules.CreateLever(1)];
            let goal: 0 | 1 | null = null;
            for (let tick = 0; tick < 60 * 60 && goal === null; tick++) {
                for (const lever of levers) {
                    airhockeyRules.SetLeverTarget(lever, airhockeyRules.ComputeBotTarget(lever, puck, DT, SeededRandom));
                }
                goal = airhockeyRules.StepWorld(puck, levers, DT).goal;
            }
            assert.notEqual(goal, null, `${round + 1}번째 판이 60초 안에 안 끝났다`);
        }
    });

    it("구석에 갇힌 느린 퍽에 붙어 있으면 물러난다 — 계속 누르면 영원히 못 빼낸다", () => {
        const corner = { x: HALF_W - PUCK_R, y: -HALF_H + PUCK_R };
        const lever = LeverAt(0, HALF_W - LEVER_R - 60, -HALF_H + LEVER_R);
        // 퍽을 레버에 딱 붙인다 (충돌 직후처럼 반지름 합 거리)
        const dx = corner.x - lever.x;
        const dy = corner.y - lever.y;
        const scale = (PUCK_R + LEVER_R) / Math.hypot(dx, dy);
        const puck = Puck(lever.x + dx * scale, lever.y + dy * scale);
        const target = airhockeyRules.ComputeBotTarget(lever, puck, DT, NO_JITTER);
        const before = Math.hypot(puck.x - lever.x, puck.y - lever.y);
        const after = Math.hypot(puck.x - target.x, puck.y - target.y);
        assert.ok(after > before, `물러나지 않았다 before=${before.toFixed(1)} after=${after.toFixed(1)}`);
    });

    it("흔들기가 없으면 봇끼리 교착한다 — 위 상수를 빼면 안 되는 이유", () => {
        const puck = airhockeyRules.CreatePuck();
        const levers = [airhockeyRules.CreateLever(0), airhockeyRules.CreateLever(1)];
        let goal: 0 | 1 | null = null;
        for (let tick = 0; tick < 60 * 20 && goal === null; tick++) {
            for (const lever of levers) {
                airhockeyRules.SetLeverTarget(lever, airhockeyRules.ComputeBotTarget(lever, puck, DT, NO_JITTER));
            }
            goal = airhockeyRules.StepWorld(puck, levers, DT).goal;
        }
        assert.equal(goal, null);
    });
});

describe("ResetLeverMotion / SnapLever — ONE_START 때 이전 궤적 무시, 첫 LEVER_MOVE 가 시작 위치", () => {
    it("ResetLeverMotion 은 지금 자리에 멈춰 세운다 — 따라가던 목표·속도·입력 간격 기록을 지운다", () => {
        const lever = LeverAt(0, 100, -300);
        airhockeyRules.SetLeverTarget(lever, { x: -200, y: -100 }, 1000);
        airhockeyRules.MoveLeversOnly([lever], DT);
        assert.ok(lever.vx !== 0 || lever.vy !== 0, "준비: 레버가 움직이는 중");
        const [x, y] = [lever.x, lever.y];

        airhockeyRules.ResetLeverMotion(lever);
        airhockeyRules.MoveLeversOnly([lever], DT);
        assert.deepEqual([lever.x, lever.y, lever.vx, lever.vy], [x, y, 0, 0]);
        assert.equal(lever.last_input_at_ms, null);
        assert.equal(lever.input_interval_sec, airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_SEC);
    });

    it("SnapLever 는 멀리 떨어진 좌표에도 바로 놓는다 — 이전 자리에서 끌려오지 않는다", () => {
        const lever = LeverAt(0, -250, -500);
        airhockeyRules.SnapLever(lever, { x: 200, y: -150 }, 5000);
        assert.deepEqual([lever.x, lever.y, lever.target_x, lever.target_y, lever.vx, lever.vy], [200, -150, 200, -150, 0, 0]);
        assert.equal(lever.last_input_at_ms, 5000);
    });

    it("SnapLever 도 자기 쪽 절반 안으로 자른다", () => {
        const lever = LeverAt(0, 0, -300);
        airhockeyRules.SnapLever(lever, { x: 0, y: 400 }, 0);
        assert.equal(lever.y, -LEVER_R);
    });

    it("퍽 위에 바로 놓여도 퍽을 치지 않고 겹친 만큼만 밀어낸다 (끌고 왔다면 세게 쳤을 거리)", () => {
        const puck = Puck(0, 0);
        const lever = LeverAt(0, 0, -500);
        airhockeyRules.SnapLever(lever, { x: 0, y: -LEVER_R }, 0);
        airhockeyRules.StepWorld(puck, [lever, LeverAt(1, 0, 500)], DT);
        assert.ok(Math.hypot(puck.vx, puck.vy) < 1, `퍽 속도 ${Math.hypot(puck.vx, puck.vy).toFixed(1)}`);
        assert.ok(Math.hypot(puck.x - lever.x, puck.y - lever.y) >= PUCK_R + LEVER_R - 0.01, "겹침이 풀렸다");
    });
});

describe("UpdateStuckWatch — 퍽이 오래 제자리면 이번 판 다시 시작", () => {
    const RESET_TICKS = Math.round(airhockeyConstants.AIRHOCKEY_STUCK_RESET_SEC / DT);

    it("멈춘 퍽은 정확히 제한 시간이 됐을 때 처음 true", () => {
        const puck = Puck(0, 0);
        const watch = airhockeyRules.CreateStuckWatch(puck);
        let first_true = -1;
        for (let i = 1; i <= RESET_TICKS + 5 && first_true === -1; i += 1) {
            if (airhockeyRules.UpdateStuckWatch(watch, puck, DT)) first_true = i;
        }
        assert.ok(Math.abs(first_true - RESET_TICKS) <= 1, `${first_true}틱 (기대 ${RESET_TICKS})`);
    });

    it("반경 안에서 떨리기만 하는 퍽도 제자리로 본다", () => {
        const puck = Puck(100, 100);
        const watch = airhockeyRules.CreateStuckWatch(puck);
        let reset = false;
        for (let i = 0; i <= RESET_TICKS && !reset; i += 1) {
            puck.x = 100 + (i % 2 === 0 ? 10 : -10);
            reset = airhockeyRules.UpdateStuckWatch(watch, puck, DT);
        }
        assert.equal(reset, true);
    });

    it("반경 밖으로 움직이면 시간이 0 으로 돌아간다 — 움직이는 퍽은 다시 시작하지 않는다", () => {
        const puck = Puck(0, 0);
        const watch = airhockeyRules.CreateStuckWatch(puck);
        for (let i = 0; i < RESET_TICKS - 10; i += 1) airhockeyRules.UpdateStuckWatch(watch, puck, DT);
        puck.y = airhockeyConstants.AIRHOCKEY_STUCK_RADIUS + 1;
        assert.equal(airhockeyRules.UpdateStuckWatch(watch, puck, DT), false);
        assert.equal(watch.still_sec, 0);
        for (let i = 0; i < RESET_TICKS - 10; i += 1) {
            assert.equal(airhockeyRules.UpdateStuckWatch(watch, puck, DT), false);
        }
    });

    it("두 레버가 중앙선에서 퍽을 옆벽에 끼우면(신고된 화면) 물리로는 못 빠져나오고, 제한 시간에 다시 시작된다", () => {
        // 양쪽이 중앙선 끝까지 올라와 오른쪽 벽의 퍽을 위아래에서 누른다
        const puck = Puck(HALF_W - PUCK_R, 0);
        const lever0 = LeverAt(0, HALF_W - LEVER_R, -LEVER_R - 5);
        const lever1 = LeverAt(1, HALF_W - LEVER_R, LEVER_R + 5);
        const watch = airhockeyRules.CreateStuckWatch(puck);
        let reset_tick = -1;
        for (let i = 1; i <= RESET_TICKS + 5 && reset_tick === -1; i += 1) {
            airhockeyRules.SetLeverTarget(lever0, { x: HALF_W, y: 0 });
            airhockeyRules.SetLeverTarget(lever1, { x: HALF_W, y: 0 });
            const result = airhockeyRules.StepWorld(puck, [lever0, lever1], DT);
            assert.equal(result.goal, null);
            if (airhockeyRules.UpdateStuckWatch(watch, puck, DT)) reset_tick = i;
        }
        assert.ok(reset_tick !== -1, `퍽이 빠져나감 (${puck.x.toFixed(0)}, ${puck.y.toFixed(0)})`);
        assert.ok(Math.abs(reset_tick - RESET_TICKS) <= 1, `${reset_tick}틱`);
    });
});

describe("DecideWinner / IsWinningGoals / ComputeRankScore", () => {
    it("골이 많은 쪽이 이기고, 같으면 무승부(null)", () => {
        assert.equal(airhockeyRules.DecideWinner(3, 1), 0);
        assert.equal(airhockeyRules.DecideWinner(2, 3), 1);
        assert.equal(airhockeyRules.DecideWinner(1, 1), null);
    });

    it("3골이면 승리", () => {
        assert.equal(airhockeyRules.IsWinningGoals(2), false);
        assert.equal(airhockeyRules.IsWinningGoals(3), true);
    });

    it("랭킹 점수 = 골 수 × 5 (패자도 자기 골만큼 받는다)", () => {
        assert.equal(airhockeyRules.ComputeRankScore(3), 15);
        assert.equal(airhockeyRules.ComputeRankScore(1), 5);
        assert.equal(airhockeyRules.ComputeRankScore(0), 0);
    });
});
