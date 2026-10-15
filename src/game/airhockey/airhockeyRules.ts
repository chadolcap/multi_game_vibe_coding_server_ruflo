// 에어하키 규칙/물리 — 순수 함수 모음 (2026-10-15 추가). Room 상태를 모르고, 받은 값만으로 계산한다
// (airhockeyRules.test.ts 로 단위 테스트한다).
//
// 서버 내부는 **절대 좌표**를 쓴다: 원점이 테이블 정중앙, player1(side 0)이 아래, player2(side 1)가 위.
// 클라이언트와 주고받는 좌표는 ToSideFrame() 으로 "그 유저 기준"(내가 아래)으로 바꾼다.
//
// 물리 모델(단순화):
//   - 테이블은 직사각형이고 위아래 벽 가운데에 골대 입구가 있다(영상의 꺾인 옆벽은 연출, 사용자 결정).
//   - 레버는 질량이 무한대인 원이다 — 퍽만 튕기고 레버는 밀리지 않는다.
//   - 레버는 요청 좌표(target)를 최대 속도로 따라가고, 실제로 움직인 속도가 퍽을 치는 힘이 된다.

import * as airhockeyConstants from "./airhockeyConstants.js";
import type {
    AirhockeyLeverState,
    AirhockeyPoint,
    AirhockeyPuckState,
    AirhockeySide,
    AirhockeyStepResult,
    AirhockeyStuckWatch,
} from "./airhockeyTypes.js";

const HALF_WIDTH = airhockeyConstants.AIRHOCKEY_TABLE_WIDTH / 2;
const HALF_HEIGHT = airhockeyConstants.AIRHOCKEY_TABLE_HEIGHT / 2;
const GOAL_HALF_WIDTH = airhockeyConstants.AIRHOCKEY_GOAL_WIDTH / 2;
const PUCK_R = airhockeyConstants.AIRHOCKEY_PUCK_RADIUS;
const LEVER_R = airhockeyConstants.AIRHOCKEY_LEVER_RADIUS;

// --- 좌표 변환 ---

// 절대 좌표 ↔ side 기준 좌표. side 1(위쪽 유저)은 화면을 180도 돌려 보므로 (x,y) → (-x,-y) 다.
// 같은 변환을 두 번 하면 원래대로 돌아오므로 받을 때/보낼 때 같은 함수를 쓴다.
export function ToSideFrame(point: AirhockeyPoint, side: AirhockeySide): AirhockeyPoint {
    // -0 이 와이어에 그대로 나가지 않게 0 을 더한다
    return side === 0 ? { x: point.x, y: point.y } : { x: -point.x + 0, y: -point.y + 0 };
}

// 와이어로 보낼 좌표 — 정수로 반올림한다(테이블 폭 720 단위라 소수점은 화면에 의미가 없다).
export function RoundPoint(point: AirhockeyPoint): AirhockeyPoint {
    return { x: Math.round(point.x) + 0, y: Math.round(point.y) + 0 };
}

// LEVER_MOVE 의 loc 이 숫자 좌표인지 — 형식이 틀리면 메시지를 무시한다.
export function IsValidPoint(value: unknown): value is AirhockeyPoint {
    if (typeof value !== "object" || value === null) return false;
    const { x, y } = value as { x?: unknown; y?: unknown };
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
}

// 레버가 갈 수 있는 영역으로 자른다(절대 좌표): 테이블 안 + **자기 쪽 절반**(중앙선을 넘지 못한다).
export function ClampLeverPosition(side: AirhockeySide, point: AirhockeyPoint): AirhockeyPoint {
    const x = Clamp(point.x, -HALF_WIDTH + LEVER_R, HALF_WIDTH - LEVER_R);
    const y =
        side === 0
            ? Clamp(point.y, -HALF_HEIGHT + LEVER_R, -LEVER_R)
            : Clamp(point.y, LEVER_R, HALF_HEIGHT - LEVER_R);
    return { x, y };
}

// --- 상태 생성 ---

// 퍽은 중앙선 한가운데에서 멈춘 채로 시작한다 — 먼저 친 유저가 선공(시트).
export function CreatePuck(): AirhockeyPuckState {
    return { x: 0, y: 0, vx: 0, vy: 0 };
}

// 레버의 처음 자리 = 자기 골대 앞 수비 위치.
export function GetLeverHome(side: AirhockeySide): AirhockeyPoint {
    const y = -HALF_HEIGHT + airhockeyConstants.AIRHOCKEY_BOT_HOME_OFFSET;
    return side === 0 ? { x: 0, y } : { x: 0, y: -y };
}

