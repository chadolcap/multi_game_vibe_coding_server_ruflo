// 에어하키(airhockey) e2e 검증 스크립트 (2026-10-15).
//
// 검증 대상:
//   1) 로비 매칭 — JOIN_MATCH{game:"airhockey"} → MATCH_FOUND{room_name:"airhockey_1"}
//   2) 시작 — READY → SERVE_SELECT{userid}(동전 던지기, 양쪽 같은 값) → 약 5초 뒤 GAME_START → 약 3초 뒤
//      ONE_START{serve} → 서브 쪽 (0,∓200) PUCK_MOVE 한 번, 멈춘 퍽은 반복 전송 안 함 (2026-10-29 서브 규칙)
//   2-1) 서브 제한 — 서버가 10초간 서브를 안 하면 골 없이 ONE_START 가 다시 오고 **서브권이 상대에게** 넘어간다.
//        상대도 10초간 안 하면 다시 돌아온다(2026-10-29)
//   3) 좌표 — LEVER_MOVE 는 상대에게만, **받는 유저 기준**(180도 회전)으로 중계되고, 중앙선을 넘으면 잘린다
//   4) 골 — 서버(서브하는 유저)가 퍽을 쳐서 상대 골대에 넣으면 ONE_RESULT{win, win_count}. 두 화면의 퍽 궤적·vel 이
//      서로 반대, 골이 나면 vel (0,0) 으로 멈춤을 알린다
//   5) 재접속 — 골 연출 중 끊김(drop) → 재접속 + ENTER_ROOM → GAME_STATUS(점수, 퍽, LEVER0/1, server, 내 기준 좌표)
//   6) 진행 — 매 판 그 판의 서버가 골을 넣는다. ONE_START.serve 가 탁구 규칙(2점마다 교대)과 맞는지 매 판 확인
//      → 첫 서버가 3:2 로 이김 → 약 3초 뒤 GAME_RESULT(win_count=골, score=골×5)
//   7) 재게임 + 퇴장 — 첫 서브가 **교대**(직전 게임의 리시브 쪽)되는지 확인. B 가 나가면 봇이 B 레버를 움직여
//      골을 넣고(A 가 서브할 판은 A 가 살짝 넘겨 준다), 결과는 B 승리로 반영 → 그 직후 OUT_USER
//      → A 가 재게임/나가기를 안 고르면 10초 뒤 RETURN_TO_LOBBY
//   8) DB — airhockey_game_log 2행(vs, score, plays, win_is_bot), play_info(score 누적), rank_daily
//   ※ 첫 서브는 랜덤이라 승자·DB 기댓값은 SERVE_SELECT 결과에 맞춰 계산한다.
//
// ⚠️ 이 스크립트는 지우지 말 것 (CLAUDE.md 10장).
// ⚠️ **DB 에 테스트 유저 2명을 만든다.** 끝나고 자기 행만 지운다(TEST_PARTNER 접두사). KEEP=1 이면 정리 생략.
//
// 사용법 (로비와 에어하키 채널이 떠 있어야 한다, 약 80초 걸린다 — 출력을 | head 로 자르지 말 것):
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> AIRHOCKEY_PORT=6051 node scripts/check-airhockey-game.mjs > out.txt
// MODE=invalid — 위 흐름 대신 "서브 10초 초과로 서브권 넘김(정체 횟수에 안 셈) → 넘겨받은 유저가 살살 서브하고 방치 →
//   정체 재시작 3번(같은 서버) → 4번째 정체에서 즉시 GAME_RESULT{draw:"Y"} → 재게임 선택, 기록 없음"만 확인한다(약 90초).

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
const SERVE_SELECT_DELAY_SEC = 5;
const SERVE_PUCK_OFFSET = 200;
const GAME_START_DELAY_SEC = 3;
const ONE_RESULT_DELAY_SEC = 3;
const RESULT_DELAY_SEC = 3;
const REMATCH_CHOICE_TIMEOUT_SEC = 10;
const STUCK_RESET_SEC = 10;
const SERVE_TIMEOUT_SEC = 10;
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

// log 에 types 중 하나가 from_index 이후로 생길 때까지 기다린다 (ONE_START 또는 GAME_RESULT 처럼 다음에 뭐가 올지 모를 때)
async function WaitInLogAny(log, types, timeout_ms, from_index = 0) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const index = log.findIndex((entry, i) => i >= from_index && types.includes(entry.type));
        if (index !== -1) return index;
        await Sleep(20);
    }
    return -1;
}

