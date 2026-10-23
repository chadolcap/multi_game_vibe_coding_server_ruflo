// 오델로 게임 중 재접속 + GAME_STATUS 검증 스크립트 (2026-10-08).
//
// 검증 대상 (시트 othello 19행: "게임 중 재접속 유저에게 현재 상태 전달 / 재접속 당사자에게만 전달"):
//   1) 게임 중 한쪽 연결을 끊고 client.reconnect() 로 같은 방에 재접속한다
//   2) 재접속 후 ENTER_ROOM 을 다시 보내면 ENTER_ROOM 응답 + **GAME_STATUS** 가 온다
//   3) GAME_STATUS 의 select/status0/status1 이 그 시점 보드와 정확히 일치한다
//   4) **상대에게는 GAME_STATUS 가 가지 않는다** (재접속 당사자에게만)
//   5) 재접속한 유저가 이어서 정상적으로 수를 둘 수 있다
//
// ⚠️ 이 스크립트는 지우지 말 것 (TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 재현 불가 문제 방지).
//
// ⚠️ DB 에 테스트 유저 2명을 만든다. 끝나고 TEST_PARTNER 접두사 행만 지운다(KEEP=1 로 생략).
//
// 사용법:
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> OTHELLO_PORT=6031 node scripts/check-othello-reconnect.mjs

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
const othello_port = Number(process.env.OTHELLO_PORT ?? 6031);
const keep_rows = process.env.KEEP === "1";

const TEST_PARTNER = "zzrec";
const run_tag = String(Date.now()).slice(-8);

const checker = client.CreateChecker();

// --- 오델로 규칙(클라이언트 쪽 독립 구현, check-othello-game.mjs 와 같은 이유) ---
const EMPTY = -1;
const WHITE = 0;
const BLACK = 1;
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function CreateBoard() {
    const board = Array.from({ length: 8 }, () => new Array(8).fill(EMPTY));
    board[3][3] = WHITE;
    board[4][4] = WHITE;
    board[3][4] = BLACK;
    board[4][3] = BLACK;
    return board;
}

function GetFlips(board, x, y, color) {
    if (x < 0 || x > 7 || y < 0 || y > 7 || board[y][x] !== EMPTY) return [];
    const opponent = color === BLACK ? WHITE : BLACK;
    const flips = [];
    for (const [dx, dy] of DIRS) {
        const line = [];
        let cx = x + dx;
        let cy = y + dy;
        while (cx >= 0 && cx <= 7 && cy >= 0 && cy <= 7 && board[cy][cx] === opponent) {
            line.push({ x: cx, y: cy });
            cx += dx;
            cy += dy;
        }
        if (line.length > 0 && cx >= 0 && cx <= 7 && cy >= 0 && cy <= 7 && board[cy][cx] === color) flips.push(...line);
    }
    return flips;
}

function ApplyMove(board, x, y, color) {
    const flips = GetFlips(board, x, y, color);
    board[y][x] = color;
    for (const p of flips) board[p.y][p.x] = color;
    return flips;
}

function StonePositions(board, color) {
    const out = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (board[y][x] === color) out.push({ x, y });
    return out;
}

function ToKeySet(points) {
    return new Set((points ?? []).map((p) => `${p.x},${p.y}`));
}

function SameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
}

function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}

