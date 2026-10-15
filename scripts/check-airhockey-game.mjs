// 에어하키(airhockey) e2e 검증 스크립트 (2026-10-15).
//
// 검증 대상:
//   1) 로비 매칭 — JOIN_MATCH{game:"airhockey"} → MATCH_FOUND{room_name:"airhockey_1"}
//   2) 시작 — READY → GAME_START → 약 3초 뒤 ONE_START → 중앙(0,0) PUCK_MOVE 한 번, 멈춘 퍽은 반복 전송 안 함
//   2-1) 정체 — 아무도 안 쳐서 퍽이 10초간 제자리면 골 없이 ONE_START 가 다시 오고 퍽이 중앙에서 다시 시작
//   3) 좌표 — LEVER_MOVE 는 상대에게만, **받는 유저 기준**(180도 회전)으로 중계되고, 중앙선을 넘으면 잘린다
//   4) 골 — 레버로 퍽을 쳐서 위 골대에 넣으면 ONE_RESULT{win, win_count}. 두 화면의 퍽 궤적·vel 이 서로 반대,
//      골이 나면 vel (0,0) 으로 멈춤을 알린다
//   5) 재접속 — 골 연출 중 끊김(drop) → 재접속 + ENTER_ROOM → GAME_STATUS(점수, 퍽, LEVER0/1, 내 기준 좌표)
//   6) 진행 — 반대쪽 골, 3골 먼저 → 약 3초 뒤 GAME_RESULT(win_count=골, score=골×5)
//   7) 재게임 + 퇴장 — B 가 나가면 봇이 B 레버를 움직여 골을 넣고, 결과는 B 승리로 반영 → 그 직후 OUT_USER
//      → A 가 재게임/나가기를 안 고르면 10초 뒤 RETURN_TO_LOBBY
//   8) DB — airhockey_game_log 2행(vs, score, plays, win_is_bot), play_info(score 누적), rank_daily
//
// ⚠️ 이 스크립트는 지우지 말 것 (CLAUDE.md 10장).
// ⚠️ **DB 에 테스트 유저 2명을 만든다.** 끝나고 자기 행만 지운다(TEST_PARTNER 접두사). KEEP=1 이면 정리 생략.
//
// 사용법 (로비와 에어하키 채널이 떠 있어야 한다, 약 50초 걸린다 — 출력을 | head 로 자르지 말 것):
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> AIRHOCKEY_PORT=6051 node scripts/check-airhockey-game.mjs > out.txt
// MODE=invalid — 위 흐름 대신 "양쪽 방치 → 정체 재시작 3번 → 4번째 정체에서 즉시 GAME_RESULT{draw:"Y"} → 재게임 선택,
//   기록 없음"만 확인한다(약 65초).

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const lobby_room_id = process.env.LOBBY_ROOM_ID ?? "";
const lobby_channel_no = Number(process.env.LOBBY_CHANNEL_NO ?? 1);
const airhockey_port = Number(process.env.AIRHOCKEY_PORT ?? 6051);
const keep_rows = process.env.KEEP === "1";
const mode = process.env.MODE ?? "";

// 기존 유저와 겹치지 않는 접두사. 정리할 때 이 값으로만 지운다.
const TEST_PARTNER = "zzair";
const run_tag = String(Date.now()).slice(-8);

// 서버 상수와 같은 값 (airhockeyConstants.ts)
const GAME_START_DELAY_SEC = 3;
const ONE_RESULT_DELAY_SEC = 3;
const RESULT_DELAY_SEC = 3;
const REMATCH_CHOICE_TIMEOUT_SEC = 10;
const STUCK_RESET_SEC = 10;
const STUCK_MAX_RESTARTS = 3;
const HALF_HEIGHT = 640;
const LEVER_RADIUS = 60;

const checker = client.CreateChecker();
const Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// common/userid.ts 의 ConvertMidToUserid 와 같은 규칙 (XOR key 5)
function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}

// 연결이 받은 S→C 메시지를 전부 시간과 함께 log 에 쌓는다. 나중에 순서/개수로 단정한다.
function Record(conn, log = []) {
    conn.OnMessage((decoded) => log.push({ type: decoded.type, payload: client.TakePayload(decoded), at: Date.now() }));
    return log;
}

// log 에 type 메시지가 from_index 이후로 생길 때까지 기다린다. 그 메시지의 index 를 돌려준다(없으면 -1).
async function WaitInLog(log, type, timeout_ms, from_index = 0, filter = () => true) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const index = log.findIndex((entry, i) => i >= from_index && entry.type === type && filter(entry.payload));
        if (index !== -1) return index;
        await Sleep(20);
    }
    return -1;
}

function LastOf(log, type, filter = () => true, from_index = 0) {
    for (let i = log.length - 1; i >= from_index; i--) {
        if (log[i].type === type && filter(log[i].payload)) return log[i].payload;
    }
    return undefined;
}