// airhockeyRules.GetServeSide 와 같은 규칙(3골 선승) — 첫 서버부터 2점마다 교대. 2:2 듀스도 결과가 같다.
function ExpectedServer(first_userid, total_goals) {
    const other = first_userid === userid_a ? userid_b : userid_a;
    return Math.floor(total_goals / 2) % 2 === 0 ? first_userid : other;
}

// 서버(serve 유저) 화면에서는 퍽이 내 쪽(0,-200), 받는 쪽 화면에서는 상대 쪽(0,200)에 있다
function IsServePuck(loc, is_server) {
    return loc?.x === 0 && loc?.y === (is_server ? -SERVE_PUCK_OFFSET : SERVE_PUCK_OFFSET);
}

// A 가 서브할 판에 퍽을 살짝 상대 진영으로 넘겨 준다(봇이 칠 수 있게). 손을 180/초로 천천히 밀어 올린다 —
// 세게 치면 봇 골대로 바로 들어가 A 가 골을 넣어 버린다. 그 뒤 구석으로 비킨다.
async function PokeServe(conn) {
    LeverTo(conn, 0, -330); // 판의 첫 입력 = 그 자리에 바로 놓임 (퍽 아래 40 떨어진 곳)
    await Sleep(100);
    for (let y = -324; y <= -170; y += 6) {
        LeverTo(conn, 0, y);
        await Sleep(33);
    }
    await Sleep(200);
    LeverTo(conn, -300, -580);
}

