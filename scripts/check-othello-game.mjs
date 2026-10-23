// 오델로 한 게임을 끝까지 두는 e2e 검증 스크립트 (2026-10-07).
//
// 검증 대상:
//   1) 로비 매칭 — JOIN_MATCH{game:"othello"} → MATCH_FOUND{game:"othello", room_name:"othello_N"}
//   2) 게임방 입장 — 좌석 예약으로 오델로 채널 접속 → ENTER_ROOM → READY → GAME_START
//   3) 돌 색 선택 — DOLL_SELECT{color} → DOLL_SELECT{select:{0:userid,1:userid}}
//   4) 턴 루프 — TURN_START{turn,can} → SELECT_GAME{select:{x,y}} → SELECT_GAME{select,change}
//      · 매 수의 change(뒤집히는 돌)가 클라이언트가 같은 규칙으로 계산한 값과 일치하는지
//      · 패스 시 turn 이 연속으로 같은 유저인지
//   5) 종료 — GAME_RESULT{winner,loser,draw?} 의 win_count(최종 돌 개수) 합이 보드 돌 수와 일치
//   6) DB 반영 — othello_game_log 1행 + othello_user_play_info / othello_rank_* 갱신
//
// ⚠️ 이 스크립트는 지우지 말 것. 과거 검증 스크립트를 전부 임시로 만들고 삭제해서 재현이 불가능해진
//    문제(TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 17곳)를 되풀이하지 않기 위해 남겨 둔다.
//
// ⚠️ **DB 에 테스트 유저 2명을 만든다.** 끝나고 자기가 만든 행만 지운다(TEST_PARTNER 접두사로만 삭제).
//    KEEP=1 로 실행하면 정리를 건너뛴다.
//
// 사용법 (로비와 오델로 채널이 떠 있어야 한다):
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> OTHELLO_PORT=6031 node scripts/check-othello-game.mjs
//
// ⚠️ LOBBY_ROOM_ID 를 주는 게 좋다 — joinOrCreate 는 같은 Redis 를 쓰는 다른 프로세스의 방을 골라
//    "고치기 전 코드를 통과로 오판"할 수 있다(colyseus-test-client.mjs ReserveSeat 주석 참고).

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

// 기존 유저(partner=ocb 등)와 겹치지 않는 접두사. 정리할 때 이 값으로만 지운다.
const TEST_PARTNER = "zzoth";
const run_tag = String(Date.now()).slice(-8);

const checker = client.CreateChecker();

// --- 오델로 규칙(클라이언트 쪽 독립 구현) ---
// 서버가 보내는 change 가 맞는지 검증하려면 **서버 코드를 쓰지 않고** 같은 규칙을 따로 계산해야 한다.
// (서버 모듈을 import 하면 서버가 틀려도 똑같이 틀리게 계산해서 검증이 무의미해진다)
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

function GetLegalMoves(board, color) {
    const moves = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (GetFlips(board, x, y, color).length > 0) moves.push({ x, y });
    return moves;
}

function ApplyMove(board, x, y, color) {
    const flips = GetFlips(board, x, y, color);
    board[y][x] = color;
    for (const p of flips) board[p.y][p.x] = color;
    return flips;
}

function CountStones(board) {
    let black = 0;
    let white = 0;
    for (const row of board) for (const cell of row) {
        if (cell === BLACK) black++;
        else if (cell === WHITE) white++;
    }
    return { black, white };
}

function ToKeySet(points) {
    return new Set(points.map((p) => `${p.x},${p.y}`));
}

function SameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
}

// common/userid.ts 의 ConvertMidToUserid 와 같은 규칙 (XOR key 5)
function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}

// 로비에 들어가서 오델로 매칭을 신청한다. MATCH_FOUND payload 를 돌려준다.
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
    const enter_result = await entered;
    if (enter_result?.result !== "Y") throw new Error(`ENTER_LOBBY 실패: ${JSON.stringify(enter_result)}`);

    // MATCH_FOUND 는 상대가 들어온 뒤에 오므로 대기를 먼저 걸어 둔다
    const match_wait = client.WaitForMessage(conn, "MATCH_FOUND", 15000);
    conn.Send("JOIN_MATCH", { payload: { game: "othello", select: "Y" } });
    return { conn, userid: enter_result.userid, match_wait };
}