function LeverTo(conn, x, y) {
    conn.Send("LEVER_MOVE", { payload: { loc: { x, y } } });
}

async function JoinLobbyAndMatch(mid) {
    const reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: `lobby_${lobby_channel_no}`, room_id: lobby_room_id });
    const conn = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!conn.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(conn)}`);

    const entered = client.WaitForMessage(conn, "ENTER_LOBBY", 6000);
    conn.Send("ENTER_LOBBY", { payload: { partner: TEST_PARTNER, mid, gender: "M", phone: "01000000000" } });
    const enter_result = await entered;
    if (enter_result?.result !== "Y") throw new Error(`ENTER_LOBBY 실패: ${JSON.stringify(enter_result)}`);

    const match_wait = client.WaitForMessage(conn, "MATCH_FOUND", 15000);
    conn.Send("JOIN_MATCH", { payload: { game: "airhockey", select: "Y" } });
    return { conn, userid: enter_result.userid, match_wait };
}

const mid_a = `a${run_tag}`;
const mid_b = `b${run_tag}`;
const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);

async function Main() {
    console.log(`에어하키 e2e 검증 시작 — lobby ws://${host}:${lobby_port}, airhockey ws://${host}:${airhockey_port}`);
    console.log(`테스트 계정: A=${userid_a} / B=${userid_b}\n`);

    // --- 1) 로비 매칭 ---
    console.log('[1] JOIN_MATCH{game:"airhockey"} 로 매칭되어야 한다');
    const player_a = await JoinLobbyAndMatch(mid_a);
    const player_b = await JoinLobbyAndMatch(mid_b);
    const [match_a, match_b] = await Promise.all([player_a.match_wait, player_b.match_wait]);
    checker.Check("두 유저 모두 MATCH_FOUND 를 받았다", match_a !== undefined && match_b !== undefined);
    checker.Check('game:"airhockey", room_name:"airhockey_1"', match_a?.game === "airhockey" && match_a?.room_name === "airhockey_1", `${match_a?.game} / ${match_a?.room_name}`);
    checker.Check("둘이 같은 방으로 매칭됐다", match_a?.room_id === match_b?.room_id);
    player_a.conn.Close();
    player_b.conn.Close();
    // ⚠️ 같은 로비에서 실제 클라이언트가 매칭을 기다리고 있으면 그 유저와 매칭될 수 있다(2026-10-15 실제로 겪음).
    //    그대로 진행하면 실제 유저와 게임을 하게 되므로 여기서 멈춘다 — 좌석은 소비하지 않아 그 유저는 로비로 돌아간다.
    if (!match_a || !match_b || match_a.room_id !== match_b.room_id) {
        console.log("\n⚠️ 테스트 유저끼리 매칭되지 않았습니다 — 다른 유저가 매칭 대기 중인지 확인하고 다시 실행하세요.");
        return checker.Report();
    }

    // --- 2) 입장 → READY → GAME_START → ONE_START ---
    console.log("\n[2] ENTER_ROOM → READY → GAME_START → (3초) → ONE_START → PUCK_MOVE(0,0)");
    // A 가 먼저 들어간다 → A = player1 = 아래쪽(side 0), B = player2 = 위쪽(side 1)
    const game_a = await client.ConnectWithSeat({ host, port: airhockey_port, reservation: match_a.seat_reservation });
    let game_b = await client.ConnectWithSeat({ host, port: airhockey_port, reservation: match_b.seat_reservation });
    if (!game_a.ok || !game_b.ok) throw new Error(`에어하키 채널 접속 실패: ${JSON.stringify({ a: game_a, b: game_b })}`);
    const log_a = Record(game_a);
    const log_b = Record(game_b);

    game_a.Send("ENTER_ROOM", { payload: {} });
    game_b.Send("ENTER_ROOM", { payload: {} });
    const enter_i_a = await WaitInLog(log_a, "ENTER_ROOM", 6000);
    checker.Check("양쪽이 ENTER_ROOM 응답을 받았다", enter_i_a !== -1 && (await WaitInLog(log_b, "ENTER_ROOM", 6000)) !== -1);
    checker.Check("player1 = A (먼저 입장)", log_a[enter_i_a]?.payload?.player1?.userid === userid_a, JSON.stringify(log_a[enter_i_a]?.payload?.player1));

    game_a.Send("READY", { payload: { ready: "Y" } });
    game_b.Send("READY", { payload: { ready: "Y" } });
    const start_i = await WaitInLog(log_a, "GAME_START", 6000);
    checker.Check("GAME_START", start_i !== -1 && (await WaitInLog(log_b, "GAME_START", 6000)) !== -1);
    if (mode === "invalid") return CheckInvalidByStuck(game_a, game_b, log_a, log_b, start_i);

    // --- 3) LEVER_MOVE 좌표 변환 (GAME_START ~ ONE_START 사이에도 레버는 움직일 수 있다) ---
    console.log("\n[3] LEVER_MOVE — 상대에게만, 받는 유저 기준 좌표로, 중앙선을 넘으면 잘려서");
    LeverTo(game_a, 100, 500); // 상대 진영으로 넘어감 → 서버가 (100, -60) 으로 자른다
    LeverTo(game_b, 250, -500); // B 기준 오른쪽 아래 = 절대 좌표 (-250, 500)
    await Sleep(600);
    const a_seen_by_b = LastOf(log_b, "LEVER_MOVE", (p) => p.user === userid_a);
    const b_seen_by_a = LastOf(log_a, "LEVER_MOVE", (p) => p.user === userid_b);
    checker.Check("A 레버가 B 화면에서는 뒤집혀 보이고, 중앙선에서 잘린다 → (-100, 60)", a_seen_by_b?.loc?.x === -100 && a_seen_by_b?.loc?.y === LEVER_RADIUS, JSON.stringify(a_seen_by_b));
    checker.Check("B 레버가 A 화면에서는 뒤집혀 보인다 → (-250, 500)", b_seen_by_a?.loc?.x === -250 && b_seen_by_a?.loc?.y === 500, JSON.stringify(b_seen_by_a));
    checker.Check("자기 레버는 자기에게 되돌려 보내지 않는다", !log_a.some((e) => e.type === "LEVER_MOVE" && e.payload.user === userid_a) && !log_b.some((e) => e.type === "LEVER_MOVE" && e.payload.user === userid_b));
    LeverTo(game_a, 0, -400); // 슛 준비 위치

    const one1_i = await WaitInLog(log_a, "ONE_START", (GAME_START_DELAY_SEC + 2) * 1000, start_i);
    const one1_delay = one1_i === -1 ? -1 : log_a[one1_i].at - log_a[start_i].at;
    checker.Check(`GAME_START 후 약 ${GAME_START_DELAY_SEC}초 뒤 ONE_START`, one1_delay >= GAME_START_DELAY_SEC * 1000 - 300 && one1_delay <= GAME_START_DELAY_SEC * 1000 + 800, `${one1_delay}ms`);
    const one1_i_b = await WaitInLog(log_b, "ONE_START", 3000);
    const puck0_a = (await WaitInLog(log_a, "PUCK_MOVE", 1000, one1_i)) === -1 ? undefined : LastOf(log_a, "PUCK_MOVE", () => true, one1_i);
    const puck0_b = (await WaitInLog(log_b, "PUCK_MOVE", 1000, one1_i_b)) === -1 ? undefined : LastOf(log_b, "PUCK_MOVE", () => true, one1_i_b);
    checker.Check("ONE_START 직후 양쪽에 PUCK_MOVE (0,0) vel (0,0) — 퍽은 중앙에 멈춘 채 시작", puck0_a?.loc?.x === 0 && puck0_a?.loc?.y === 0 && puck0_b?.loc?.x === 0 && puck0_b?.loc?.y === 0 && puck0_a?.vel?.x === 0 && puck0_a?.vel?.y === 0, `${JSON.stringify(puck0_a)} / ${JSON.stringify(puck0_b)}`);
    await Sleep(1000);
    const idle_puck_count = log_a.slice(one1_i).filter((e) => e.type === "PUCK_MOVE").length;
    checker.Check("아무도 안 치면 퍽이 멈춰 있고 PUCK_MOVE 를 반복해서 보내지 않는다", idle_puck_count === 1, `${idle_puck_count}건`);

    // --- 2-1) 퍽이 10초간 제자리 → 이번 판만 다시 시작 ---
    console.log(`\n[2-1] 아무도 안 치고 ${STUCK_RESET_SEC}초 → 골 없이 ONE_START 다시`);
    const restart_i = await WaitInLog(log_a, "ONE_START", (STUCK_RESET_SEC + 3) * 1000, one1_i + 1);
    const restart_delay = restart_i === -1 ? -1 : log_a[restart_i].at - log_a[one1_i].at;
    checker.Check(`ONE_START 후 약 ${STUCK_RESET_SEC}초 뒤 ONE_START 다시`, restart_i !== -1 && restart_delay >= STUCK_RESET_SEC * 1000 - 300 && restart_delay <= STUCK_RESET_SEC * 1000 + 800, `${restart_delay}ms`);
    const idle_pucks = log_a.slice(one1_i, restart_i === -1 ? undefined : restart_i).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.loc);
    checker.Check("그 사이 골(ONE_RESULT)은 없다 — 점수 그대로", !log_a.slice(one1_i).some((e) => e.type === "ONE_RESULT"), `그 사이 PUCK_MOVE ${idle_pucks.length}건 ${JSON.stringify(idle_pucks.slice(-3))}`);
    checker.Check("B 도 다시 ONE_START 를 받았다", (await WaitInLog(log_b, "ONE_START", 2000, one1_i_b + 1)) !== -1);

    // --- 2-2) ONE_START 뒤 첫 LEVER_MOVE 는 이전 궤적 무시, 그 좌표에 바로 놓인다 ---
    console.log("\n[2-2] ONE_START 뒤 첫 LEVER_MOVE → 이전 자리(0,-400)에서 끌려오지 않고 그 자리에 바로");
    const snap_i_b = log_b.length;
    LeverTo(game_a, 250, -150); // 이전 자리 (0,-400) 에서 270 떨어진 곳
    await WaitInLog(log_b, "LEVER_MOVE", 1000, snap_i_b, (p) => p.user === userid_a);
    await Sleep(200);
    const snap_seen = log_b.slice(snap_i_b).filter((e) => e.type === "LEVER_MOVE" && e.payload.user === userid_a).map((e) => e.payload.loc);
    checker.Check("B 화면에 A 레버가 중간 경로 없이 한 번에 (-250, 150) 으로 온다", snap_seen.length === 1 && snap_seen[0].x === -250 && snap_seen[0].y === 150, JSON.stringify(snap_seen));
    LeverTo(game_a, 0, -400); // 슛 준비 위치 (이후부터는 평소처럼 따라간다)
    await Sleep(300);

    // --- 4) A 가 슛 → 위 골대(B 쪽)에 골 ---
    console.log("\n[4] A 가 레버로 퍽을 쳐서 B 골대에 넣는다");
    const shot_i_a = log_a.length;
    const shot_i_b = log_b.length;
    const shot_at = Date.now();
    LeverTo(game_a, 0, -LEVER_RADIUS);
    const goal1_i = await WaitInLog(log_a, "ONE_RESULT", 4000, shot_i_a);
    const goal1_i_b = await WaitInLog(log_b, "ONE_RESULT", 4000, shot_i_b);
    const goal1 = log_a[goal1_i]?.payload;
    checker.Check("양쪽이 ONE_RESULT 를 받았다", goal1_i !== -1 && goal1_i_b !== -1);
    checker.Check("ONE_RESULT{win:A, win_count:1}", goal1?.win === userid_a && goal1?.win_count === 1, JSON.stringify(goal1));
    const path_a = log_a.slice(shot_i_a, goal1_i).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.loc);
    const path_b = log_b.slice(shot_i_b, goal1_i_b).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.loc);
    checker.Check("A 화면: 퍽이 위로 날아가 위 골대 안(y > 640)에서 끝난다", path_a.length > 2 && path_a.at(-1).y > HALF_HEIGHT && path_a.every((p, i) => i === 0 || p.y >= path_a[i - 1].y), JSON.stringify(path_a.map((p) => p.y)));
    checker.Check("B 화면: 같은 퍽이 아래(내 골대, y < -640)로 들어온다", path_b.length > 2 && path_b.at(-1).y < -HALF_HEIGHT, JSON.stringify(path_b.map((p) => p.y)));
    const vel_a = log_a.slice(shot_i_a, goal1_i).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.vel);
    const vel_b = log_b.slice(shot_i_b, goal1_i_b).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.vel);
    checker.Check("PUCK_MOVE.vel 도 받는 유저 기준 — 날아가는 동안 A 는 vel.y > 0, B 는 vel.y < 0", vel_a.slice(0, -1).every((v) => v?.y > 0) && vel_b.slice(0, -1).every((v) => v?.y < 0), `A=${JSON.stringify(vel_a.map((v) => v?.y))}`);
    checker.Check("골이 나면 마지막 PUCK_MOVE 의 vel 이 (0,0) — 클라이언트가 예측을 멈춘다", vel_a.at(-1)?.x === 0 && vel_a.at(-1)?.y === 0 && vel_b.at(-1)?.y === 0, JSON.stringify(vel_a.at(-1)));
    const flight_ms = log_a[goal1_i].at - shot_at;
    checker.Check("PUCK_MOVE 가 30Hz 이하로 온다", path_a.length <= Math.ceil((flight_ms / 1000) * 30) + 2, `${path_a.length}건 / ${flight_ms}ms`);

    // --- 5) 골 연출 중 B 가 끊김 → 재접속 → GAME_STATUS ---
    console.log("\n[5] 골 연출 중 B 연결이 끊김(drop) → 재접속 → ENTER_ROOM → GAME_STATUS");
    LeverTo(game_a, 250, -500); // 다음 판은 B 가 쏜다 — A 는 비켜 선다
    const activeGame = await import("../dist/game/room/activeGame.js");
    const active_b = await activeGame.GetActiveGame(userid_b);
    checker.Check("Redis 에 B 의 activeGame 기록이 있다", active_b !== null);
    game_b.Close(); // 동의 없는 종료 → onDrop → 재접속 창
    await Sleep(800);
    game_b = await client.ConnectWithSeat({
        host,
        port: airhockey_port,
        reservation: { processId: match_b.seat_reservation.processId, roomId: active_b?.room_id, sessionId: match_b.seat_reservation.sessionId },
        reconnection_token: active_b?.reconnection_token ?? "",
        timeout_ms: 6000,
    });
    checker.Check("B 가 같은 방으로 재접속했다", game_b.ok === true, JSON.stringify(game_b).slice(0, 120));
    if (!game_b.ok) return checker.Report();
    const reconnect_i_b = log_b.length;
    Record(game_b, log_b);
    game_b.Send("ENTER_ROOM", { payload: {} });
    const status_i = await WaitInLog(log_b, "GAME_STATUS", 3000, reconnect_i_b);
    const status = log_b[status_i]?.payload;
    checker.Check("재접속 후 ENTER_ROOM 재요청 → ENTER_ROOM 과 GAME_STATUS", (await WaitInLog(log_b, "ENTER_ROOM", 3000, reconnect_i_b)) !== -1 && status_i !== -1);
    checker.Check("GAME_STATUS 점수 win_count0:1 (A), win_count1:0 (B)", status?.win_count0 === 1 && status?.win_count1 === 0, JSON.stringify(status));
    checker.Check("GAME_STATUS 퍽은 B 기준 좌표 — B 골대 안(y < -640), 멈춰 있음(vel 0)", status?.puck?.loc?.y < -HALF_HEIGHT && status?.puck?.vel?.x === 0 && status?.puck?.vel?.y === 0, JSON.stringify(status?.puck));
    checker.Check("GAME_STATUS LEVER1(B 자신) = B 기준 (250, -500)", status?.LEVER1?.x === 250 && status?.LEVER1?.y === -500, JSON.stringify(status?.LEVER1));
    checker.Check("GAME_STATUS LEVER0(A) 도 B 기준 — A 는 B 화면 위쪽(y > 0)", status?.LEVER0?.y > 0, JSON.stringify(status?.LEVER0));
    checker.Check("재접속한 B 에게 아직 다음 ONE_START 가 오기 전이다 (골 연출 3초 안에 복원)", !log_b.slice(reconnect_i_b).some((e) => e.type === "ONE_START"));
    LeverTo(game_b, 0, -400);

    // --- 6) B 골 → A 두 골 → GAME_RESULT ---
    console.log("\n[6] 다음 판 B 골 → A 두 골(3골) → 약 3초 뒤 GAME_RESULT");
    const one2_i = await WaitInLog(log_a, "ONE_START", (ONE_RESULT_DELAY_SEC + 2) * 1000, goal1_i);
    const one2_delay = one2_i === -1 ? -1 : log_a[one2_i].at - log_a[goal1_i].at;
    checker.Check(`ONE_RESULT 후 약 ${ONE_RESULT_DELAY_SEC}초 뒤 다음 ONE_START`, one2_delay >= ONE_RESULT_DELAY_SEC * 1000 - 300 && one2_delay <= ONE_RESULT_DELAY_SEC * 1000 + 800, `${one2_delay}ms`);
    await WaitInLog(log_b, "ONE_START", 2000, reconnect_i_b);
    LeverTo(game_b, 0, -400); // 판의 첫 입력 = 시작 위치(바로 놓임), 그다음 휘두른다
    await Sleep(100);
    LeverTo(game_b, 0, -LEVER_RADIUS);
    const goal2_i = await WaitInLog(log_a, "ONE_RESULT", 4000, one2_i);
    checker.Check("재접속한 B 가 직접 쳐서 골 → ONE_RESULT{win:B, win_count:1}", log_a[goal2_i]?.payload?.win === userid_b && log_a[goal2_i]?.payload?.win_count === 1, JSON.stringify(log_a[goal2_i]?.payload));

    let last_goal_i = goal2_i;
    for (let goal = 2; goal <= 3; goal++) {
        LeverTo(game_b, 250, -500);
        LeverTo(game_a, 0, -400);
        const one_i = await WaitInLog(log_a, "ONE_START", (ONE_RESULT_DELAY_SEC + 2) * 1000, last_goal_i);
        LeverTo(game_a, 0, -400); // 판의 첫 입력 = 시작 위치(바로 놓임), 그다음 휘두른다
        await Sleep(100);
        LeverTo(game_a, 0, -LEVER_RADIUS);
        last_goal_i = await WaitInLog(log_a, "ONE_RESULT", 4000, one_i);
        checker.Check(`A ${goal}번째 골 → ONE_RESULT{win:A, win_count:${goal}}`, log_a[last_goal_i]?.payload?.win === userid_a && log_a[last_goal_i]?.payload?.win_count === goal, JSON.stringify(log_a[last_goal_i]?.payload));
    }

    const result1_i = await WaitInLog(log_a, "GAME_RESULT", (RESULT_DELAY_SEC + 2) * 1000, last_goal_i);
    const result1_delay = result1_i === -1 ? -1 : log_a[result1_i].at - log_a[last_goal_i].at;
    checker.Check(`마지막 골 뒤 약 ${RESULT_DELAY_SEC}초 뒤 GAME_RESULT`, result1_delay >= RESULT_DELAY_SEC * 1000 - 300 && result1_delay <= RESULT_DELAY_SEC * 1000 + 800, `${result1_delay}ms`);
    checker.Check("마지막 골과 GAME_RESULT 사이에 ONE_START 가 없다", !log_a.slice(last_goal_i, result1_i).some((e) => e.type === "ONE_START"));
    const result1 = log_a[result1_i]?.payload;
    checker.Check("승자 A: win_count 3, score 15", result1?.winner?.userid === userid_a && result1?.winner?.win_count === 3 && result1?.winner?.score === 15, JSON.stringify(result1?.winner));
    checker.Check("패자 B: win_count 1, score 5 (패자도 골 × 5)", result1?.loser?.userid === userid_b && result1?.loser?.win_count === 1 && result1?.loser?.score === 5, JSON.stringify(result1?.loser));
    checker.Check("draw:\"N\" — 무승부가 아니다 (draw 는 항상 온다)", result1?.draw === "N", String(result1?.draw));
    checker.Check("B 도 GAME_RESULT 를 받았다", (await WaitInLog(log_b, "GAME_RESULT", 2000, reconnect_i_b)) !== -1);

    // --- 7) 재게임 → B 퇴장 → 봇이 B 레버로 골 → GAME_RESULT → OUT_USER ---
    console.log("\n[7] 재게임 → B 가 GAME_START 직후 나감 → 봇이 대신 쳐서 3골 → GAME_RESULT 직후 OUT_USER");
    const before_replay = log_a.length;
    game_a.Send("GAME_RESULT", { payload: { replay: "Y" } });
    game_b.Send("GAME_RESULT", { payload: { replay: "Y" } });
    const start2_i = await WaitInLog(log_a, "GAME_START", 6000, before_replay);
    checker.Check("둘 다 재게임 → GAME_START 부터 다시 (READY 없이)", start2_i !== -1);
    game_b.Leave();
    LeverTo(game_a, -300, -580); // 구석으로 비켜서 봇이 넣게 둔다

    const result2_i = await WaitInLog(log_a, "GAME_RESULT", 40000, start2_i);
    const goals2 = log_a.slice(start2_i, result2_i === -1 ? undefined : result2_i).filter((e) => e.type === "ONE_RESULT").map((e) => e.payload);
    checker.Check("봇(B)이 3골을 넣었다", goals2.length === 3 && goals2.every((g) => g.win === userid_b), JSON.stringify(goals2));
    const bot_positions = new Set(log_a.slice(start2_i).filter((e) => e.type === "LEVER_MOVE" && e.payload.user === userid_b).map((e) => `${e.payload.loc.x},${e.payload.loc.y}`));
    checker.Check("B 가 나간 뒤에도 B 레버가 움직인다 (봇 조종)", bot_positions.size >= 5, `서로 다른 위치 ${bot_positions.size}곳`);
    checker.Check("B 가 나가도 게임 중에는 OUT_USER 가 오지 않는다", !log_a.slice(start2_i, result2_i).some((e) => e.type === "OUT_USER"));
    const result2 = log_a[result2_i]?.payload;
    checker.Check("나간 B 가 승자로 반영된다: B 3골 15점 / A 0골 0점, draw:\"N\"", result2?.draw === "N" && result2?.winner?.userid === userid_b && result2?.winner?.score === 15 && result2?.loser?.win_count === 0 && result2?.loser?.score === 0, JSON.stringify(result2));
    const out_i = await WaitInLog(log_a, "OUT_USER", 3000, result2_i);
    checker.Check("GAME_RESULT 직후 OUT_USER{B}", out_i > result2_i && log_a[out_i]?.payload?.userid === userid_b, JSON.stringify(log_a[out_i]?.payload));
    // A 는 재게임/나가기를 고르지 않는다 → 10초 뒤 서버가 로비로 보내야 한다.
    // ⚠️ 2026-10-15 버그: 물리 루프를 멈추면 룸 clock 이 멈춰 이 타이머가 영원히 안 울렸다(방에 계속 머묾).
    const back_i = await WaitInLog(log_a, "RETURN_TO_LOBBY", (REMATCH_CHOICE_TIMEOUT_SEC + 3) * 1000, result2_i);
    const back_delay = back_i === -1 ? -1 : log_a[back_i].at - log_a[result2_i].at;
    checker.Check(`재게임 무응답 → 약 ${REMATCH_CHOICE_TIMEOUT_SEC}초 뒤 RETURN_TO_LOBBY`, back_i !== -1 && back_delay >= REMATCH_CHOICE_TIMEOUT_SEC * 1000 - 300 && back_delay <= REMATCH_CHOICE_TIMEOUT_SEC * 1000 + 1000, `${back_delay}ms`);

    // --- 8) DB ---
    console.log("\n[8] DB 반영 — airhockey_game_log / play_info / rank");
    await Sleep(1500);
    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/airhockeyGameLogSchema.js");
    const table = log_mod.GetAirhockeyGameLogTableName(new Date());

    const [logs] = await pool.query(
        `SELECT win, lose, vs, score, is_draw, win_is_bot, lose_is_bot, JSON_LENGTH(plays) AS play_count FROM \`${table}\` WHERE win IN (?, ?) ORDER BY id`,
        [userid_a, userid_b]
    );
    checker.Check("airhockey_game_log 에 2게임이 기록됐다", logs.length === 2, `${logs.length}행`);
    if (logs.length === 2) {
        checker.Check("1게임: A 승, vs '3:1', score 15, plays 4골, 잠깐 끊긴 B 는 is_bot 아님", logs[0].win === userid_a && logs[0].vs === "3:1" && logs[0].score === 15 && Number(logs[0].play_count) === 4 && logs[0].lose_is_bot === 0, JSON.stringify(logs[0]));
        checker.Check("2게임: 나간 B 승, vs '3:0', win_is_bot=1", logs[1].win === userid_b && logs[1].vs === "3:0" && logs[1].win_is_bot === 1 && logs[1].lose_is_bot === 0, JSON.stringify(logs[1]));
    }

    const [plays] = await pool.query(`SELECT userid, total_game_count, total_win_count, total_score FROM airhockey_user_play_info WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    const play_a = plays.find((p) => p.userid === userid_a);
    const play_b = plays.find((p) => p.userid === userid_b);
    checker.Check("play_info: 둘 다 2게임 1승", plays.length === 2 && plays.every((p) => p.total_game_count === 2 && p.total_win_count === 1), JSON.stringify(plays));
    checker.Check("play_info: A 누적 15점(15+0), B 누적 20점(5+15)", play_a?.total_score === 15 && play_b?.total_score === 20, JSON.stringify(plays));
    const [ranks] = await pool.query(`SELECT userid, score FROM airhockey_rank_daily WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    checker.Check("airhockey_rank_daily: A 15점, B 20점", ranks.find((r) => r.userid === userid_a)?.score === 15 && ranks.find((r) => r.userid === userid_b)?.score === 20, JSON.stringify(ranks));

    game_a.Leave();
    checker.Report();
}