// 서브를 하되 골은 안 나게 — 퍽 왼쪽에서 손을 약 60/초로 오른쪽으로 밀어 퍽을 내 진영 안에서 옆으로 굴린 뒤 구석으로
// 비킨다. 퍽은 마찰로 내 진영에서 멈추고, 그 뒤 10초면 정체가 된다(MODE=invalid 용).
async function GentleServe(conn) {
    LeverTo(conn, -100, -SERVE_PUCK_OFFSET); // 판의 첫 입력 = 그 자리에 바로 놓임 (퍽과 100 떨어짐, 닿는 거리 90)
    await Sleep(100);
    for (let x = -98; x <= -20; x += 2) {
        LeverTo(conn, x, -SERVE_PUCK_OFFSET);
        await Sleep(33);
    }
    await Sleep(200);
    LeverTo(conn, -300, -580);
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
    console.log("\n[2] ENTER_ROOM → READY → SERVE_SELECT → (5초) → GAME_START → (3초) → ONE_START{serve} → 서브 쪽 PUCK_MOVE");
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
    const serve_i = await WaitInLog(log_a, "SERVE_SELECT", 6000);
    const serve_i_b = await WaitInLog(log_b, "SERVE_SELECT", 6000);
    const first_server = log_a[serve_i]?.payload?.userid;
    checker.Check("양쪽이 같은 SERVE_SELECT{userid} 를 받았고, 두 유저 중 하나다", serve_i !== -1 && log_b[serve_i_b]?.payload?.userid === first_server && [userid_a, userid_b].includes(first_server), `${first_server === userid_a ? "A" : "B"} 서브`);
    checker.Check("SERVE_SELECT 전에 GAME_START 가 오지 않는다", !log_a.slice(0, serve_i).some((e) => e.type === "GAME_START"));
    const start_i = await WaitInLog(log_a, "GAME_START", (SERVE_SELECT_DELAY_SEC + 3) * 1000, serve_i);
    const start_delay = start_i === -1 ? -1 : log_a[start_i].at - log_a[serve_i].at;
    checker.Check(`SERVE_SELECT 후 약 ${SERVE_SELECT_DELAY_SEC}초 뒤 GAME_START`, start_i !== -1 && start_delay >= SERVE_SELECT_DELAY_SEC * 1000 - 300 && start_delay <= SERVE_SELECT_DELAY_SEC * 1000 + 800 && (await WaitInLog(log_b, "GAME_START", 3000)) !== -1, `${start_delay}ms`);
    if (mode === "invalid") return CheckInvalidByStuck(game_a, game_b, log_a, log_b, start_i);
    const first_conn_is_a = first_server === userid_a;

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
    checker.Check("첫 ONE_START.serve = SERVE_SELECT 유저 (양쪽)", log_a[one1_i]?.payload?.serve === first_server && log_b[one1_i_b]?.payload?.serve === first_server, JSON.stringify(log_a[one1_i]?.payload));
    checker.Check(`ONE_START 직후 PUCK_MOVE vel (0,0) — 퍽은 서버 쪽 200 에 멈춘 채 시작 (서버 화면 y=-${SERVE_PUCK_OFFSET}, 상대 화면 y=${SERVE_PUCK_OFFSET})`,
        IsServePuck(puck0_a?.loc, first_conn_is_a) && IsServePuck(puck0_b?.loc, !first_conn_is_a) && puck0_a?.vel?.x === 0 && puck0_a?.vel?.y === 0,
        `${JSON.stringify(puck0_a)} / ${JSON.stringify(puck0_b)}`);
    await Sleep(1000);
    const idle_puck_count = log_a.slice(one1_i).filter((e) => e.type === "PUCK_MOVE").length;
    checker.Check("아무도 안 치면 퍽이 멈춰 있고 PUCK_MOVE 를 반복해서 보내지 않는다", idle_puck_count === 1, `${idle_puck_count}건`);

    // --- 2-1) 서브를 10초간 안 함 → 서브권이 상대에게, 상대도 안 하면 다시 돌아옴 (2026-10-29) ---
    console.log(`\n[2-1] 서브 안 하고 ${SERVE_TIMEOUT_SEC}초 → 골 없이 ONE_START, 서브권 상대에게 → 또 ${SERVE_TIMEOUT_SEC}초 → 다시 돌아옴`);
    const receiver = first_conn_is_a ? userid_b : userid_a;
    let pass_from_i = one1_i;
    let pass_from_i_b = one1_i_b;
    for (const [step, expected_server] of [[1, receiver], [2, first_server]]) {
        const pass_i = await WaitInLog(log_a, "ONE_START", (SERVE_TIMEOUT_SEC + 3) * 1000, pass_from_i + 1);
        const pass_delay = pass_i === -1 ? -1 : log_a[pass_i].at - log_a[pass_from_i].at;
        checker.Check(`${step}번째: ONE_START 후 약 ${SERVE_TIMEOUT_SEC}초 뒤 ONE_START 다시`, pass_i !== -1 && pass_delay >= SERVE_TIMEOUT_SEC * 1000 - 300 && pass_delay <= SERVE_TIMEOUT_SEC * 1000 + 800, `${pass_delay}ms`);
        const pass_i_b = await WaitInLog(log_b, "ONE_START", 2000, pass_from_i_b + 1);
        const pass_puck = (await WaitInLog(log_a, "PUCK_MOVE", 1000, pass_i)) === -1 ? undefined : LastOf(log_a, "PUCK_MOVE", () => true, pass_i);
        checker.Check(`${step}번째: 서브권이 ${expected_server === userid_a ? "A" : "B"} 로 (양쪽 serve 같음), 퍽도 그 유저 서브 자리`,
            log_a[pass_i]?.payload?.serve === expected_server && log_b[pass_i_b]?.payload?.serve === expected_server && IsServePuck(pass_puck?.loc, expected_server === userid_a),
            `${JSON.stringify(log_a[pass_i]?.payload)} ${JSON.stringify(pass_puck)}`);
        pass_from_i = pass_i;
        pass_from_i_b = pass_i_b;
    }
    checker.Check("그 사이 골(ONE_RESULT)은 없다 — 서브 넘김은 점수 없음", !log_a.slice(one1_i).some((e) => e.type === "ONE_RESULT"));

    // --- 2-2) ONE_START 뒤 첫 LEVER_MOVE 는 이전 궤적 무시, 그 좌표에 바로 놓인다 ---
    console.log("\n[2-2] ONE_START 뒤 첫 LEVER_MOVE → 이전 자리(0,-400)에서 끌려오지 않고 그 자리에 바로");
    // ONE_START 직후 다음 전송 틱(최대 33ms)에 레버 현재 위치가 한 번 재전송된다(ForceResendPositions) — 그게 도착한 뒤부터 잰다.
    // 안 기다리면 그 재전송 (0,400) 이 "중간 경로"로 섞여 가끔 실패한다(2026-10-29, 4번 중 1번).
    await Sleep(150);
    const snap_i_b = log_b.length;
    LeverTo(game_a, 250, -150); // 이전 자리 (0,-400) 에서 270 떨어진 곳
    await WaitInLog(log_b, "LEVER_MOVE", 1000, snap_i_b, (p) => p.user === userid_a);
    await Sleep(200);
    const snap_seen = log_b.slice(snap_i_b).filter((e) => e.type === "LEVER_MOVE" && e.payload.user === userid_a).map((e) => e.payload.loc);
    checker.Check("B 화면에 A 레버가 중간 경로 없이 한 번에 (-250, 150) 으로 온다", snap_seen.length === 1 && snap_seen[0].x === -250 && snap_seen[0].y === 150, JSON.stringify(snap_seen));
    // 서버는 슛 준비 위치로, 받는 쪽은 슛 길을 비켜 선다 (받는 쪽 레버가 골대 앞에 있으면 슛을 막는다)
    if (first_conn_is_a) {
        LeverTo(game_a, 0, -400);
        LeverTo(game_b, 250, -500); // B 의 이 판 첫 입력 = 그 자리에 바로 놓임
    } else {
        LeverTo(game_a, 250, -500);
        LeverTo(game_b, 0, -400); // B 의 이 판 첫 입력 = 슛 준비 위치에 바로 놓임
    }
    await Sleep(300);

    // --- 4) 서버가 슛 → 상대 골대에 골 ---
    // shooter = 이 판을 서브한 유저. 슛한 쪽 화면에서는 퍽이 위로, 받은 쪽 화면에서는 아래로 간다.
    console.log(`\n[4] 서버(${first_conn_is_a ? "A" : "B"})가 레버로 퍽을 쳐서 상대 골대에 넣는다`);
    const [shoot_log, recv_log] = first_conn_is_a ? [log_a, log_b] : [log_b, log_a];
    const shot_i_s = shoot_log.length;
    const shot_i_r = recv_log.length;
    const shot_at = Date.now();
    LeverTo(first_conn_is_a ? game_a : game_b, 0, -LEVER_RADIUS);
    const goal1_i_s = await WaitInLog(shoot_log, "ONE_RESULT", 4000, shot_i_s);
    const goal1_i_r = await WaitInLog(recv_log, "ONE_RESULT", 4000, shot_i_r);
    const goal1_i = first_conn_is_a ? goal1_i_s : goal1_i_r; // 이후 단계는 A 로그 기준 index 를 쓴다
    const goal1 = shoot_log[goal1_i_s]?.payload;
    checker.Check("양쪽이 ONE_RESULT 를 받았다", goal1_i_s !== -1 && goal1_i_r !== -1);
    checker.Check("ONE_RESULT{win:서버, win_count:1}", goal1?.win === first_server && goal1?.win_count === 1, JSON.stringify(goal1));
    const path_s = shoot_log.slice(shot_i_s, goal1_i_s).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.loc);
    const path_r = recv_log.slice(shot_i_r, goal1_i_r).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.loc);
    checker.Check("슛한 쪽 화면: 퍽이 위로 날아가 위 골대 안(y > 640)에서 끝난다", path_s.length > 2 && path_s.at(-1).y > HALF_HEIGHT && path_s.every((p, i) => i === 0 || p.y >= path_s[i - 1].y), JSON.stringify(path_s.map((p) => p.y)));
    checker.Check("받은 쪽 화면: 같은 퍽이 아래(내 골대, y < -640)로 들어온다", path_r.length > 2 && path_r.at(-1).y < -HALF_HEIGHT, JSON.stringify(path_r.map((p) => p.y)));
    const vel_s = shoot_log.slice(shot_i_s, goal1_i_s).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.vel);
    const vel_r = recv_log.slice(shot_i_r, goal1_i_r).filter((e) => e.type === "PUCK_MOVE").map((e) => e.payload.vel);
    checker.Check("PUCK_MOVE.vel 도 받는 유저 기준 — 날아가는 동안 슛한 쪽 vel.y > 0, 받은 쪽 vel.y < 0", vel_s.slice(0, -1).every((v) => v?.y > 0) && vel_r.slice(0, -1).every((v) => v?.y < 0), `S=${JSON.stringify(vel_s.map((v) => v?.y))}`);
    checker.Check("골이 나면 마지막 PUCK_MOVE 의 vel 이 (0,0) — 클라이언트가 예측을 멈춘다", vel_s.at(-1)?.x === 0 && vel_s.at(-1)?.y === 0 && vel_r.at(-1)?.y === 0, JSON.stringify(vel_s.at(-1)));
    const flight_ms = shoot_log[goal1_i_s].at - shot_at;
    checker.Check("PUCK_MOVE 가 30Hz 이하로 온다", path_s.length <= Math.ceil((flight_ms / 1000) * 30) + 2, `${path_s.length}건 / ${flight_ms}ms`);

    // --- 5) 골 연출 중 B 가 끊김 → 재접속 → GAME_STATUS ---
    console.log("\n[5] 골 연출 중 B 연결이 끊김(drop) → 재접속 → ENTER_ROOM → GAME_STATUS");
    LeverTo(game_a, 250, -500); // 둘 다 비켜 선다 — GAME_STATUS 의 LEVER1 을 정확한 자리로 확인하려고 B 도 옮겨 둔다
    LeverTo(game_b, 250, -500);
    await Sleep(500); // 골 연출 중에도 레버는 따라간다 — 자리에 멈출 때까지
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
    const [expect_wc0, expect_wc1] = first_conn_is_a ? [1, 0] : [0, 1];
    checker.Check(`GAME_STATUS 점수 win_count0:${expect_wc0} (A), win_count1:${expect_wc1} (B)`, status?.win_count0 === expect_wc0 && status?.win_count1 === expect_wc1, JSON.stringify(status));
    // A 가 넣었으면 퍽은 B 골대 안(B 기준 y < -640), B 가 넣었으면 A 골대 안(B 기준 y > 640)
    const puck_in_goal = first_conn_is_a ? status?.puck?.loc?.y < -HALF_HEIGHT : status?.puck?.loc?.y > HALF_HEIGHT;
    checker.Check("GAME_STATUS 퍽은 B 기준 좌표 — 골이 들어간 골대 안, 멈춰 있음(vel 0)", puck_in_goal && status?.puck?.vel?.x === 0 && status?.puck?.vel?.y === 0, JSON.stringify(status?.puck));
    checker.Check("GAME_STATUS server = 방금 끝난 판의 서버", status?.server === first_server, String(status?.server));
    checker.Check("GAME_STATUS LEVER1(B 자신) = B 기준 (250, -500)", status?.LEVER1?.x === 250 && status?.LEVER1?.y === -500, JSON.stringify(status?.LEVER1));
    checker.Check("GAME_STATUS LEVER0(A) 도 B 기준 — A 는 B 화면 위쪽(y > 0)", status?.LEVER0?.y > 0, JSON.stringify(status?.LEVER0));
    checker.Check("재접속한 B 에게 아직 다음 ONE_START 가 오기 전이다 (골 연출 3초 안에 복원)", !log_b.slice(reconnect_i_b).some((e) => e.type === "ONE_START"));
    // --- 6) 매 판 그 판의 서버가 골 → 첫 서버가 3:2 → GAME_RESULT ---
    // 서브 순서(첫 서버 F): F, F(1:0 뒤), 상대, 상대, F(2:2 듀스) — 서버가 매번 넣으면 F 가 3:2 로 이긴다.
    // 재접속한 B 는 3·4번째 판(F=A) 또는 2·5번째 판(F=B)에 직접 서브해 골을 넣는다.
    console.log("\n[6] 매 판 ONE_START.serve 가 탁구 순서인지 확인하고 그 서버가 골 → 첫 서버 3:2 → 약 3초 뒤 GAME_RESULT");
    const goals = { [userid_a]: first_conn_is_a ? 1 : 0, [userid_b]: first_conn_is_a ? 0 : 1 };
    let last_goal_i = goal1_i;
    let b_scored_after_reconnect = false;
    let scan_b = reconnect_i_b; // B 로그에서 다음 ONE_START 를 찾을 위치 (재접속 뒤부터)
    for (let round = 2; round <= 5; round++) {
        const one_i = await WaitInLog(log_a, "ONE_START", (ONE_RESULT_DELAY_SEC + 2) * 1000, last_goal_i);
        if (round === 2) {
            const one2_delay = one_i === -1 ? -1 : log_a[one_i].at - log_a[goal1_i].at;
            checker.Check(`ONE_RESULT 후 약 ${ONE_RESULT_DELAY_SEC}초 뒤 다음 ONE_START`, one2_delay >= ONE_RESULT_DELAY_SEC * 1000 - 300 && one2_delay <= ONE_RESULT_DELAY_SEC * 1000 + 800, `${one2_delay}ms`);
        }
        const total = goals[userid_a] + goals[userid_b];
        const expected = ExpectedServer(first_server, total);
        const one_b_i = await WaitInLog(log_b, "ONE_START", 2000, scan_b);
        scan_b = one_b_i + 1;
        checker.Check(`${round}번째 판(${goals[userid_a]}:${goals[userid_b]}) serve = ${expected === userid_a ? "A" : "B"} (양쪽)`, log_a[one_i]?.payload?.serve === expected && log_b[one_b_i]?.payload?.serve === expected, JSON.stringify(log_a[one_i]?.payload));
        const puck_a = (await WaitInLog(log_a, "PUCK_MOVE", 1000, one_i)) === -1 ? undefined : LastOf(log_a, "PUCK_MOVE", () => true, one_i);
        checker.Check(`${round}번째 판 퍽은 서버 쪽 200 에서 시작 (A 화면)`, IsServePuck(puck_a?.loc, expected === userid_a), JSON.stringify(puck_a));

        // 서버는 판의 첫 입력으로 슛 준비 위치(바로 놓임), 받는 쪽은 비켜 선다 → 서버가 휘두른다
        const [server_conn, receiver_conn] = expected === userid_a ? [game_a, game_b] : [game_b, game_a];
        LeverTo(receiver_conn, 250, -500);
        LeverTo(server_conn, 0, -400);
        await Sleep(100);
        LeverTo(server_conn, 0, -LEVER_RADIUS);
        last_goal_i = await WaitInLog(log_a, "ONE_RESULT", 4000, one_i);
        const goal = log_a[last_goal_i]?.payload;
        goals[expected] += 1;
        checker.Check(`${round}번째 판 서버가 골 → ONE_RESULT{win:${expected === userid_a ? "A" : "B"}, win_count:${goals[expected]}}`, goal?.win === expected && goal?.win_count === goals[expected], JSON.stringify(goal));
        if (expected === userid_b && !b_scored_after_reconnect) {
            b_scored_after_reconnect = goal?.win === userid_b;
            checker.Check("재접속한 B 가 직접 서브해 골을 넣었다", b_scored_after_reconnect);
        }
        if (last_goal_i === -1 || goals[userid_a] >= 3 || goals[userid_b] >= 3) break;
    }

    const winner1 = first_server;
    const loser1 = first_conn_is_a ? userid_b : userid_a;
    const result1_i = await WaitInLog(log_a, "GAME_RESULT", (RESULT_DELAY_SEC + 2) * 1000, last_goal_i);
    const result1_delay = result1_i === -1 ? -1 : log_a[result1_i].at - log_a[last_goal_i].at;
    checker.Check(`마지막 골 뒤 약 ${RESULT_DELAY_SEC}초 뒤 GAME_RESULT`, result1_delay >= RESULT_DELAY_SEC * 1000 - 300 && result1_delay <= RESULT_DELAY_SEC * 1000 + 800, `${result1_delay}ms`);
    checker.Check("마지막 골과 GAME_RESULT 사이에 ONE_START 가 없다", !log_a.slice(last_goal_i, result1_i).some((e) => e.type === "ONE_START"));
    const result1 = log_a[result1_i]?.payload;
    checker.Check("승자 = 첫 서버: win_count 3, score 15", result1?.winner?.userid === winner1 && result1?.winner?.win_count === 3 && result1?.winner?.score === 15, JSON.stringify(result1?.winner));
    checker.Check("패자: win_count 2, score 10 (패자도 골 × 5)", result1?.loser?.userid === loser1 && result1?.loser?.win_count === 2 && result1?.loser?.score === 10, JSON.stringify(result1?.loser));
    checker.Check("draw:\"N\" — 무승부가 아니다 (draw 는 항상 온다)", result1?.draw === "N", String(result1?.draw));
    checker.Check("B 도 GAME_RESULT 를 받았다", (await WaitInLog(log_b, "GAME_RESULT", 2000, reconnect_i_b)) !== -1);

    // --- 7) 재게임 → B 퇴장 → 봇이 B 레버로 골 → GAME_RESULT → OUT_USER ---
    console.log("\n[7] 재게임 → 첫 서브 교대 → B 가 GAME_START 직후 나감 → 봇이 대신 쳐서 3골 → GAME_RESULT 직후 OUT_USER");
    const before_replay = log_a.length;
    game_a.Send("GAME_RESULT", { payload: { replay: "Y" } });
    game_b.Send("GAME_RESULT", { payload: { replay: "Y" } });
    const serve2_i = await WaitInLog(log_a, "SERVE_SELECT", 3000, before_replay);
    checker.Check("둘 다 재게임 → SERVE_SELECT 부터 다시 (READY 없이)", serve2_i !== -1);
    checker.Check("재게임 첫 서브는 탁구처럼 교대 — 직전 게임에서 리시브로 시작한 쪽", log_a[serve2_i]?.payload?.userid === loser1, `직전 첫 서버 ${first_conn_is_a ? "A" : "B"} → 이번 ${log_a[serve2_i]?.payload?.userid === userid_a ? "A" : "B"}`);
    const start2_i = await WaitInLog(log_a, "GAME_START", (SERVE_SELECT_DELAY_SEC + 3) * 1000, serve2_i);
    checker.Check("SERVE_SELECT 뒤 GAME_START", start2_i !== -1);
    game_b.Leave();
    LeverTo(game_a, -300, -580); // 구석으로 비켜서 봇이 넣게 둔다

    // 판마다 A 가 서브할 차례면 퍽을 살짝 넘겨 준다 — 받는 쪽(봇)은 중앙선을 못 넘어 A 쪽 퍽에 닿지 못하므로,
    // 안 넘겨 주면 정체 재시작만 반복하다 무효가 된다(서브 규칙이 의도한 동작).
    let scan_a = start2_i;
    let result2_i = -1;
    const deadline2 = Date.now() + 90000;
    while (Date.now() < deadline2) {
        const next_i = await WaitInLogAny(log_a, ["ONE_START", "GAME_RESULT"], deadline2 - Date.now(), scan_a);
        if (next_i === -1) break;
        scan_a = next_i + 1;
        if (log_a[next_i].type === "GAME_RESULT") {
            result2_i = next_i;
            break;
        }
        if (log_a[next_i].payload?.serve === userid_a) await PokeServe(game_a);
        else LeverTo(game_a, -300, -580); // 판의 첫 입력 = 구석에 바로 놓임
    }
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
        // 1게임은 첫 서버가 3:2 로 이긴다. 잠깐 끊겼다 돌아온 B 는 is_bot 이 아니다(승자든 패자든)
        const b_is_bot_1 = winner1 === userid_b ? logs[0].win_is_bot : logs[0].lose_is_bot;
        checker.Check("1게임: 첫 서버 승, vs '3:2', score 15, plays 5골, 잠깐 끊긴 B 는 is_bot 아님", logs[0].win === winner1 && logs[0].vs === "3:2" && logs[0].score === 15 && Number(logs[0].play_count) === 5 && b_is_bot_1 === 0, JSON.stringify(logs[0]));
        checker.Check("2게임: 나간 B 승, vs '3:0', win_is_bot=1", logs[1].win === userid_b && logs[1].vs === "3:0" && logs[1].win_is_bot === 1 && logs[1].lose_is_bot === 0, JSON.stringify(logs[1]));
    }

    // 기댓값: 1게임 승자 15점·패자 10점, 2게임 B 15점·A 0점
    const expect_wins_a = winner1 === userid_a ? 1 : 0;
    const expect_wins_b = (winner1 === userid_b ? 1 : 0) + 1;
    const expect_score_a = winner1 === userid_a ? 15 : 10;
    const expect_score_b = (winner1 === userid_b ? 15 : 10) + 15;
    const [plays] = await pool.query(`SELECT userid, total_game_count, total_win_count, total_score FROM airhockey_user_play_info WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    const play_a = plays.find((p) => p.userid === userid_a);
    const play_b = plays.find((p) => p.userid === userid_b);
    checker.Check(`play_info: 둘 다 2게임, A ${expect_wins_a}승 / B ${expect_wins_b}승`, plays.length === 2 && plays.every((p) => p.total_game_count === 2) && play_a?.total_win_count === expect_wins_a && play_b?.total_win_count === expect_wins_b, JSON.stringify(plays));
    checker.Check(`play_info: A 누적 ${expect_score_a}점, B 누적 ${expect_score_b}점`, play_a?.total_score === expect_score_a && play_b?.total_score === expect_score_b, JSON.stringify(plays));
    const [ranks] = await pool.query(`SELECT userid, score FROM airhockey_rank_daily WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    checker.Check(`airhockey_rank_daily: A ${expect_score_a}점, B ${expect_score_b}점`, ranks.find((r) => r.userid === userid_a)?.score === expect_score_a && ranks.find((r) => r.userid === userid_b)?.score === expect_score_b, JSON.stringify(ranks));

    game_a.Leave();
    checker.Report();
}