async function JoinLobbyAndMatch(mid) {
    const reservation = await client.ReserveSeat({
        host,
        port: lobby_port,
        room_name: `lobby_${lobby_channel_no}`,
        room_id: lobby_room_id,
    });
    const conn = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!conn.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(conn)}`);

    const entered = client.WaitForMessage(conn, "ENTER_LOBBY", 6000);
    conn.Send("ENTER_LOBBY", { payload: { partner: TEST_PARTNER, mid, gender: "M", phone: "01000000000" } });
    const result = await entered;
    if (result?.result !== "Y") throw new Error(`ENTER_LOBBY 실패: ${JSON.stringify(result)}`);

    const match_wait = client.WaitForMessage(conn, "MATCH_FOUND", 15000);
    conn.Send("JOIN_MATCH", { payload: { game: "othello", select: "Y" } });
    return { conn, match_wait };
}

async function Main() {
    console.log(`오델로 재접속/GAME_STATUS 검증 시작 — lobby ws://${host}:${lobby_port}, othello ws://${host}:${othello_port}\n`);

    const mid_a = `a${run_tag}`;
    const mid_b = `b${run_tag}`;
    const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
    const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);

    // --- 매칭 + 게임 시작 ---
    console.log("[1] 매칭 → 게임 시작 → 돌 색 선택");
    const p_a = await JoinLobbyAndMatch(mid_a);
    const p_b = await JoinLobbyAndMatch(mid_b);
    const [match_a, match_b] = await Promise.all([p_a.match_wait, p_b.match_wait]);
    p_a.conn.Close();
    p_b.conn.Close();
    if (!match_a || !match_b) throw new Error("MATCH_FOUND 를 받지 못했습니다");

    let game_a = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_a.seat_reservation });
    const game_b = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_b.seat_reservation });
    if (!game_a.ok || !game_b.ok) throw new Error("오델로 채널 접속 실패");

    const enter_a = client.WaitForMessage(game_a, "ENTER_ROOM", 8000);
    const enter_b = client.WaitForMessage(game_b, "ENTER_ROOM", 8000);
    game_a.Send("ENTER_ROOM", { payload: {} });
    game_b.Send("ENTER_ROOM", { payload: {} });
    await Promise.all([enter_a, enter_b]);

    const start_a = client.WaitForMessage(game_a, "GAME_START", 8000);
    game_a.Send("READY", { payload: { ready: "Y" } });
    game_b.Send("READY", { payload: { ready: "Y" } });
    await start_a;

    const doll_a = client.WaitForMessage(game_a, "DOLL_SELECT", 15000);
    await new Promise((r) => setTimeout(r, 6500));
    game_a.Send("DOLL_SELECT", { payload: { color: BLACK } }); // A = 검정(선공)
    const doll = await doll_a;
    checker.Check("게임이 시작되고 돌 색이 배정됐다", doll?.select?.["1"] === userid_a, JSON.stringify(doll?.select));

    const color_by_userid = { [userid_a]: BLACK, [userid_b]: WHITE };
    const conn_by_userid = { [userid_a]: game_a, [userid_b]: game_b };
    const board = CreateBoard();

    // --- 몇 수 진행 (보드를 초기 상태에서 벗어나게 해서 GAME_STATUS 검증이 의미 있게 한다) ---
    console.log("\n[2] 몇 수 진행해서 보드를 바꾼다");
    const MOVES_BEFORE_DROP = 3;
    let moves_done = 0;
    let turn_payload;

    // B 쪽에도 핸들러를 걸어, 나중에 "상대에게는 GAME_STATUS 가 안 간다"를 확인한다
    let b_got_game_status = false;
    game_b.OnMessage((decoded) => {
        if (decoded.type === "GAME_STATUS") b_got_game_status = true;
    });

    const turn_queue_a = [];
    let waiter_a = null;
    const PushA = (v) => {
        if (waiter_a) {
            const r = waiter_a;
            waiter_a = null;
            r(v);
        } else turn_queue_a.push(v);
    };
    const NextA = (ms = 20000) =>
        new Promise((resolve) => {
            if (turn_queue_a.length > 0) return resolve(turn_queue_a.shift());
            waiter_a = resolve;
            setTimeout(() => {
                if (waiter_a === resolve) {
                    waiter_a = null;
                    resolve(undefined);
                }
            }, ms);
        });
    const AttachA = (conn) => {
        conn.OnMessage((decoded) => {
            const payload = client.TakePayload(decoded);
            if (decoded.type === "TURN_START") PushA({ kind: "turn", payload });
            else if (decoded.type === "SELECT_GAME") PushA({ kind: "select", payload });
            else if (decoded.type === "GAME_STATUS") PushA({ kind: "status", payload });
        });
    };
    AttachA(game_a);

    while (moves_done < MOVES_BEFORE_DROP) {
        const ev = await NextA();
        if (ev === undefined) break;
        if (ev.kind === "turn") {
            turn_payload = ev.payload;
            const move = ev.payload.can?.[0];
            if (move) conn_by_userid[ev.payload.turn].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (ev.kind === "select") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board, x, y, color_by_userid[userid]);
            moves_done++;
        }
    }
    checker.Check(`${MOVES_BEFORE_DROP}수를 진행했다`, moves_done === MOVES_BEFORE_DROP, `진행=${moves_done}`);

    // ⚠️ 수를 둔 직후에 끊으면 "SELECT_GAME 결과 → 2초 → 다음 TURN_START" 의 **공백 구간**에 재접속해서
    //    turn/can 이 생략된 경로만 검증된다(처음에 그렇게 돌렸다). 다음 TURN_START 를 받고 나서 끊어야
    //    턴이 활성인 상태로 재접속해 turn/can 이 채워지는 경로를 검증할 수 있다.
    //    턴 제한 시간(10초)이 흐르는 중이므로 아래 끊기→재접속→ENTER_ROOM 은 그 안에 끝나야 한다.
    let dropped_during_active_turn = false;
    for (let i = 0; i < 3; i++) {
        const ev = await NextA(20000);
        if (ev === undefined) break;
        if (ev.kind === "turn") {
            turn_payload = ev.payload;
            dropped_during_active_turn = true;
            break; // 수를 두지 않고 그대로 끊는다 — 턴이 활성인 채로 재접속하기 위해
        }
        if (ev.kind === "select") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board, x, y, color_by_userid[userid]);
            moves_done++;
        }
    }
    checker.Check("턴이 활성인 시점을 잡았다 (turn/can 검증을 위해)", dropped_during_active_turn, dropped_during_active_turn ? `turn=${turn_payload?.turn}` : "TURN_START 를 못 받았다");

    // --- 3) A 의 연결을 끊고 재접속 ---
    console.log("\n[3] A 의 연결을 끊고 같은 방으로 재접속한다");
    // ⚠️ 우리 최소 클라이언트는 reconnectionToken 을 따로 보관하지 않는다 — 서버가 Redis(activeGame)에
    //    저장해 둔 토큰을 그대로 읽어 쓴다(로비의 REJOIN_GAME 이 클라이언트에게 주는 값과 같은 것).
    //    F5 재접속 경로와 사실상 동일하다.
    const activeGame = await import("../dist/game/room/activeGame.js");
    const active = await activeGame.GetActiveGame(userid_a);
    checker.Check("Redis 에 A 의 activeGame 기록이 있다", active !== null, JSON.stringify(active));
    if (!active) {
        checker.Report();
        return;
    }

    game_a.socket.close(); // 동의 없는 종료 → 서버는 onDrop 으로 재접속 창을 연다
    await new Promise((r) => setTimeout(r, 1200));

    const reconnected = await client.ConnectWithSeat({
        host,
        port: othello_port,
        reservation: {
            processId: match_a.seat_reservation.processId,
            roomId: active.room_id,
            sessionId: match_a.seat_reservation.sessionId,
        },
        reconnection_token: active.reconnection_token,
        timeout_ms: 8000,
    });
    checker.Check("같은 방으로 재접속했다", reconnected.ok === true, JSON.stringify(reconnected).slice(0, 160));

    if (!reconnected.ok) {
        checker.Report();
        return;
    }

    // --- 4) ENTER_ROOM 재요청 → ENTER_ROOM + GAME_STATUS ---
    console.log("\n[4] 재접속 후 ENTER_ROOM 재요청 → ENTER_ROOM + GAME_STATUS 가 와야 한다");
    AttachA(reconnected);
    const re_enter = client.WaitForMessage(reconnected, "ENTER_ROOM", 8000);
    const status_wait = client.WaitForMessage(reconnected, "GAME_STATUS", 8000);
    reconnected.Send("ENTER_ROOM", { payload: {} });

    const re_room = await re_enter;
    checker.Check("ENTER_ROOM 응답을 다시 받았다 (상대 정보 복원)", re_room?.result === "Y", JSON.stringify(re_room).slice(0, 120));

    const status = await status_wait;
    checker.Check("GAME_STATUS 를 받았다", status !== undefined, status === undefined ? "수신 없음" : "수신");

    if (status) {
        checker.Check(
            "select 가 돌 색 배정과 일치한다",
            status.select?.["1"] === userid_a && status.select?.["0"] === userid_b,
            JSON.stringify(status.select)
        );
        checker.Check(
            "status1(검정) 좌표가 지금 보드와 일치한다",
            SameSet(ToKeySet(status.status1), ToKeySet(StonePositions(board, BLACK))),
            `서버 ${status.status1?.length}개 / 기대 ${StonePositions(board, BLACK).length}개`
        );
        checker.Check(
            "status0(흰색) 좌표가 지금 보드와 일치한다",
            SameSet(ToKeySet(status.status0), ToKeySet(StonePositions(board, WHITE))),
            `서버 ${status.status0?.length}개 / 기대 ${StonePositions(board, WHITE).length}개`
        );
        const total = (status.status0?.length ?? 0) + (status.status1?.length ?? 0);
        checker.Check("돌 개수 합이 지금까지 둔 수와 맞는다", total === 4 + moves_done, `합=${total} 기대=${4 + moves_done}`);

        // turn/can — 시트에 없는 확장(2026-10-08). 위에서 **턴이 활성인 시점에** 끊었으므로 반드시 와야 한다
        // (턴 공백 2초 구간에 걸리면 생략되는 게 정상이고, 그 경우는 아래 else 로 떨어진다).
        checker.Check("turn/can 이 담겨 왔다 (턴이 활성인 상태로 재접속했으므로)", status.turn !== undefined, `turn=${status.turn}`);
        if (status.turn !== undefined) {
            checker.Check(
                "turn 이 두 참가자 중 한 명이다",
                status.turn === userid_a || status.turn === userid_b,
                `turn=${status.turn}`
            );
            checker.Check(
                "turn 이 끊기기 전 TURN_START 의 turn 과 같다 (턴이 유지됐다)",
                status.turn === turn_payload?.turn,
                `GAME_STATUS=${status.turn} / 끊기기 전=${turn_payload?.turn}`
            );
            const expected_can = [];
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                    if (GetFlips(board, x, y, color_by_userid[status.turn]).length > 0) expected_can.push({ x, y });
                }
            }
            checker.Check(
                "can(놓을 수 있는 자리)이 그 유저 색의 합법수와 일치한다",
                SameSet(ToKeySet(status.can), ToKeySet(expected_can)),
                `서버 ${status.can?.length}개 / 기대 ${expected_can.length}개`
            );
            console.log(`    turn=${status.turn === userid_a ? "A(검정)" : "B(흰색)"}, can=${status.can?.length}개`);
        } else {
            // 턴 공백에 걸린 경우 — can 도 함께 없어야 한다(둘은 짝이다)
            checker.Check("turn 이 없으면 can 도 없다 (턴 공백 2초 구간)", status.can === undefined, `can=${JSON.stringify(status.can)}`);
            console.log("    (턴 공백 구간에 재접속해서 turn/can 이 생략됐다 — 정상)");
        }
    }

    // --- 5) 상대에게는 안 간다 ---
    console.log("\n[5] 상대(B)에게는 GAME_STATUS 가 가지 않아야 한다 (재접속 당사자에게만)");
    await new Promise((r) => setTimeout(r, 1000));
    checker.Check("B 는 GAME_STATUS 를 받지 않았다", b_got_game_status === false, b_got_game_status ? "받았다(문제)" : "안 받았다(정상)");

    // --- 6) 재접속한 유저가 이어서 둘 수 있다 ---
    console.log("\n[6] 재접속한 유저가 이어서 수를 둘 수 있어야 한다");
    conn_by_userid[userid_a] = reconnected;
    let moved_after_reconnect = false;
    for (let i = 0; i < 6; i++) {
        const ev = await NextA(25000);
        if (ev === undefined) break;
        if (ev.kind === "turn") {
            const move = ev.payload.can?.[0];
            if (move) conn_by_userid[ev.payload.turn].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (ev.kind === "select") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board, x, y, color_by_userid[userid]);
            if (userid === userid_a) {
                moved_after_reconnect = true;
                break;
            }
        }
    }
    checker.Check("재접속한 유저의 수가 정상 처리됐다", moved_after_reconnect, moved_after_reconnect ? "" : "수를 두지 못했다");

    reconnected.Close();
    game_b.Close();
    checker.Report();

    // --- 정리 ---
    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        console.log(`\n정리 (partner='${TEST_PARTNER}' 인 행만):`);
        const log_mod = await import("../dist/db/othelloGameLogSchema.js");
        const table = log_mod.GetOthelloGameLogTableName(new Date());
        await pool.query(`DELETE FROM \`${table}\` WHERE win LIKE ? OR lose LIKE ?`, [`${TEST_PARTNER}_%`, `${TEST_PARTNER}_%`]);
        for (const t of ["othello_rank_daily", "othello_rank_weekly", "rps_rank_daily", "rps_rank_weekly", "othello_user_play_info", "rps_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "flag_user_play_info", "user_member_info", "user_partner_info"]) {
            const [r] = await pool.query(`DELETE FROM ${t} WHERE userid LIKE ?`, [`${TEST_PARTNER}_%`]);
            if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
        }
        const redis_mod = await import("../dist/db/redis.js");
        for (const userid of [userid_a, userid_b]) {
            await redis_mod.DeleteJson(`user:info:${userid}`);
            await redis_mod.DeleteJson(`user:play:othello:${userid}`);
            await redis_mod.DeleteJson(`user:play:rps:${userid}`);
            await redis_mod.DeleteJson(`active_game:${userid}`);
        }
        redis_mod.GetRedisClient().disconnect();
        console.log("  Redis 캐시 삭제 완료");
    }
    await pool.end();
}

await Main();