// MODE=invalid — 아무도 레버를 안 움직인다. 정체 재시작 3번 뒤 4번째 정체에서 즉시 무승부 결과 GAME_RESULT{draw:"Y"}
// → 일반 결과와 같은 재게임 선택(A 는 N 으로 즉시 로비, B 는 무응답 10초 뒤 로비). 별도 알림 메시지는 없고 기록도 없다.
async function CheckInvalidByStuck(game_a, game_b, log_a, log_b, start_i) {
    const expected_ms = (GAME_START_DELAY_SEC + STUCK_RESET_SEC * (STUCK_MAX_RESTARTS + 1)) * 1000;
    console.log(`\n[무효] 양쪽 방치 → 재시작 ${STUCK_MAX_RESTARTS}번 → 약 ${expected_ms / 1000}초 뒤 GAME_RESULT{draw:"Y"} → 재게임 선택`);
    const result_i = {};
    for (const [name, log, userid] of [["A", log_a, userid_a], ["B", log_b, userid_b]]) {
        const ri = await WaitInLog(log, "GAME_RESULT", expected_ms + 5000, name === "A" ? start_i : 0);
        result_i[name] = ri;
        const delay = ri === -1 ? -1 : log[ri].at - log_a[start_i].at;
        checker.Check(`${name}: GAME_START 후 약 ${expected_ms / 1000}초 뒤 GAME_RESULT (무효 판정 즉시)`, ri !== -1 && Math.abs(delay - expected_ms) <= 1000, `${delay}ms`);
        const one_starts = log.filter((e) => e.type === "ONE_START").length;
        checker.Check(`${name}: ONE_START ${STUCK_MAX_RESTARTS + 1}번 (처음 1 + 재시작 ${STUCK_MAX_RESTARTS})`, one_starts === STUCK_MAX_RESTARTS + 1, `${one_starts}번`);
        const r = log[ri]?.payload;
        checker.Check(`${name}: GAME_RESULT 는 draw:"Y", winner=A / loser=B, 골 0 · 점수 0, invalid 필드 없음`,
            r?.draw === "Y" && r?.invalid === undefined && r?.winner?.userid === userid_a && r?.loser?.userid === userid_b &&
                r?.winner?.win_count === 0 && r?.winner?.score === 0 && r?.loser?.score === 0, JSON.stringify(r));
        checker.Check(`${name}: GAME_INVALID 는 오지 않는다 (프로토콜 제거)`, !log.some((e) => e.type === "GAME_INVALID"));
        checker.Check(`${name}: 무효 직후 바로 로비로 보내지 않는다 (GAME_RESULT 전 RETURN_TO_LOBBY 없음)`, !log.slice(0, ri === -1 ? undefined : ri).some((e) => e.type === "RETURN_TO_LOBBY"));
        checker.Check(`${name}: ONE_RESULT 는 없다`, !log.some((e) => e.type === "ONE_RESULT"), userid);
    }

    // A 는 나가기 → 즉시 로비, B 는 무응답 → 10초 뒤 로비 (일반 결과와 같은 재게임 선택)
    game_a.Send("GAME_RESULT", { payload: { replay: "N" } });
    const back_a = await WaitInLog(log_a, "RETURN_TO_LOBBY", 2000, result_i.A);
    checker.Check('A: replay:"N" → 바로 RETURN_TO_LOBBY', back_a !== -1);
    const back_b = await WaitInLog(log_b, "RETURN_TO_LOBBY", (REMATCH_CHOICE_TIMEOUT_SEC + 3) * 1000, result_i.B);
    const back_b_delay = back_b === -1 || result_i.B === -1 ? -1 : log_b[back_b].at - log_b[result_i.B].at;
    checker.Check(`B: 무응답 → 약 ${REMATCH_CHOICE_TIMEOUT_SEC}초 뒤 RETURN_TO_LOBBY`, back_b !== -1 && Math.abs(back_b_delay - REMATCH_CHOICE_TIMEOUT_SEC * 1000) <= 1000, `${back_b_delay}ms`);
    checker.Check("B 는 A 가 나간 것을 OUT_USER 로 안다", log_b.some((e) => e.type === "OUT_USER" && e.payload.userid === userid_a));

    await Sleep(1000);
    const activeGame = await import("../dist/game/room/activeGame.js");
    checker.Check("Redis activeGame 기록이 둘 다 지워졌다 (로비가 이 방으로 재접속을 안내하지 않는다)", (await activeGame.GetActiveGame(userid_a)) === null && (await activeGame.GetActiveGame(userid_b)) === null);
    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/airhockeyGameLogSchema.js");
    const table = log_mod.GetAirhockeyGameLogTableName(new Date());
    const [logs] = await pool.query(`SELECT id FROM \`${table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`, [userid_a, userid_b, userid_a, userid_b]);
    checker.Check("무효 게임은 airhockey_game_log 에 남지 않는다", logs.length === 0, `${logs.length}행`);
    const [plays] = await pool.query(`SELECT total_game_count, total_score FROM airhockey_user_play_info WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    checker.Check("play_info 도 그대로 (0게임 0점)", plays.length === 2 && plays.every((p) => p.total_game_count === 0 && p.total_score === 0), JSON.stringify(plays));
    checker.Report();
}

// 정리 — 이번 테스트 유저 행만 지운다. Main 이 중간에 예외로 끝나도 반드시 돈다(안 그러면 zzair 행이 남는다).
async function Cleanup() {
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
        return;
    }
    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/airhockeyGameLogSchema.js");
    const table = log_mod.GetAirhockeyGameLogTableName(new Date());
    console.log(`\n정리 (이번 테스트 유저 행만):`);
    await pool.query(`DELETE FROM \`${table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`, [userid_a, userid_b, userid_a, userid_b]).catch(() => {});
    for (const t of ["airhockey_rank_daily", "airhockey_rank_weekly", "airhockey_user_play_info", "stepping_user_play_info", "othello_user_play_info", "rps_user_play_info", "user_member_info", "user_partner_info"]) {
        const [r] = await pool.query(`DELETE FROM ${t} WHERE userid IN (?, ?)`, [userid_a, userid_b]);
        if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
    }
    const redis_mod = await import("../dist/db/redis.js");
    const redis = redis_mod.GetRedisClient();
    for (const userid of [userid_a, userid_b]) {
        await redis_mod.DeleteJson(`user:info:${userid}`);
        for (const game of ["rps", "othello", "stepping", "airhockey"]) await redis_mod.DeleteJson(`user:play:${game}:${userid}`);
    }
    // 랭킹 Sorted Set 에서도 테스트 유저를 뺀다 (안 빼면 실제 랭킹 화면에 테스트 유저가 보인다)
    const zset_keys = await redis.keys("rank_zset:airhockey:*");
    for (const key of zset_keys) await redis.zrem(key, userid_a, userid_b);
    redis.disconnect();
    console.log("  Redis 캐시/랭킹 삭제 완료");
    await pool.end();
}

try {
    await Main();
} catch (error) {
    console.error("\n✖ 예외로 중단:", error);
    process.exitCode = 1;
} finally {
    await Cleanup();
    process.exit();
}