export function CreateLever(side: AirhockeySide): AirhockeyLeverState {
    const home = GetLeverHome(side);
    return {
        side,
        x: home.x,
        y: home.y,
        target_x: home.x,
        target_y: home.y,
        vx: 0,
        vy: 0,
        follow_speed: airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED,
        last_input_at_ms: null,
        input_interval_sec: airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_SEC,
    };
}

// 클라이언트(또는 봇)가 요청한 위치를 레버의 목표로 정한다. 자기 쪽 절반 밖이면 잘라서 받는다.
//
// now_ms 를 주면(클라이언트 LEVER_MOVE) 입력 간격을 재서, 레버가 **다음 입력이 올 때쯤 목표에 도착하는
// 일정한 속도**로 움직이게 한다 — 서버 레버 속도 = 실제 손 속도. 손 600/초, 30Hz 입력이면 매 틱 600/초다.
// now_ms 가 없으면(봇, 테스트) 최대 속도로 바로 따라간다 — 봇은 매 틱 한 틱 거리만큼만 목표를 준다.
export function SetLeverTarget(lever: AirhockeyLeverState, point: AirhockeyPoint, now_ms?: number): void {
    const clamped = ClampLeverPosition(lever.side, point);
    lever.target_x = clamped.x;
    lever.target_y = clamped.y;

    if (now_ms === undefined) {
        lever.follow_speed = airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED;
        lever.last_input_at_ms = null;
        return;
    }

    if (lever.last_input_at_ms !== null) {
        const measured = Clamp(
            (now_ms - lever.last_input_at_ms) / 1000,
            airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_MIN_SEC,
            airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_MAX_SEC
        );
        const alpha = airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_SMOOTHING;
        lever.input_interval_sec = lever.input_interval_sec * (1 - alpha) + measured * alpha;
    }
    lever.last_input_at_ms = now_ms;

    // 지금 위치에서 새 목표까지의 거리를 입력 간격 동안 가는 속도. 밀려 있던 거리도 같이 따라잡는다.
    const distance = Math.hypot(lever.target_x - lever.x, lever.target_y - lever.y);
    lever.follow_speed = Math.min(distance / lever.input_interval_sec, airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED);
}

// 판 시작(ONE_START) 때 레버의 이전 궤적을 지운다 — 지금 자리에 멈춰 세우고, 입력 간격 기록도 처음으로 되돌린다.
// 다음 판의 첫 LEVER_MOVE 는 SnapLever 로 그 자리에 바로 놓는다(사용자 결정 2026-10-15).
export function ResetLeverMotion(lever: AirhockeyLeverState): void {
    lever.target_x = lever.x;
    lever.target_y = lever.y;
    lever.vx = 0;
    lever.vy = 0;
    lever.follow_speed = airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED;
    lever.last_input_at_ms = null;
    lever.input_interval_sec = airhockeyConstants.AIRHOCKEY_LEVER_INPUT_INTERVAL_SEC;
}

// 판의 첫 LEVER_MOVE — 이전 자리에서 끌고 오지 않고 받은 좌표에 바로 놓는다(속도 0). 자기 쪽 절반 밖이면 잘라서 받는다.
// 속도가 0 이라 퍽 위에 놓여도 퍽을 치지 않고 겹친 만큼만 밀어낸다. now_ms 는 다음 입력의 간격을 재는 기준이다.
export function SnapLever(lever: AirhockeyLeverState, point: AirhockeyPoint, now_ms: number): void {
    const clamped = ClampLeverPosition(lever.side, point);
    lever.x = clamped.x;
    lever.y = clamped.y;
    ResetLeverMotion(lever);
    lever.last_input_at_ms = now_ms;
}

// --- 물리 한 틱 ---