async function Main() {
    console.log(`오델로 e2e 검증 시작 — lobby ws://${host}:${lobby_port}, othello ws://${host}:${othello_port}`);
    console.log(`테스트 계정: partner='${TEST_PARTNER}', mid='a${run_tag}' / 'b${run_tag}'\n`);

    // --- 1) 로비 매칭 ---
    console.log('[1] JOIN_MATCH{game:"othello"} 로 매칭되어야 한다');
    const mid_a = `a${run_tag}`;
    const mid_b = `b${run_tag}`;
    const player_a = await JoinLobbyAndMatch(mid_a);
    const player_b = await JoinLobbyAndMatch(mid_b);
    const [match_a, match_b] = await Promise.all([player_a.match_wait, player_b.match_wait]);

    checker.Check("두 유저 모두 MATCH_FOUND 를 받았다", match_a !== undefined && match_b !== undefined, JSON.stringify({ a: match_a?.room_name, b: match_b?.room_name }));
    checker.Check('응답에 game:"othello" 가 담겨 있다 (2026-10-07 통신규약)', match_a?.game === "othello", `game=${match_a?.game}`);
    checker.Check('room_name 이 "othello_1" 이다', match_a?.room_name === "othello_1", `room_name=${match_a?.room_name}`);
    checker.Check("둘이 같은 방으로 매칭됐다", match_a?.room_id === match_b?.room_id, `${match_a?.room_id} vs ${match_b?.room_id}`);
    player_a.conn.Close();
    player_b.conn.Close();

    if (!match_a || !match_b) {
        checker.Report();
        return;
    }

    // --- 2) 게임방 입장 → READY → GAME_START ---
    console.log("\n[2] 좌석 예약으로 오델로 채널에 입장 → ENTER_ROOM → READY → GAME_START");
    const game_a = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_a.seat_reservation });
    const game_b = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_b.seat_reservation });
    if (!game_a.ok || !game_b.ok) throw new Error(`오델로 채널 접속 실패: ${JSON.stringify({ a: game_a, b: game_b })}`);

    const enter_a = client.WaitForMessage(game_a, "ENTER_ROOM", 8000);
    const enter_b = client.WaitForMessage(game_b, "ENTER_ROOM", 8000);
    game_a.Send("ENTER_ROOM", { payload: {} });
    game_b.Send("ENTER_ROOM", { payload: {} });
    const [room_a, room_b] = await Promise.all([enter_a, enter_b]);
    checker.Check("양쪽이 ENTER_ROOM 응답을 받았다", room_a?.result === "Y" && room_b?.result === "Y", JSON.stringify(room_a));

    const start_a = client.WaitForMessage(game_a, "GAME_START", 8000);
    const start_b = client.WaitForMessage(game_b, "GAME_START", 8000);
    game_a.Send("READY", { payload: { ready: "Y" } });
    game_b.Send("READY", { payload: { ready: "Y" } });
    const [started_a, started_b] = await Promise.all([start_a, start_b]);
    checker.Check("양쪽이 GAME_START 를 받았다", started_a !== undefined && started_b !== undefined, "");

    // --- 3) 돌 색 선택 ---
    // GAME_START 후 OTHELLO_GAME_START_DELAY_SEC(5초) 뒤에 돌 선택 단계가 열린다.
    console.log("\n[3] DOLL_SELECT — 한쪽이 고르면 상대는 반대 색으로 자동 정리되어야 한다");
    const doll_a = client.WaitForMessage(game_a, "DOLL_SELECT", 15000);
    const doll_b = client.WaitForMessage(game_b, "DOLL_SELECT", 15000);
    // 돌 선택 단계가 열릴 때까지 기다린 뒤 A 가 검정(1, 선공)을 고른다
    await new Promise((resolve) => setTimeout(resolve, 6500));
    game_a.Send("DOLL_SELECT", { payload: { color: BLACK } });
    const [select_a, select_b] = await Promise.all([doll_a, doll_b]);

    const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
    const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);
    checker.Check("DOLL_SELECT 결과를 양쪽이 받았다", select_a !== undefined && select_b !== undefined, JSON.stringify(select_a));
    checker.Check(
        "A 가 고른 검정(1)이 A 에게, 흰색(0)이 B 에게 배정됐다",
        select_a?.select?.["1"] === userid_a && select_a?.select?.["0"] === userid_b,
        JSON.stringify(select_a?.select)
    );

    const color_by_userid = { [userid_a]: BLACK, [userid_b]: WHITE };
    const conn_by_userid = { [userid_a]: game_a, [userid_b]: game_b };

    // --- 4) 턴 루프 ---
    console.log("\n[4] 턴 루프 — 매 수의 change 가 클라이언트 계산과 일치해야 한다");
    const board = CreateBoard();
    let move_count = 0;
    let pass_count = 0;
    let previous_turn = null;
    let change_mismatch = 0;
    let illegal_can = 0;
    let game_result;

    // TURN_START / SELECT_GAME / GAME_RESULT 를 양쪽 연결에서 모두 받되, 진행은 A 연결 기준으로 한다.
    const turn_queue = [];
    let turn_waiter = null;
    const PushTurn = (payload) => {
        if (turn_waiter) {
            const resolve = turn_waiter;
            turn_waiter = null;
            resolve(payload);
        } else {
            turn_queue.push(payload);
        }
    };
    const NextTurn = (timeout_ms = 20000) =>
        new Promise((resolve) => {
            if (turn_queue.length > 0) return resolve(turn_queue.shift());
            turn_waiter = resolve;
            setTimeout(() => {
                if (turn_waiter === resolve) {
                    turn_waiter = null;
                    resolve(undefined);
                }
            }, timeout_ms);
        });

    game_a.OnMessage((decoded) => {
        const payload = client.TakePayload(decoded);
        if (decoded.type === "TURN_START") PushTurn({ kind: "turn", payload });
        else if (decoded.type === "SELECT_GAME") PushTurn({ kind: "select", payload });
        else if (decoded.type === "GAME_RESULT") PushTurn({ kind: "result", payload });
    });

    // 첫 TURN_START 는 돌 선택 후 OTHELLO_DOLL_SELECT_DELAY_SEC(5초) 뒤에 온다
    let event = await NextTurn(20000);
    while (event !== undefined) {
        if (event.kind === "turn") {
            const turn_userid = event.payload?.turn;
            const can = event.payload?.can ?? [];
            const color = color_by_userid[turn_userid];

            // 서버가 준 can 이 클라이언트 계산과 같은지
            const expected_can = GetLegalMoves(board, color);
            if (!SameSet(ToKeySet(can), ToKeySet(expected_can))) illegal_can++;

            // 같은 사람이 연속으로 턴을 받으면 상대가 패스한 것이다 (사용자 결정: PASS 메시지 없음)
            if (previous_turn !== null && previous_turn === turn_userid) pass_count++;
            previous_turn = turn_userid;

            if (can.length === 0) break; // 있을 수 없다 — 서버가 can 이 빈 TURN_START 를 보내면 안 된다
            const move = can[0];
            conn_by_userid[turn_userid].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (event.kind === "select") {
            const { userid, x, y } = event.payload?.select ?? {};
            const change = event.payload?.change ?? [];
            const color = color_by_userid[userid];

            const expected_flips = ApplyMove(board, x, y, color);
            if (!SameSet(ToKeySet(change), ToKeySet(expected_flips))) {
                change_mismatch++;
                console.log(`    ⚠️ change 불일치 (${x},${y}) 서버=${JSON.stringify(change)} 기대=${JSON.stringify(expected_flips)}`);
            }
            move_count++;
        } else if (event.kind === "result") {
            game_result = event.payload;
            break;
        }
        event = await NextTurn(20000);
    }

    checker.Check("게임이 GAME_RESULT 까지 진행됐다", game_result !== undefined, `둔 수=${move_count}, 패스=${pass_count}`);
    checker.Check("매 수의 change 가 클라이언트 계산과 모두 일치했다", change_mismatch === 0, `불일치 ${change_mismatch}건 / 총 ${move_count}수`);
    checker.Check("TURN_START 의 can(합법수)이 모두 일치했다", illegal_can === 0, `불일치 ${illegal_can}건`);

    // --- 5) 최종 결과 검증 ---
    console.log("\n[5] GAME_RESULT — win_count(최종 돌 개수) 가 보드와 일치해야 한다");
    if (game_result) {
        const counts = CountStones(board);
        const total_from_result = (game_result.winner?.win_count ?? 0) + (game_result.loser?.win_count ?? 0);
        checker.Check(
            "win_count 합이 보드의 돌 수와 같다",
            total_from_result === counts.black + counts.white,
            `결과합=${total_from_result} 보드=${counts.black + counts.white} (흑 ${counts.black} / 백 ${counts.white})`
        );
        checker.Check(
            "승자의 돌이 패자보다 많다 (무승부면 draw:Y)",
            game_result.draw === "Y"
                ? game_result.winner.win_count === game_result.loser.win_count
                : game_result.winner.win_count > game_result.loser.win_count,
            `winner=${game_result.winner?.win_count} loser=${game_result.loser?.win_count} draw=${game_result.draw ?? "없음"}`
        );
        console.log(`    최종: ${game_result.winner?.userid}=${game_result.winner?.win_count} / ${game_result.loser?.userid}=${game_result.loser?.win_count}${game_result.draw === "Y" ? " (무승부)" : ""}`);
    }

    // --- 6) DB 반영 ---
    console.log("\n[6] DB 반영 — othello_game_log / play_info / rank");
    await new Promise((resolve) => setTimeout(resolve, 1500)); // DB 저장은 GAME_RESULT 전송 뒤에 비동기로 진행된다

    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/othelloGameLogSchema.js");
    const table = log_mod.GetOthelloGameLogTableName(new Date());

    const [logs] = await pool.query(
        `SELECT win, lose, vs, score, is_draw, JSON_LENGTH(plays) AS play_count FROM \`${table}\` WHERE win LIKE ? OR lose LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${TEST_PARTNER}_%`, `${TEST_PARTNER}_%`]
    );
    checker.Check("othello_game_log 에 이 게임이 기록됐다", logs.length === 1, JSON.stringify(logs[0] ?? null));
    if (logs.length === 1) {
        checker.Check("plays(수순) 개수가 실제 둔 수와 같다", Number(logs[0].play_count) === move_count, `DB=${logs[0].play_count} 실제=${move_count}`);
        checker.Check("vs 가 '승자돌:패자돌' 형식이다", /^\d{1,2}:\d{1,2}$/.test(String(logs[0].vs)), `vs=${logs[0].vs}`);
    }

    const [plays] = await pool.query(
        `SELECT userid, total_game_count, total_win_count, total_score FROM othello_user_play_info WHERE userid LIKE ?`,
        [`${TEST_PARTNER}_%`]
    );
    checker.Check("othello_user_play_info 가 두 유저 모두 1게임으로 갱신됐다", plays.length === 2 && plays.every((p) => p.total_game_count === 1), JSON.stringify(plays));

    const [ranks] = await pool.query(`SELECT userid, score FROM othello_rank_daily WHERE userid LIKE ?`, [`${TEST_PARTNER}_%`]);
    checker.Check("othello_rank_daily 에 두 유저 행이 생겼다", ranks.length === 2, JSON.stringify(ranks));

    game_a.Close();
    game_b.Close();
    checker.Report();

    // --- 정리 ---
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        console.log(`\n정리 (partner='${TEST_PARTNER}' 인 행만):`);
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
        }
        redis_mod.GetRedisClient().disconnect();
        console.log("  Redis 캐시 삭제 완료");
    }
    await pool.end();
}

await Main();
