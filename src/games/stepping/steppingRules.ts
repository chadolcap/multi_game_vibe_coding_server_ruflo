// 점핑(stepping)의 순수 규칙 — MOVE_INFO 검증/반영, 게임 점수, 종료 판정, 승패 판정 (2026-10-14 추가).
// 규칙 출처: 시트 stepping + 사용자 결정(2026-10-14):
//   · 라이프 3개. 추락하면 라이프 1개를 쓰고 앞 블록 중앙(0,0)에서 다시 시작한다(재시작 연출은 클라이언트)
//   · 종료: 라이프를 다 쓴 뒤 한 명이 또 추락 / 제한 시간(60초) 경과 / 양쪽 모두 모든 칸 이동 완료
//   · 승패: 남은 라이프×10 + 이동 칸 수×5 가 높은 쪽. 같으면 먼저 도착한 쪽
//   · 여러 칸을 한 번에 건너뛰는 아이템은 없다 → count 는 반드시 1씩 오른다
//
// SteppingGameRoom 에서 분리해 둔 이유는 othelloRules.ts 와 같다 — DB 모듈 없이 단위 테스트로 검증하기 위해서다.

import * as steppingConstants from "./steppingConstants.js";
import type { SteppingMoveInfoPayload, SteppingPlayerState } from "./steppingTypes.js";

export function CreatePlayerState(): SteppingPlayerState {
    return {
        count: 0,
        life: steppingConstants.STEPPING_LIFE_COUNT,
        location: { x: 0, y: 0 },
        reached_at: null,
        last_move_at: null,
        eliminated: false,
        completed: false,
    };
}

// 맵 번호가 유효한지 (1~STEPPING_MAP_COUNT)
export function IsValidMap(map: number): boolean {
    return Number.isInteger(map) && map >= 1 && map <= steppingConstants.STEPPING_MAP_COUNT;
}

// 1~STEPPING_MAP_COUNT 중 하나. random 은 테스트에서 고정값을 넣을 수 있게 받는다.
export function PickRandomMap(random: () => number = Math.random): number {
    return 1 + Math.floor(random() * steppingConstants.STEPPING_MAP_COUNT);
}

export function GetMapBlockCount(map: number): number {
    return steppingConstants.STEPPING_MAP_BLOCK_COUNTS[map] ?? 0;
}

// 게임 점수 = 남은 라이프 × 10 + 이동한 칸 수 × 5 (사용자 결정 2026-10-14)
export function ComputeScore(state: SteppingPlayerState): number {
    return state.life * steppingConstants.STEPPING_SCORE_PER_LIFE + state.count * steppingConstants.STEPPING_SCORE_PER_BLOCK;
}

// 더 이상 MOVE_INFO 를 받지 않는 상태인지 (탈락했거나 모든 칸을 다 갔다)
export function IsPlayerFinished(state: SteppingPlayerState): boolean {
    return state.eliminated || state.completed;
}

export type MoveRejectReason = "FINISHED" | "BAD_FORMAT" | "OUT_OF_ORDER" | "OVER_MAP" | "TOO_FAST";

// MOVE_INFO 를 받아들일 수 있는지 검사한다. 받아들일 수 있으면 null, 아니면 무시할 이유.
//   · count 는 **직전 count + 1** 이어야 한다 — 같은 값(재전송)·건너뛰기·되돌리기는 모두 무시한다.
//     추락 후 다시 뛸 때도 같은 칸을 다시 노리므로 count 는 그대로 "직전 + 1" 이다.
//   · count 가 맵의 칸 수를 넘으면 무시한다.
//   · 직전 MOVE_INFO 로부터 STEPPING_MIN_MOVE_INTERVAL_MS 안에 오면 무시한다(매크로 방지).
export function ValidateMove(
    state: SteppingPlayerState,
    message: unknown,
    block_count: number,
    now_ms: number
): MoveRejectReason | null {
    if (IsPlayerFinished(state)) return "FINISHED";
    if (!IsMoveInfoShape(message)) return "BAD_FORMAT";
    if (message.count !== state.count + 1) return "OUT_OF_ORDER";
    if (message.count > block_count) return "OVER_MAP";
    if (state.last_move_at !== null && now_ms - state.last_move_at < steppingConstants.STEPPING_MIN_MOVE_INTERVAL_MS) {
        return "TOO_FAST";
    }
    return null;
}

// 검사를 통과한 MOVE_INFO 를 상태에 반영한다 (ValidateMove 가 null 을 돌려준 뒤에만 부른다).
//   save:"yes" → 칸 수 증가, 도착 시각 기록. 마지막 칸이면 completed
//   save:"no"  → 라이프가 남아 있으면 1개 쓰고(칸 수는 그대로 — 앞 블록에서 다시 시작),
//                라이프가 0 이면 eliminated (게임 종료 사유)
export function ApplyMove(
    state: SteppingPlayerState,
    message: SteppingMoveInfoPayload,
    block_count: number,
    now_ms: number
): void {
    state.last_move_at = now_ms;

    if (message.save === "yes") {
        state.count = message.count;
        state.location = { x: message.location.x, y: message.location.y };
        state.reached_at = now_ms;
        if (state.count >= block_count) state.completed = true;
        return;
    }

    if (state.life > 0) {
        state.life -= 1;
        // 앞 블록 중앙(0,0)에서 다시 시작한다 (사용자 결정 2026-10-14)
        state.location = { x: 0, y: 0 };
    } else {
        state.eliminated = true;
    }
}

// 게임 종료 조건 중 "상태로 판정되는 것" — 한 명이라도 탈락했거나, 양쪽 모두 모든 칸을 다 갔다.
// (제한 시간 경과는 타이머가, 둘 다 나간 경우는 Room 이 따로 판정한다)
export function IsGameOverByState(states: SteppingPlayerState[]): boolean {
    if (states.some((state) => state.eliminated)) return true;
    return states.length > 0 && states.every((state) => state.completed);
}

// 승패 판정. 1 = a 승리, -1 = b 승리, 0 = 무승부.
//   ① 게임 점수가 높은 쪽
//   ② 같으면 **먼저 도착한 쪽**(reached_at 이 이른 쪽, 사용자 결정 2026-10-14). 한 칸도 못 간
//      쪽(reached_at=null)은 도착한 적이 없으므로 진다
//   ③ 그래도 같으면(둘 다 한 칸도 못 감 또는 도착 시각이 완전히 같음) 무승부
export function DecideWinner(a: SteppingPlayerState, b: SteppingPlayerState): 1 | -1 | 0 {
    const score_a = ComputeScore(a);
    const score_b = ComputeScore(b);
    if (score_a !== score_b) return score_a > score_b ? 1 : -1;

    if (a.reached_at === b.reached_at) return 0;
    if (a.reached_at === null) return -1;
    if (b.reached_at === null) return 1;
    return a.reached_at < b.reached_at ? 1 : -1;
}

function IsFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function IsMoveInfoShape(message: unknown): message is SteppingMoveInfoPayload {
    if (typeof message !== "object" || message === null) return false;
    const m = message as Record<string, unknown>;
    if (!Number.isInteger(m.count)) return false;
    if (m.save !== "yes" && m.save !== "no") return false;
    const location = m.location as Record<string, unknown> | undefined;
    if (typeof location !== "object" || location === null) return false;
    return IsFiniteNumber(location.x) && IsFiniteNumber(location.y);
}