// dt_sec 만큼 세상을 진행한다. 퍽과 레버를 제자리에서 바꾸고, 골이 들어가면 넣은 쪽을 돌려준다.
// 골이 들어간 순간 계산을 멈춘다(퍽은 골대 안 위치에 남는다 — 다음 판에서 CreatePuck 으로 되돌린다).
export function StepWorld(
    puck: AirhockeyPuckState,
    levers: readonly AirhockeyLeverState[],
    dt_sec: number,
    substeps = airhockeyConstants.AIRHOCKEY_SUBSTEPS
): AirhockeyStepResult {
    // 레버가 이번 틱에 갈 거리(따라가는 속도로 자른 값)를 먼저 정하고, 서브스텝마다 나눠서 움직인다.
    const lever_steps = levers.map((lever) => {
        const move = ComputeLeverMove(lever, dt_sec);
        lever.vx = move.x / dt_sec;
        lever.vy = move.y / dt_sec;
        return { x: move.x / substeps, y: move.y / substeps };
    });

    const sub_dt = dt_sec / substeps;
    for (let step = 0; step < substeps; step++) {
        levers.forEach((lever, index) => {
            lever.x += lever_steps[index].x;
            lever.y += lever_steps[index].y;
        });

        puck.x += puck.vx * sub_dt;
        puck.y += puck.vy * sub_dt;

        for (const lever of levers) {
            CollidePuckWithLever(puck, lever);
        }
        const goal = CollidePuckWithWalls(puck);
        if (goal !== null) {
            puck.vx = 0;
            puck.vy = 0;
            return { goal };
        }
    }

    ApplyFriction(puck, dt_sec);
    return { goal: null };
}

// 이번 틱에 레버가 갈 거리 — target 쪽으로 follow_speed(최대 속도 이하)만큼.
function ComputeLeverMove(lever: AirhockeyLeverState, dt_sec: number): AirhockeyPoint {
    const speed = Math.min(lever.follow_speed, airhockeyConstants.AIRHOCKEY_LEVER_MAX_SPEED);
    return ClampLength(lever.target_x - lever.x, lever.target_y - lever.y, speed * dt_sec);
}

// 퍽 없이 레버만 목표 쪽으로 움직인다 — 판 사이(골 연출 중)에 쓴다. 속도 제한은 StepWorld 와 같다.
export function MoveLeversOnly(levers: readonly AirhockeyLeverState[], dt_sec: number): void {
    for (const lever of levers) {
        const move = ComputeLeverMove(lever, dt_sec);
        lever.x += move.x;
        lever.y += move.y;
        lever.vx = move.x / dt_sec;
        lever.vy = move.y / dt_sec;
    }
}

// --- 퍽 정체 감시 ---

// 판을 시작할 때(퍽이 중앙에 놓일 때) 새로 만든다.
export function CreateStuckWatch(puck: AirhockeyPuckState): AirhockeyStuckWatch {
    return { anchor_x: puck.x, anchor_y: puck.y, still_sec: 0 };
}

// 매 틱 부른다. 퍽이 anchor 에서 AIRHOCKEY_STUCK_RADIUS 밖으로 나가면 그 자리를 새 anchor 로 삼고 시간을 0 으로 되돌린다.
// 반경 안에 AIRHOCKEY_STUCK_RESET_SEC 이상 머물면 true(이번 판을 다시 시작해야 함)를 돌려준다.
export function UpdateStuckWatch(watch: AirhockeyStuckWatch, puck: AirhockeyPuckState, dt_sec: number): boolean {
    const dx = puck.x - watch.anchor_x;
    const dy = puck.y - watch.anchor_y;
    if (dx * dx + dy * dy > airhockeyConstants.AIRHOCKEY_STUCK_RADIUS * airhockeyConstants.AIRHOCKEY_STUCK_RADIUS) {
        watch.anchor_x = puck.x;
        watch.anchor_y = puck.y;
        watch.still_sec = 0;
        return false;
    }
    watch.still_sec += dt_sec;
    return watch.still_sec >= airhockeyConstants.AIRHOCKEY_STUCK_RESET_SEC;
}

export function IsPuckMoving(puck: AirhockeyPuckState): boolean {
    return puck.vx !== 0 || puck.vy !== 0;
}