// MODE=invalid — 첫 서버가 서브를 안 해 10초 뒤 서브권이 넘어간다(정체 횟수에 안 셈). 넘겨받은 유저는 판마다 살살
// 서브만 하고 방치 → 정체 재시작 3번(같은 서버) → 4번째 정체에서 즉시 무승부 결과 GAME_RESULT{draw:"Y"}
// → 일반 결과와 같은 재게임 선택(A 는 N 으로 즉시 로비, B 는 무응답 10초 뒤 로비). 별도 알림 메시지는 없고 기록도 없다.
async function CheckInvalidByStuck(game_a, game_b, log_a, log_b, start_i) {
    const first_server = LastOf(log_a, "SERVE_SELECT")?.userid;
    const second_server = first_server === userid_a ? userid_b : userid_a;
    const second_conn = second_server === userid_a ? game_a : game_b;
    console.log(`\n[무효] 첫 서버 ${first_server === userid_a ? "A" : "B"} 서브 안 함 → ${SERVE_TIMEOUT_SEC}초 뒤 서브권 넘김 → 넘겨받은 유저가 살살 서브 후 방치 × ${STUCK_MAX_RESTARTS + 1} → GAME_RESULT{draw:"Y"}`);

    const one1_i = await WaitInLog(log_a, "ONE_START", (GAME_START_DELAY_SEC + 2) * 1000, start_i);
    const pass_i = await WaitInLog(log_a, "ONE_START", (SERVE_TIMEOUT_SEC + 3) * 1000, one1_i + 1);
    const pass_delay = pass_i === -1 || one1_i === -1 ? -1 : log_a[pass_i].at - log_a[one1_i].at;
    checker.Check(`첫 서버가 ${SERVE_TIMEOUT_SEC}초간 서브 안 함 → ONE_START 다시, 서브권 넘어감`, pass_i !== -1 && Math.abs(pass_delay - SERVE_TIMEOUT_SEC * 1000) <= 800 && log_a[pass_i]?.payload?.serve === second_server, `${pass_delay}ms ${JSON.stringify(log_a[pass_i]?.payload)}`);

    // 넘겨받은 유저가 판마다 살살 서브 → 퍽이 멈춰 정체 → 같은 서버로 다시 (서브 넘김은 횟수에 안 들어가므로 3번 재시작 뒤 4번째에 무효)
    let scan_i = pass_i;
    let result_a_i = -1;
    const restart_servers = [];
    const deadline = Date.now() + (STUCK_MAX_RESTARTS + 1) * (STUCK_RESET_SEC + 15) * 1000;
    while (pass_i !== -1 && Date.now() < deadline) {
        await GentleServe(second_conn);
        const next_i = await WaitInLogAny(log_a, ["ONE_START", "GAME_RESULT", "ONE_RESULT"], deadline - Date.now(), scan_i + 1);
        if (next_i === -1) break;
        scan_i = next_i;
        if (log_a[next_i].type !== "ONE_START") {
            if (log_a[next_i].type === "GAME_RESULT") result_a_i = next_i;
            break;
        }
        restart_servers.push(log_a[next_i].payload?.serve);
    }
    checker.Check(`서브한 뒤 정체 재시작 ${STUCK_MAX_RESTARTS}번 — 모두 같은 서버(넘겨받은 유저)`, restart_servers.length === STUCK_MAX_RESTARTS && restart_servers.every((u) => u === second_server), JSON.stringify(restart_servers.map((u) => (u === userid_a ? "A" : "B"))));

    const result_i = {};
    for (const [name, log, userid] of [["A", log_a, userid_a], ["B", log_b, userid_b]]) {
        const ri = name === "A" ? result_a_i : await WaitInLog(log, "GAME_RESULT", 3000);
        result_i[name] = ri;
        checker.Check(`${name}: 4번째 정체에서 GAME_RESULT 를 받았다 (무효 판정 즉시)`, ri !== -1);
        const one_starts = log.filter((e) => e.type === "ONE_START").length;
        checker.Check(`${name}: ONE_START ${STUCK_MAX_RESTARTS + 2}번 (처음 1 + 서브 넘김 1 + 정체 재시작 ${STUCK_MAX_RESTARTS})`, one_starts === STUCK_MAX_RESTARTS + 2, `${one_starts}번`);
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
    for (const t of ["airhockey_rank_daily", "airhockey_rank_weekly", "airhockey_user_play_info", "flag_user_play_info", "stepping_user_play_info", "othello_user_play_info", "rps_user_play_info", "user_member_info", "user_partner_info"]) {
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