// 퍽과 레버가 겹치면 퍽을 레버 바깥으로 밀어내고, 서로 다가가던 중이면 튕긴다.
// 유한 질량 충돌식(퍽 질량 1, 레버 M): 퍽이 받는 법선 방향 속도 변화 = -(1 + e) × M/(M+1) × 상대 속도.
// 레버는 손이 잡고 있어 충돌로 느려지지 않는다. 멈춘 퍽을 V 로 치면 약 1.3V 로 나간다(세게 칠수록 세게).
// 충돌 뒤 퍽의 법선 속도는 항상 레버의 법선 속도보다 크다((1+e)M/(M+1) > 1) — 레버에 달라붙지 않는다.
export function CollidePuckWithLever(puck: AirhockeyPuckState, lever: AirhockeyLeverState): boolean {
    const min_dist = PUCK_R + LEVER_R;
    let dx = puck.x - lever.x;
    let dy = puck.y - lever.y;
    let dist = Math.hypot(dx, dy);
    if (dist >= min_dist) return false;

    if (dist === 0) {
        // 정확히 겹쳤다 — 방향이 없으니 그 레버의 상대 골대 쪽으로 밀어낸다
        dx = 0;
        dy = lever.side === 0 ? 1 : -1;
        dist = 1;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    puck.x = lever.x + nx * min_dist;
    puck.y = lever.y + ny * min_dist;

    const rel = (puck.vx - lever.vx) * nx + (puck.vy - lever.vy) * ny;
    if (rel < 0) {
        const mass_ratio = airhockeyConstants.AIRHOCKEY_LEVER_MASS_RATIO;
        const impulse = (1 + airhockeyConstants.AIRHOCKEY_LEVER_RESTITUTION) * (mass_ratio / (mass_ratio + 1)) * rel;
        puck.vx -= impulse * nx;
        puck.vy -= impulse * ny;
        CapPuckSpeed(puck);
    }
    return true;
}

// 옆벽/끝벽에 튕긴다. 골대 입구로는 그대로 들어가고, 퍽 전체가 골 라인을 넘으면 골이다.
// 돌려주는 값은 **골을 넣은 쪽**(아래 골대에 들어가면 위쪽 유저 side 1 의 골).
export function CollidePuckWithWalls(puck: AirhockeyPuckState): AirhockeySide | null {
    const e = airhockeyConstants.AIRHOCKEY_WALL_RESTITUTION;

    if (puck.x - PUCK_R < -HALF_WIDTH) {
        puck.x = -HALF_WIDTH + PUCK_R;
        puck.vx = Math.abs(puck.vx) * e;
    } else if (puck.x + PUCK_R > HALF_WIDTH) {
        puck.x = HALF_WIDTH - PUCK_R;
        puck.vx = -Math.abs(puck.vx) * e;
    }

    const mouth_limit = GOAL_HALF_WIDTH - PUCK_R; // 퍽 중심이 이 안쪽이어야 골대 입구를 통과한다

    if (puck.y < -HALF_HEIGHT) {
        // 퍽 중심이 이미 아래 골대 안쪽 — 골대 옆기둥에 막히고, 끝까지 들어가면 골
        puck.x = Clamp(puck.x, -mouth_limit, mouth_limit);
        if (puck.y + PUCK_R < -HALF_HEIGHT) return 1;
    } else if (puck.y - PUCK_R < -HALF_HEIGHT && Math.abs(puck.x) > mouth_limit) {
        puck.y = -HALF_HEIGHT + PUCK_R;
        puck.vy = Math.abs(puck.vy) * e;
    }

    if (puck.y > HALF_HEIGHT) {
        puck.x = Clamp(puck.x, -mouth_limit, mouth_limit);
        if (puck.y - PUCK_R > HALF_HEIGHT) return 0;
    } else if (puck.y + PUCK_R > HALF_HEIGHT && Math.abs(puck.x) > mouth_limit) {
        puck.y = HALF_HEIGHT - PUCK_R;
        puck.vy = -Math.abs(puck.vy) * e;
    }

    return null;
}

function ApplyFriction(puck: AirhockeyPuckState, dt_sec: number): void {
    const keep = Math.pow(1 - airhockeyConstants.AIRHOCKEY_PUCK_FRICTION_PER_SEC, dt_sec);
    puck.vx *= keep;
    puck.vy *= keep;
    if (Math.hypot(puck.vx, puck.vy) < airhockeyConstants.AIRHOCKEY_PUCK_MIN_SPEED) {
        puck.vx = 0;
        puck.vy = 0;
    }
}

function CapPuckSpeed(puck: AirhockeyPuckState): void {
    const capped = ClampLength(puck.vx, puck.vy, airhockeyConstants.AIRHOCKEY_PUCK_MAX_SPEED);
    puck.vx = capped.x;
    puck.vy = capped.y;
}

// --- 봇 ---

// 끊기거나 나간 유저의 레버를 대신 움직일 다음 목표 위치(절대 좌표)를 정한다. 한 틱에 BOT_SPEED 만큼만 간다.
// 전략은 단순하다: 퍽이 내 쪽에 있으면 퍽을 향해 달려가 쳐 내고, 상대 쪽에 있으면 골대 앞으로 돌아가 막는다.
// 퍽이 레버보다 내 골대 쪽에 있으면(뒤로 돌아갔으면) 그대로 치면 자책골이라 옆으로 돌아서 퍽 뒤로 간다.
// random 은 테스트에서 고정값을 넣으려고 받는다(AIRHOCKEY_BOT_AIM_JITTER 참고).
export function ComputeBotTarget(
    lever: AirhockeyLeverState,
    puck: AirhockeyPuckState,
    dt_sec: number,
    random: () => number = Math.random
): AirhockeyPoint {
    // 봇 판단은 "내가 아래" 기준으로 한다 — side 1 이면 뒤집어서 계산하고 다시 뒤집는다
    const me = ToSideFrame({ x: lever.x, y: lever.y }, lever.side);
    const ball = ToSideFrame({ x: puck.x, y: puck.y }, lever.side);
    const home = ToSideFrame(GetLeverHome(lever.side), lever.side);

    const to_ball_x = ball.x - me.x;
    const to_ball_y = ball.y - me.y;
    const to_ball_dist = Math.hypot(to_ball_x, to_ball_y);
    // 충돌하면 퍽이 정확히 반지름 합 거리로 밀려나므로 그 근처만 "붙어 있다"로 본다. 여유를 크게 잡으면
    // 다가가는 도중(한 틱 15)에 미리 물러나서 멈춘 퍽을 영영 못 친다.
    const touching = to_ball_dist < PUCK_R + LEVER_R + 1;
    const ball_slow = Math.hypot(puck.vx, puck.vy) < airhockeyConstants.AIRHOCKEY_BOT_RETREAT_PUCK_SPEED;

    let desired: AirhockeyPoint;
    if (ball.y > 0) {
        // 퍽이 상대 쪽 — 골대 앞에서 퍽의 x 를 절반만 따라가며 기다린다
        desired = { x: ball.x * 0.5, y: home.y };
    } else if (touching && ball_slow && to_ball_dist > 0) {
        // 느린 퍽에 붙어 있다 — 퍽 반대쪽으로 물러난다. 다음 틱부터 다시 달려들어 "치고 빠진다"
        // (구석에 갇힌 퍽을 누르고만 있으면 영원히 못 빼낸다 — AIRHOCKEY_BOT_RETREAT_DISTANCE 주석)
        const back = airhockeyConstants.AIRHOCKEY_BOT_RETREAT_DISTANCE / to_ball_dist;
        desired = { x: me.x - to_ball_x * back, y: me.y - to_ball_y * back };
    } else if (ball.y < me.y - PUCK_R) {
        // 퍽이 내 뒤(내 골대 쪽) — 퍽을 옆으로 비켜서 그 아래로 돌아간다
        const side_offset = ball.x >= 0 ? -(PUCK_R + LEVER_R) : PUCK_R + LEVER_R;
        desired = { x: ball.x + side_offset, y: ball.y - LEVER_R };
    } else {
        // 퍽이 내 앞 — 퍽 중심을 향해 달려들어 위로 쳐 낸다 (x 를 살짝 흔들어 봇끼리의 대칭 교착을 깬다)
        const jitter = (random() - 0.5) * 2 * airhockeyConstants.AIRHOCKEY_BOT_AIM_JITTER;
        desired = { x: ball.x + jitter, y: ball.y };
    }

    const move = ClampLength(desired.x - me.x, desired.y - me.y, airhockeyConstants.AIRHOCKEY_BOT_SPEED * dt_sec);
    const next_local = { x: me.x + move.x, y: me.y + move.y };
    return ClampLeverPosition(lever.side, ToSideFrame(next_local, lever.side));
}

// --- 승패 / 점수 ---

// 골 수로 승자를 정한다. 같으면 null(무승부 — 둘 다 나가서 중간에 끝났을 때만 생긴다).
export function DecideWinner(goals0: number, goals1: number): AirhockeySide | null {
    if (goals0 === goals1) return null;
    return goals0 > goals1 ? 0 : 1;
}

export function IsWinningGoals(goals: number): boolean {
    return goals >= airhockeyConstants.AIRHOCKEY_WIN_GOALS;
}

// 랭킹 점수 = 넣은 골 수 × 5 (승패와 상관없이, 사용자 결정 2026-10-15)
export function ComputeRankScore(goals: number): number {
    return goals * airhockeyConstants.AIRHOCKEY_SCORE_PER_GOAL;
}

// --- 내부 헬퍼 ---

function Clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// 벡터 (x, y) 의 길이를 max 이하로 줄인다
function ClampLength(x: number, y: number, max: number): AirhockeyPoint {
    const length = Math.hypot(x, y);
    if (length <= max || length === 0) return { x, y };
    const scale = max / length;
    return { x: x * scale, y: y * scale };
}
