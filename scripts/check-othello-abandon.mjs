// 오델로 — 게임 중 한 명이 나간 뒤 재입장하지 않는 경우 검증 스크립트 (2026-10-12).
//
// 검증 대상 (사용자 요청 2026-10-12, 2026-10-13 규칙 조정):
//   1) 게임 중 B 가 나가도(재입장 없음) 게임이 멈추지 않는다
//   2) **나간 그 턴**은 제한 시간 10초를 끝까지 유지한다 (TURN_REMAIN_TIME 카운트다운 포함) —
//      그 턴 안에 돌아올 여지를 남기기 위한 것. B 가 **자기 턴에** 나가도록 시점을 잡아서 검증한다
//   3) **그 다음 턴부터** 제한 시간이 2초로 줄고, 사람 턴과 **같은 방식으로** TURN_REMAIN_TIME
//      카운트다운(count:1 → count:0)이 온다 (사용자 결정 2026-10-13)
//   4) 자동 착수도 `SELECT_GAME{select:{userid,x,y}, change:[…]}` 로, 그 유저가 둔 것과 같은 모양으로 온다
//   5) 나가는 순간에는 OUT_USER 가 **오지 않는다** (오면 클라이언트가 게임을 접어 버린다)
//   6) 게임이 끝나면 GAME_RESULT 에 **나간 유저 정보가 그대로** 담겨 남은 유저에게 간다
//   7) GAME_RESULT 뒤에 **나간 유저의 OUT_USER** 가 남은 유저에게 간다
//   8) DB 에 양쪽 모두의 승패가 반영된다 (othello_game_log 1행 + 두 유저의 othello_user_play_info)
//   9) 둘 다 나가면 그 시점 돌 수로 즉시 종료 + DB 기록
//  10) **자동 턴 중에 재입장하면 그 턴은 본인이 놓지 못하고, 다음 턴부터 놓을 수 있다**
//      (사용자 지시 2026-10-13). 재입장은 "끊김" 경로에만 있으므로(사용자 결정) 이 단계는
//      LEAVE_MODE 와 무관하게 항상 소켓 끊기로 재현한다
//  11) **A 가 자기 턴이 아닐 때 나가면, 봇 투입(5초) 전에 시작되는 A 의 다음 턴도 시작부터 2초**다
//      (사용자 신고 2026-10-13 "다음 다시 A턴이 왔지만 턴 남은 시간이 10 부터 시작" — 실제 버그였다)
//
// ⚠️ 이 스크립트는 지우지 말 것 (TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 재현 불가 문제 방지).
//
// ⚠️ DB 에 테스트 유저 8명을 만든다(게임 4판: 한 명 퇴장 / 둘 다 퇴장 / 재입장 / 상대 차례에 퇴장).
//    끝나고 TEST_PARTNER 접두사 행만 지운다(KEEP=1 로 생략).
//
// 사용법:
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> OTHELLO_PORT=6031 node scripts/check-othello-abandon.mjs
//
// LEAVE_MODE 로 "나가는 방식"을 바꿀 수 있다 — 서버 쪽 처리가 완전히 다르므로 둘 다 확인할 것:
//   LEAVE_MODE=consent (기본) 명시적 나가기 → CloseCode.CONSENTED → onDrop 을 건너뛰고 곧장 onLeave
//   LEAVE_MODE=drop            소켓만 끊김  → onDrop → 재접속 유예, RECONNECT_WAIT_SEC(5초) 뒤 봇 투입

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

const TEST_PARTNER = "zzaban";
const run_tag = String(Date.now()).slice(-8);

const checker = client.CreateChecker();

// --- 오델로 규칙(검증용 독립 구현) ---
// 서버와 같은 모듈을 쓰면 서버 버그가 그대로 가려지므로 일부러 따로 구현한다
// (check-othello-game.mjs / check-othello-reconnect.mjs 와 같은 이유).
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

function CountStones(board) {
    let black = 0;
    let white = 0;
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            if (board[y][x] === BLACK) black++;
            else if (board[y][x] === WHITE) white++;
        }
    }
    return { black, white };
}

function LegalMoves(board, color) {
    const out = [];
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) if (GetFlips(board, x, y, color).length > 0) out.push({ x, y });
    }
    return out;
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

// 남은 유저(A)가 받는 메시지를 순서대로 쌓아 두고 하나씩 꺼내 쓰는 큐.
// WaitForMessage 로는 "TURN_START/SELECT_GAME 이 번갈아 오는 루프"를 따라갈 수 없어서 따로 둔다.
function CreateEventQueue(conn, types_of_interest) {
    const queue = [];
    let waiter = null;
    conn.OnMessage((decoded) => {
        if (!types_of_interest.includes(decoded.type)) return;
        const event = { type: decoded.type, payload: client.TakePayload(decoded), at: Date.now() };
        if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve(event);
        } else {
            queue.push(event);
        }
    });
    return (timeout_ms = 20000) =>
        new Promise((resolve) => {
            if (queue.length > 0) return resolve(queue.shift());
            waiter = resolve;
            setTimeout(() => {
                if (waiter === resolve) {
                    waiter = null;
                    resolve(undefined);
                }
            }, timeout_ms);
        });
}

async function Main() {
    console.log(`오델로 "나간 유저 자동 모드" 검증 시작 — lobby ws://${host}:${lobby_port}, othello ws://${host}:${othello_port}\n`);

    const mid_a = `a${run_tag}`;
    const mid_b = `b${run_tag}`;
    const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
    const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);

    // --- [1] 매칭 → 게임 시작 → 돌 색 선택 ---
    console.log("[1] 매칭 → 게임 시작 → 돌 색 선택");
    const p_a = await JoinLobbyAndMatch(mid_a);
    const p_b = await JoinLobbyAndMatch(mid_b);
    const [match_a, match_b] = await Promise.all([p_a.match_wait, p_b.match_wait]);
    p_a.conn.Close();
    p_b.conn.Close();
    if (!match_a || !match_b) throw new Error("MATCH_FOUND 를 받지 못했습니다");

    const game_a = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_a.seat_reservation });
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
    game_a.Send("DOLL_SELECT", { payload: { color: BLACK } }); // A = 검정(선공), B = 흰색
    const doll = await doll_a;
    checker.Check(
        "게임이 시작되고 돌 색이 배정됐다 (A=검정, B=흰색)",
        doll?.select?.["1"] === userid_a && doll?.select?.["0"] === userid_b,
        JSON.stringify(doll?.select)
    );

    const color_by_userid = { [userid_a]: BLACK, [userid_b]: WHITE };
    const board = CreateBoard();

    // A 쪽은 이벤트 큐로 전부 받는다. OUT_USER 수신 시점이 이 검증의 핵심이므로 함께 담는다.
    const NextA = CreateEventQueue(game_a, ["TURN_START", "SELECT_GAME", "GAME_RESULT", "OUT_USER", "TURN_REMAIN_TIME"]);

    // --- [2] 몇 수 진행 ---
    console.log("\n[2] 양쪽이 정상 진행 → B 가 **자기 턴에** 나가는 시점까지 간다");
    const conn_by_userid = { [userid_a]: game_a, [userid_b]: game_b };
    let moves_done = 0;
    let left_on_own_turn = false;
    let leave_turn_at = 0;

    // ⚠️ B 가 **자기 턴에** 나가는 순간을 잡아야 "그 턴은 카운트다운을 끝까지 유지한다"를 검증할 수 있다
    //    (사용자 지시 2026-10-12). B 턴 TURN_START 를 받자마자 아무 수도 두지 않고 그대로 나간다.
    for (let guard = 0; guard < 40; guard++) {
        const ev = await NextA();
        if (ev === undefined) break;
        if (ev.type === "TURN_START") {
            if (ev.payload.turn === userid_b && moves_done >= 1) {
                leave_turn_at = ev.at;
                left_on_own_turn = true;
                break; // 수를 두지 않고 그대로 나간다
            }
            const move = ev.payload.can?.[0];
            if (move) conn_by_userid[ev.payload.turn].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (ev.type === "SELECT_GAME") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board, x, y, color_by_userid[userid]);
            moves_done++;
        }
    }
    checker.Check(
        "B 의 턴이 시작된 시점을 잡았다 (그 턴의 카운트다운 검증을 위해)",
        left_on_own_turn,
        `정상 진행 ${moves_done}수`
    );

    // --- [3] B 가 자기 턴에 나간다 (재입장하지 않는다) ---
    const leave_mode = process.env.LEAVE_MODE ?? "consent";
    if (leave_mode === "drop") {
        console.log("\n[3] LEAVE_MODE=drop — B 의 소켓을 그냥 끊는다 → 서버는 onDrop(재접속 유예 5초 뒤 봇 투입)");
        game_b.socket.close();
    } else {
        console.log("\n[3] LEAVE_MODE=consent — B 가 명시적으로 나가기 → 서버는 onDrop 없이 곧장 onLeave (재접속 창 안 열림)");
        game_b.Leave();
    }

    let out_user_before_result = null;
    let out_user_after_result = null;
    let game_result = null;
    let auto_move_count = 0;
    let auto_turn_count = 0;
    // 나간 **그 턴**과 **그 다음 턴부터**를 따로 재야 한다 — 요구사항이 둘을 다르게 정했다.
    let leave_turn_delay = 0;
    let leave_turn_remain_ticks = 0;
    const later_auto_delays = [];
    const later_auto_remain_ticks = [];

    // --- [4] 남은 유저 혼자 끝까지 — 나간 유저의 턴은 자동 진행 ---
    console.log("\n[4] A 혼자 끝까지 둔다 — 나간 그 턴은 10초 유지, 다음 턴부터 제한 시간 2초");
    let current_turn_at = leave_turn_at;
    let current_turn_is_b = true;
    let current_turn_ticks = 0;
    let b_turn_index = 0; // 나간 그 턴 = 0, 그 뒤로 1, 2, ...

    for (let guard = 0; guard < 400; guard++) {
        const ev = await NextA(25000);
        if (ev === undefined) {
            checker.Check("게임이 끝까지 진행됐다", false, "메시지가 더 오지 않습니다 (게임이 멈춘 것으로 보입니다)");
            break;
        }

        if (ev.type === "OUT_USER") {
            if (game_result === null) out_user_before_result = ev.payload;
            else out_user_after_result = ev.payload;
            continue;
        }

        if (ev.type === "TURN_REMAIN_TIME") {
            if (current_turn_is_b) current_turn_ticks++;
            continue;
        }

        if (ev.type === "TURN_START") {
            current_turn_at = ev.at;
            current_turn_is_b = ev.payload.turn === userid_b;
            current_turn_ticks = 0;
            if (current_turn_is_b) {
                b_turn_index++;
                auto_turn_count++;
                continue; // 아무것도 보내지 않는다 — 서버가 대신 둬야 한다
            }
            const move = ev.payload.can?.[0];
            if (move) game_a.Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
            continue;
        }

        if (ev.type === "SELECT_GAME") {
            const { userid, x, y } = ev.payload.select;
            const flips = ApplyMove(board, x, y, color_by_userid[userid]);
            if (userid === userid_b) {
                auto_move_count++;
                const delay = ev.at - current_turn_at;
                if (b_turn_index === 0) {
                    leave_turn_delay = delay;
                    leave_turn_remain_ticks = current_turn_ticks;
                } else {
                    later_auto_delays.push(delay);
                    later_auto_remain_ticks.push(current_turn_ticks);
                }
            }
            // 서버가 알려준 뒤집기 좌표가 독립 계산과 같은지 매 수마다 확인한다
            if ((ev.payload.change?.length ?? 0) !== flips.length) {
                checker.Check(`뒤집기 좌표 개수 일치 (${x},${y})`, false, `서버 ${ev.payload.change?.length} / 기대 ${flips.length}`);
            }
            continue;
        }

        if (ev.type === "GAME_RESULT") {
            game_result = ev.payload;
            // GAME_RESULT 뒤에 오는 OUT_USER 를 받기 위해 잠깐 더 기다린다
            const after = await NextA(3000);
            if (after?.type === "OUT_USER") out_user_after_result = after.payload;
            break;
        }
    }

    checker.Check("나간 유저(B)의 턴이 돌아왔다 (게임이 멈추지 않았다)", auto_turn_count > 0, `이후 B 턴 ${auto_turn_count}회`);
    checker.Check("나간 유저(B)의 턴이 서버에 의해 자동으로 처리됐다", auto_move_count > 0, `자동 착수 ${auto_move_count}수`);

    // (가) 나간 **그 턴** — 제한 시간 10초를 끝까지 유지해야 한다 (사용자 지시 2026-10-12)
    checker.Check(
        "나간 그 턴은 제한 시간(10초)을 끝까지 유지했다",
        leave_turn_delay >= 8000,
        `TURN_START→자동 착수 ${leave_turn_delay}ms (8000ms 이상이어야 함)`
    );
    checker.Check(
        "나간 그 턴에도 TURN_REMAIN_TIME 카운트다운이 계속 왔다",
        leave_turn_remain_ticks >= 8,
        `카운트다운 ${leave_turn_remain_ticks}회 (9,8,…,0 = 10회 기대)`
    );

    // (나) **그 다음 턴부터** — 제한 시간이 2초로 줄어든다 (사용자 결정 2026-10-13)
    if (later_auto_delays.length > 0) {
        const max_delay = Math.max(...later_auto_delays);
        const min_delay = Math.min(...later_auto_delays);
        const avg_delay = Math.round(later_auto_delays.reduce((a, b) => a + b, 0) / later_auto_delays.length);
        checker.Check(
            "다음 턴부터는 제한 시간이 2초로 줄어든다",
            max_delay < 4000 && min_delay >= 1500,
            `TURN_START→자동 착수 평균 ${avg_delay}ms / 최소 ${min_delay}ms / 최대 ${max_delay}ms (${later_auto_delays.length}턴)`
        );
        // 자동 턴도 사람 턴과 같은 카운트다운을 쓴다 — 2초면 count:1, count:0 두 번이어야 한다.
        // (2026-10-12 에는 아예 보내지 않아 클라이언트 타이머가 10 에서 멈춰 보였다)
        const min_ticks = Math.min(...later_auto_remain_ticks);
        const max_ticks = Math.max(...later_auto_remain_ticks);
        checker.Check(
            "자동 턴에도 TURN_REMAIN_TIME 이 2회(count:1 → count:0) 온다",
            min_ticks === 2 && max_ticks === 2,
            `턴별 수신 횟수 최소 ${min_ticks}회 / 최대 ${max_ticks}회`
        );
    }

    // --- [5] OUT_USER 전송 시점 ---
    console.log("\n[5] OUT_USER 는 게임이 끝난 뒤에 와야 한다");
    checker.Check(
        "나가는 순간에는 OUT_USER 가 오지 않았다",
        out_user_before_result === null,
        out_user_before_result === null ? "안 왔다(정상)" : `왔다(문제): ${JSON.stringify(out_user_before_result)}`
    );
    checker.Check(
        "게임 종료 후 나간 유저 정보로 OUT_USER 가 왔다",
        out_user_after_result?.userid === userid_b,
        JSON.stringify(out_user_after_result)
    );

    // --- [6] GAME_RESULT 에 나간 유저가 그대로 담겨 있다 ---
    console.log("\n[6] GAME_RESULT 에 나간 유저 정보가 담겨 있어야 한다");
    checker.Check("GAME_RESULT 를 받았다", game_result !== null, game_result === null ? "수신 없음" : "수신");

    if (game_result) {
        const counts = CountStones(board);
        const userids = [game_result.winner?.userid, game_result.loser?.userid];
        checker.Check(
            "winner/loser 에 두 유저가 모두 담겨 있다 (나간 유저 포함)",
            userids.includes(userid_a) && userids.includes(userid_b),
            JSON.stringify(userids)
        );

        const expected_draw = counts.black === counts.white;
        checker.Check(
            "무승부 여부가 돌 개수와 일치한다",
            (game_result.draw === "Y") === expected_draw,
            `draw=${game_result.draw ?? "(없음)"} / 검정 ${counts.black} : 흰색 ${counts.white}`
        );

        const stone_by_userid = { [userid_a]: counts.black, [userid_b]: counts.white };
        checker.Check(
            "win_count 가 각 유저의 최종 돌 개수와 일치한다",
            game_result.winner.win_count === stone_by_userid[game_result.winner.userid] &&
                game_result.loser.win_count === stone_by_userid[game_result.loser.userid],
            `winner ${game_result.winner.win_count}(기대 ${stone_by_userid[game_result.winner.userid]}) / loser ${game_result.loser.win_count}(기대 ${stone_by_userid[game_result.loser.userid]})`
        );
        checker.Check(
            "양쪽 돌 개수 합이 보드와 맞는다",
            game_result.winner.win_count + game_result.loser.win_count === counts.black + counts.white,
            `합=${game_result.winner.win_count + game_result.loser.win_count} / 보드=${counts.black + counts.white}`
        );

        const remaining_legal = LegalMoves(board, BLACK).length + LegalMoves(board, WHITE).length;
        checker.Check("종료 시점에 양쪽 모두 놓을 곳이 없다", remaining_legal === 0, `남은 합법수 ${remaining_legal}개`);

        console.log(
            `    최종 ${counts.black}:${counts.white} (검정=A / 흰색=B), 자동 착수 ${auto_move_count}수` +
                `${game_result.draw === "Y" ? ", 무승부" : `, 승자=${game_result.winner.userid === userid_b ? "B(나간 유저)" : "A"}`}`
        );
    }

    game_a.Close();

    // --- [7] DB 반영 — 나간 유저의 승패에도 적용됐는지 ---
    console.log("\n[7] DB 에 양쪽 모두의 결과가 반영돼야 한다");
    await new Promise((r) => setTimeout(r, 1500)); // DB 저장은 GAME_RESULT 전송 뒤에 비동기로 돈다

    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/othelloGameLogSchema.js");
    const log_table = log_mod.GetOthelloGameLogTableName(new Date());

    // ⚠️ 접두사(LIKE 'zzaban_%')로 세지 않고 **이 게임의 두 유저로** 좁힌다 — 접두사로 세면 앞선
    //    실행이 남긴 행 하나에도 "2행" 으로 실패해서 서버 버그처럼 보인다(2026-10-13 실제로 겪음).
    //    [8] 단계가 쓰던 방식과 같게 맞췄다.
    const [log_rows] = await pool.query(
        `SELECT win, lose, vs, score, is_draw, win_is_bot, lose_is_bot, JSON_LENGTH(plays) AS play_count
         FROM \`${log_table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`,
        [userid_a, userid_b, userid_a, userid_b]
    );
    checker.Check("othello_game_log 에 이 게임이 1행 기록됐다", log_rows.length === 1, `${log_rows.length}행`);

    if (log_rows.length === 1) {
        const row = log_rows[0];
        checker.Check(
            "로그의 win/lose 에 두 유저가 모두 들어 있다 (나간 유저 포함)",
            [row.win, row.lose].includes(userid_a) && [row.win, row.lose].includes(userid_b),
            `win=${row.win} lose=${row.lose} vs=${row.vs} score=${row.score} is_draw=${row.is_draw}`
        );
        // 나간 B 는 서버가 대신 뒀으므로 봇으로 기록돼야 한다
        const b_is_bot = row.win === userid_b ? row.win_is_bot : row.lose_is_bot;
        checker.Check("나간 유저가 봇으로 기록됐다 (win_is_bot/lose_is_bot)", b_is_bot === 1, `b_is_bot=${b_is_bot}`);
        const a_is_bot = row.win === userid_a ? row.win_is_bot : row.lose_is_bot;
        checker.Check("남아 있던 유저는 봇이 아니다", a_is_bot === 0, `a_is_bot=${a_is_bot}`);
        checker.Check("plays 에 전체 수순이 기록됐다", row.play_count > 0, `${row.play_count}수`);
    }

    const [play_rows] = await pool.query(
        `SELECT userid, total_game_count, total_win_count, total_score FROM othello_user_play_info WHERE userid IN (?, ?) ORDER BY userid`,
        [userid_a, userid_b]
    );
    checker.Check("두 유저의 othello_user_play_info 가 모두 존재한다", play_rows.length === 2, `${play_rows.length}행`);
    const by_userid = Object.fromEntries(play_rows.map((r) => [r.userid, r]));
    checker.Check(
        "나간 유저(B)의 게임 수가 1 증가했다 — 결과가 그 유저의 승패에 적용됐다",
        by_userid[userid_b]?.total_game_count === 1,
        `B total_game_count=${by_userid[userid_b]?.total_game_count} total_win_count=${by_userid[userid_b]?.total_win_count}`
    );
    checker.Check(
        "남아 있던 유저(A)의 게임 수도 1 증가했다",
        by_userid[userid_a]?.total_game_count === 1,
        `A total_game_count=${by_userid[userid_a]?.total_game_count} total_win_count=${by_userid[userid_a]?.total_win_count}`
    );
    if (game_result) {
        const winner_row = by_userid[game_result.winner.userid];
        const is_draw = game_result.draw === "Y";
        checker.Check(
            is_draw ? "무승부라 양쪽 승수가 0이다" : "승자의 승수가 1이다",
            is_draw
                ? by_userid[userid_a]?.total_win_count === 0 && by_userid[userid_b]?.total_win_count === 0
                : winner_row?.total_win_count === 1,
            `A승=${by_userid[userid_a]?.total_win_count} B승=${by_userid[userid_b]?.total_win_count}`
        );
    }

    // --- [8] 둘 다 나간 경우 — 끝까지 자동으로 두지 않고 현재 돌 수로 즉시 종료 + DB 기록 ---
    // (사용자 결정 2026-10-12. 아무도 결과를 볼 사람이 없는데 끝까지 자동으로 두면 방을 최대 10분
    //  점유하고 무중단 재시작 드레인도 그만큼 늦어진다)
    console.log("\n[8] 둘 다 나가면 현재 돌 수로 즉시 종료되고 DB 에 기록돼야 한다");
    const mid_c = `c${run_tag}`;
    const mid_d = `d${run_tag}`;
    const userid_c = ExpectedUserid(TEST_PARTNER, mid_c);
    const userid_d = ExpectedUserid(TEST_PARTNER, mid_d);

    const p_c = await JoinLobbyAndMatch(mid_c);
    const p_d = await JoinLobbyAndMatch(mid_d);
    const [match_c, match_d] = await Promise.all([p_c.match_wait, p_d.match_wait]);
    p_c.conn.Close();
    p_d.conn.Close();
    if (!match_c || !match_d) throw new Error("두 번째 게임의 MATCH_FOUND 를 받지 못했습니다");

    const game_c = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_c.seat_reservation });
    const game_d = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_d.seat_reservation });
    if (!game_c.ok || !game_d.ok) throw new Error("두 번째 게임의 오델로 채널 접속 실패");

    const enter2_c = client.WaitForMessage(game_c, "ENTER_ROOM", 8000);
    const enter2_d = client.WaitForMessage(game_d, "ENTER_ROOM", 8000);
    game_c.Send("ENTER_ROOM", { payload: {} });
    game_d.Send("ENTER_ROOM", { payload: {} });
    await Promise.all([enter2_c, enter2_d]);

    const start2 = client.WaitForMessage(game_c, "GAME_START", 8000);
    game_c.Send("READY", { payload: { ready: "Y" } });
    game_d.Send("READY", { payload: { ready: "Y" } });
    await start2;

    const doll2 = client.WaitForMessage(game_c, "DOLL_SELECT", 15000);
    await new Promise((r) => setTimeout(r, 6500));
    game_c.Send("DOLL_SELECT", { payload: { color: BLACK } }); // C = 검정(선공), D = 흰색
    await doll2;

    // 몇 수만 둔 뒤 둘 다 나간다
    const color2_by_userid = { [userid_c]: BLACK, [userid_d]: WHITE };
    const conn2_by_userid = { [userid_c]: game_c, [userid_d]: game_d };
    const board2 = CreateBoard();
    const NextC = CreateEventQueue(game_c, ["TURN_START", "SELECT_GAME"]);
    let moves2 = 0;
    while (moves2 < 2) {
        const ev = await NextC(20000);
        if (ev === undefined) break;
        if (ev.type === "TURN_START") {
            const move = ev.payload.can?.[0];
            if (move) conn2_by_userid[ev.payload.turn].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (ev.type === "SELECT_GAME") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board2, x, y, color2_by_userid[userid]);
            moves2++;
        }
    }
    const counts2 = CountStones(board2);
    checker.Check("두 번째 게임도 몇 수 진행됐다", moves2 === 2, `진행=${moves2}, 돌 ${counts2.black}:${counts2.white}`);

    game_c.Leave();
    game_d.Leave();
    await new Promise((r) => setTimeout(r, 2500)); // 즉시 종료 + DB 저장(비동기)을 기다린다

    const [log2_rows] = await pool.query(
        `SELECT win, lose, vs, is_draw, win_is_bot, lose_is_bot FROM \`${log_table}\`
         WHERE win IN (?, ?) OR lose IN (?, ?)`,
        [userid_c, userid_d, userid_c, userid_d]
    );
    checker.Check("둘 다 나가도 게임 로그가 1행 남는다", log2_rows.length === 1, `${log2_rows.length}행`);
    if (log2_rows.length === 1) {
        const row2 = log2_rows[0];
        const [w, l] = String(row2.vs).split(":").map(Number);
        checker.Check(
            "끝까지 두지 않고 **나간 시점의 돌 수**로 종료됐다",
            w + l === counts2.black + counts2.white,
            `vs=${row2.vs} (합 ${w + l}) / 기대 합 ${counts2.black + counts2.white} — 64 가 아니어야 한다`
        );
        checker.Check(
            "양쪽 모두 봇으로 기록됐다 (둘 다 나갔으므로)",
            row2.win_is_bot === 1 && row2.lose_is_bot === 1,
            `win_is_bot=${row2.win_is_bot} lose_is_bot=${row2.lose_is_bot}`
        );
    }

    const [play2_rows] = await pool.query(
        `SELECT userid, total_game_count FROM othello_user_play_info WHERE userid IN (?, ?) ORDER BY userid`,
        [userid_c, userid_d]
    );
    checker.Check(
        "두 유저 모두의 승패에 반영됐다",
        play2_rows.length === 2 && play2_rows.every((r) => r.total_game_count === 1),
        JSON.stringify(play2_rows.map((r) => `${r.userid.slice(-4)}=${r.total_game_count}`))
    );

    // --- [9] 자동 턴 중에 재입장하면 그 턴은 못 놓고, 다음 턴부터 놓을 수 있다 ---
    // (사용자 지시 2026-10-13: "A가 나간 후에 몇 십초가 지나 본인 턴에 다시 재입장을 하는 경우에는
    //  그 턴은 본인이 놓을 자리를 선택하지 못하고, 다음 턴부터 가능 하다")
    // ⚠️ 재입장 경로는 **끊김**(onDrop → 재접속 창)에만 있다 — 명시적 나가기는 재접속 창이 열리지
    //    않아 돌아올 방법이 없다(사용자 결정 2026-10-13). 그래서 이 단계는 LEAVE_MODE 와 무관하게
    //    항상 소켓 끊기로 재현한다.
    console.log("\n[9] 자동 턴 중 재입장 — 그 턴은 못 놓고, 다음 턴부터 본인이 놓을 수 있어야 한다");
    const mid_e = `e${run_tag}`;
    const mid_f = `f${run_tag}`;
    const userid_e = ExpectedUserid(TEST_PARTNER, mid_e);
    const userid_f = ExpectedUserid(TEST_PARTNER, mid_f);

    const p_e = await JoinLobbyAndMatch(mid_e);
    const p_f = await JoinLobbyAndMatch(mid_f);
    const [match_e, match_f] = await Promise.all([p_e.match_wait, p_f.match_wait]);
    p_e.conn.Close();
    p_f.conn.Close();
    if (!match_e || !match_f) throw new Error("세 번째 게임의 MATCH_FOUND 를 받지 못했습니다");

    const game_e = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_e.seat_reservation });
    const game_f = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_f.seat_reservation });
    if (!game_e.ok || !game_f.ok) throw new Error("세 번째 게임의 오델로 채널 접속 실패");

    const enter3_e = client.WaitForMessage(game_e, "ENTER_ROOM", 8000);
    const enter3_f = client.WaitForMessage(game_f, "ENTER_ROOM", 8000);
    game_e.Send("ENTER_ROOM", { payload: {} });
    game_f.Send("ENTER_ROOM", { payload: {} });
    await Promise.all([enter3_e, enter3_f]);

    const start3 = client.WaitForMessage(game_e, "GAME_START", 8000);
    game_e.Send("READY", { payload: { ready: "Y" } });
    game_f.Send("READY", { payload: { ready: "Y" } });
    await start3;

    const doll3 = client.WaitForMessage(game_e, "DOLL_SELECT", 15000);
    await new Promise((r) => setTimeout(r, 6500));
    game_e.Send("DOLL_SELECT", { payload: { color: BLACK } }); // E = 검정(선공), F = 흰색
    await doll3;

    // F 의 재접속 토큰을 미리 읽어 둔다 — onDrop 은 activeGame 기록을 지우지 않으므로 끊긴 뒤에도
    // 유효하다(로비의 REJOIN_GAME 이 클라이언트에게 주는 값과 같은 것, check-othello-reconnect.mjs 참고)
    const activeGame_mod = await import("../dist/game/room/activeGame.js");
    const active_f = await activeGame_mod.GetActiveGame(userid_f);
    checker.Check("Redis 에 F 의 activeGame 기록이 있다 (재입장에 필요)", active_f !== null, JSON.stringify(active_f));

    const color3_by_userid = { [userid_e]: BLACK, [userid_f]: WHITE };
    const conn3_by_userid = { [userid_e]: game_e, [userid_f]: game_f };
    const board3 = CreateBoard();
    const NextE = CreateEventQueue(game_e, ["TURN_START", "SELECT_GAME", "TURN_REMAIN_TIME"]);

    // 몇 수 정상 진행한 뒤 F 의 소켓을 끊는다 (자기 턴이 아닐 때 끊어도 상관없다 — 이 단계가 보는
    // 것은 "나간 그 턴"이 아니라 그 뒤의 **자동 턴**이다)
    let moves3 = 0;
    while (moves3 < 2) {
        const ev = await NextE(20000);
        if (ev === undefined) break;
        if (ev.type === "TURN_START") {
            const move = ev.payload.can?.[0];
            if (move) conn3_by_userid[ev.payload.turn].Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
        } else if (ev.type === "SELECT_GAME") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board3, x, y, color3_by_userid[userid]);
            moves3++;
        }
    }
    game_f.socket.close();
    const f_closed_at = Date.now();
    console.log(`    F 의 소켓을 끊었다 (${moves3}수 진행 후) — 이 순간부터 F 의 다음 턴은 자동 턴(2초)`);

    let rejoin_conn = null;
    let rejoin_ms = 0;
    let blocked_turn_after_drop = 0; // 끊긴 뒤 몇 ms 만에 그 자동 턴이 시작됐는지 (5초 미만이면 봇 투입 전)
    let blocked_sent = null; // 재입장 직후 그 턴에 F 가 보낸 좌표
    let blocked_placed = null; // 그 턴에 실제로 놓인 좌표
    let blocked_delay = 0;
    let blocked_can_count = 0;
    let after_sent = null; // 그 다음 턴에 F 가 보낸 좌표
    let after_placed = null;
    let after_delay = 0;
    let stage = "wait_bot"; // wait_bot → blocked_turn → after_turn → done
    let cur_turn_at = 0;

    for (let guard = 0; guard < 300 && stage !== "done"; guard++) {
        const ev = await NextE(25000);
        if (ev === undefined) break;

        if (ev.type === "TURN_START") {
            cur_turn_at = ev.at;
            if (ev.payload.turn === userid_e) {
                const move = ev.payload.can?.[0];
                if (move) game_e.Send("SELECT_GAME", { payload: { select: { x: move.x, y: move.y } } });
                continue;
            }

            // F 의 턴이다.
            if (stage === "wait_bot") {
                // 끊긴 뒤 시작되는 F 의 턴은 **봇 투입(5초) 전이라도** 자동 턴(2초)이다(2026-10-13 수정 —
                // 예전에는 여기서 "끊긴 지 5.5초 전에 시작된 턴은 사람 턴(10초)" 이라며 건너뛰었는데,
                // 바로 그 동작이 사용자가 신고한 버그였다). 그 2초 안에 재입장해서 수를 보내 본다.
                blocked_turn_after_drop = ev.at - f_closed_at;
                const rejoin_started = Date.now();
                rejoin_conn = await client.ConnectWithSeat({
                    host,
                    port: othello_port,
                    reservation: {
                        processId: match_f.seat_reservation.processId,
                        roomId: active_f?.room_id ?? match_f.seat_reservation.roomId,
                        sessionId: match_f.seat_reservation.sessionId,
                    },
                    reconnection_token: active_f?.reconnection_token ?? "",
                    timeout_ms: 8000,
                });
                rejoin_ms = Date.now() - rejoin_started;
                if (!rejoin_conn.ok) {
                    checker.Check("자동 턴 중에 같은 방으로 재입장했다", false, JSON.stringify(rejoin_conn).slice(0, 160));
                    stage = "done";
                    continue;
                }
                blocked_can_count = ev.payload.can?.length ?? 0;
                blocked_sent = ev.payload.can?.[0] ?? null;
                if (blocked_sent) {
                    rejoin_conn.Send("SELECT_GAME", { payload: { select: { x: blocked_sent.x, y: blocked_sent.y } } });
                }
                stage = "blocked_turn";
                continue;
            }

            if (stage === "after_turn") {
                // 재입장 후 **다음** F 턴 — 이제 본인이 놓을 수 있어야 한다.
                // 일부러 3초를 기다린 뒤 보낸다: 이 턴이 아직 자동 턴이라면 서버가 2초에 랜덤으로
                // 놓아 버리므로, 3초 뒤에 보낸 내 좌표가 반영됐다는 건 "자동이 아니다"의 증거다.
                await new Promise((r) => setTimeout(r, 3000));
                after_sent = ev.payload.can?.[0] ?? null;
                if (after_sent) {
                    rejoin_conn.Send("SELECT_GAME", { payload: { select: { x: after_sent.x, y: after_sent.y } } });
                }
                continue;
            }
            continue;
        }

        if (ev.type === "SELECT_GAME") {
            const { userid, x, y } = ev.payload.select;
            ApplyMove(board3, x, y, color3_by_userid[userid]);
            if (userid !== userid_f) continue;

            if (stage === "blocked_turn") {
                blocked_placed = { x, y };
                blocked_delay = ev.at - cur_turn_at;
                stage = "after_turn";
            } else if (stage === "after_turn") {
                after_placed = { x, y };
                after_delay = ev.at - cur_turn_at;
                stage = "done";
            }
            continue;
        }
    }

    if (rejoin_conn?.ok) {
        checker.Check("자동 턴 중에 같은 방으로 재입장했다", true, `재접속 ${rejoin_ms}ms (그 자동 턴은 끊긴 지 ${blocked_turn_after_drop}ms 뒤 시작)`);
        checker.Check(
            "재입장이 자동 턴(2초) 안에 끝났다 (이 검증이 성립하는 조건)",
            rejoin_ms < 1500,
            `${rejoin_ms}ms — 1500ms 를 넘으면 그 턴이 이미 끝나 검증이 무의미하다`
        );
        // 핵심: 재입장한 그 턴에 보낸 수는 **무시**되고, 제한 시간 2초가 끝나서 서버가 놓아야 한다.
        // 보낸 수가 받아들여졌다면 TURN_START 직후(≈0ms)에 SELECT_GAME 이 왔을 것이다.
        checker.Check(
            "재입장한 그 턴에는 본인이 놓지 못했다 (서버가 제한 시간 2초 뒤에 놓았다)",
            blocked_delay >= 1500,
            `TURN_START→착수 ${blocked_delay}ms (보낸 좌표 ${JSON.stringify(blocked_sent)} / 실제 ${JSON.stringify(blocked_placed)}, 합법수 ${blocked_can_count}개)`
        );
        checker.Check(
            "그 다음 턴에는 본인이 보낸 수가 그대로 반영됐다 (자동 모드가 해제됐다)",
            after_placed !== null && after_sent !== null && after_placed.x === after_sent.x && after_placed.y === after_sent.y,
            `보낸 좌표 ${JSON.stringify(after_sent)} / 실제 ${JSON.stringify(after_placed)}, TURN_START→착수 ${after_delay}ms`
        );
        checker.Check(
            "그 다음 턴은 2초에 자동 착수되지 않았다 (3초 뒤에 보낸 수가 받아들여졌다)",
            after_delay >= 2500,
            `TURN_START→착수 ${after_delay}ms (2초 자동 턴이면 2000ms 쯤에 놓였을 것)`
        );
        rejoin_conn.Leave();
    }
    game_e.Leave();
    // ⚠️ 여기서는 `Close()`(소켓만 닫기)를 쓰면 안 된다 — 그러면 둘 다 `onDrop` 으로 재접속 창이 열려
    //    "둘 다 나감 → 즉시 종료" 판정(`reconnection_by_session.size === 0`)에 걸리지 않고, 방이 봇끼리
    //    끝까지 두느라 **몇 분 뒤에** 게임 로그를 쓴다. 그러면 아래 정리 단계가 그 행보다 먼저 돌아
    //    테스트 행이 남고, **다음 실행의 DB 단정이 깨진다**(2026-10-13 실제로 겪음 — drop 실행에서
    //    "othello_game_log … 2행" 실패). `Leave()`(명시적 나가기)는 즉시 종료 경로를 타므로 안전하다.
    await new Promise((r) => setTimeout(r, 2500)); // 즉시 종료 + DB 저장(비동기)을 기다린다

    // --- [10] 사용자 신고 시나리오 그대로 (2026-10-13) ---
    // "A유저가 게임중 나가서 재입장을 하지 않았고, 다음 다시 A턴이 왔지만 턴 남은 시간이 10 부터 시작".
    // ⚠️ 위 [2]~[4] 는 B 가 **자기 턴에** 나가서 다음 B 턴이 항상 봇 투입(5초) **뒤에** 시작됐다 — 그래서
    //    끊김(drop) 경로에서 "봇 투입 전에 시작된 턴은 10초" 라는 버그를 한 번도 밟지 않고 통과했다.
    //    여기서는 A 가 **자기 수를 둔 직후**(= 상대 차례) 나가고 상대가 바로 둬서, A 의 다음 턴이 나간 지
    //    약 2~4초 만에(봇 투입 전) 시작되게 만든다. 그 턴이 **시작부터** 2초(count:1 → 0)여야 한다.
    console.log("\n[10] A 가 자기 턴이 아닐 때 나가고(재입장 없음) 다음 A 턴이 오면 — 시작부터 제한 시간 2초여야 한다");
    const mid_g = `g${run_tag}`;
    const mid_h = `h${run_tag}`;
    const userid_g = ExpectedUserid(TEST_PARTNER, mid_g);
    const userid_h = ExpectedUserid(TEST_PARTNER, mid_h);

    const p_g = await JoinLobbyAndMatch(mid_g);
    const p_h = await JoinLobbyAndMatch(mid_h);
    const [match_g, match_h] = await Promise.all([p_g.match_wait, p_h.match_wait]);
    p_g.conn.Close();
    p_h.conn.Close();
    if (!match_g || !match_h) throw new Error("네 번째 게임의 MATCH_FOUND 를 받지 못했습니다");

    const game_g = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_g.seat_reservation });
    const game_h = await client.ConnectWithSeat({ host, port: othello_port, reservation: match_h.seat_reservation });
    if (!game_g.ok || !game_h.ok) throw new Error("네 번째 게임의 오델로 채널 접속 실패");

    const enter4_g = client.WaitForMessage(game_g, "ENTER_ROOM", 8000);
    const enter4_h = client.WaitForMessage(game_h, "ENTER_ROOM", 8000);
    game_g.Send("ENTER_ROOM", { payload: {} });
    game_h.Send("ENTER_ROOM", { payload: {} });
    await Promise.all([enter4_g, enter4_h]);

    const start4 = client.WaitForMessage(game_h, "GAME_START", 8000);
    game_g.Send("READY", { payload: { ready: "Y" } });
    game_h.Send("READY", { payload: { ready: "Y" } });
    await start4;

    const doll4 = client.WaitForMessage(game_h, "DOLL_SELECT", 15000);
    await new Promise((r) => setTimeout(r, 6500));
    game_g.Send("DOLL_SELECT", { payload: { color: BLACK } }); // G = 검정(선공) = 나가는 쪽
    await doll4;

    // drop 모드 정리(재접속 → 명시적 나가기)에 쓸 토큰을 끊기 전에 읽어 둔다
    const active_g = await activeGame_mod.GetActiveGame(userid_g);

    const NextH = CreateEventQueue(game_h, ["TURN_START", "TURN_REMAIN_TIME", "SELECT_GAME"]);
    let g_left_at = 0;
    let g_turn = null; // { start_at, counts: [], placed_at }

    for (let guard = 0; guard < 80; guard++) {
        const ev = await NextH(25000);
        if (ev === undefined) break;

        if (ev.type === "TURN_START") {
            if (ev.payload.turn === userid_h) {
                // 남은 유저는 바로 둔다 — 그래야 G 의 다음 턴이 G 가 나간 지 몇 초 만에 시작된다
                game_h.Send("SELECT_GAME", { payload: { select: ev.payload.can[0] } });
                continue;
            }
            if (g_left_at === 0) {
                game_g.Send("SELECT_GAME", { payload: { select: ev.payload.can[0] } }); // G 의 첫 수는 직접 둔다
                continue;
            }
            g_turn = { start_at: ev.at, counts: [], placed_at: 0 };
            continue;
        }

        if (ev.type === "TURN_REMAIN_TIME") {
            if (g_turn && g_turn.placed_at === 0) g_turn.counts.push(ev.payload.count);
            continue;
        }

        if (ev.type === "SELECT_GAME" && ev.payload.select.userid === userid_g) {
            if (g_left_at === 0) {
                // G 가 자기 수를 둔 직후 — 이제 H 차례다. 여기서 G 가 나간다(재입장하지 않는다).
                if (leave_mode === "drop") game_g.socket.close();
                else game_g.Leave();
                g_left_at = ev.at;
                continue;
            }
            if (g_turn) {
                g_turn.placed_at = ev.at;
                break;
            }
        }
    }

    checker.Check("나간 유저(G)의 다음 턴이 왔다", g_turn !== null, g_turn ? `G 가 나간 지 ${g_turn.start_at - g_left_at}ms 뒤 시작` : "오지 않았다");
    if (g_turn) {
        checker.Check(
            "그 턴은 G 가 나간 지 5초 안에(봇 투입 전에) 시작됐다 — 버그가 나던 바로 그 구간을 검증한다",
            g_turn.start_at - g_left_at < 5000,
            `${g_turn.start_at - g_left_at}ms (5000ms 이상이면 이 단계가 버그 구간을 밟지 못한 것)`
        );
        checker.Check(
            "그 턴의 첫 카운트다운이 count:1 이다 — 10 이 아니라 2초로 시작한다",
            g_turn.counts[0] === 1,
            `받은 카운트다운: [${g_turn.counts.join(",")}]`
        );
        checker.Check(
            "카운트다운이 count:1 → count:0 두 번뿐이다",
            g_turn.counts.join(",") === "1,0",
            `[${g_turn.counts.join(",")}]`
        );
        const g_delay = g_turn.placed_at - g_turn.start_at;
        checker.Check(
            "TURN_START 부터 약 2초 만에 서버가 놓았다 (10초를 기다리지 않았다)",
            g_delay >= 1500 && g_delay < 3500,
            `TURN_START→자동 착수 ${g_delay}ms`
        );
    }

    // 정리 — 둘 다 **명시적으로** 나가게 해서 즉시 종료 경로를 타게 한다([9] 단계 끝의 교훈 참고).
    // drop 모드의 G 는 재접속 창이 열려 있으므로, 토큰으로 재접속한 뒤 나가기를 보낸다.
    if (leave_mode === "drop" && active_g) {
        const g_back = await client.ConnectWithSeat({
            host,
            port: othello_port,
            reservation: {
                processId: match_g.seat_reservation.processId,
                roomId: active_g.room_id,
                sessionId: match_g.seat_reservation.sessionId,
            },
            reconnection_token: active_g.reconnection_token,
            timeout_ms: 8000,
        });
        if (g_back.ok) g_back.Leave();
        await new Promise((r) => setTimeout(r, 500));
    }
    game_h.Leave();
    await new Promise((r) => setTimeout(r, 2500));

    checker.Report();

    // --- 정리 ---
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        console.log(`\n정리 (partner='${TEST_PARTNER}' 인 행만):`);
        await pool.query(`DELETE FROM \`${log_table}\` WHERE win LIKE ? OR lose LIKE ?`, [`${TEST_PARTNER}_%`, `${TEST_PARTNER}_%`]);
        for (const t of ["othello_rank_daily", "othello_rank_weekly", "rps_rank_daily", "rps_rank_weekly", "othello_user_play_info", "rps_user_play_info", "user_member_info", "user_partner_info"]) {
            const [r] = await pool.query(`DELETE FROM ${t} WHERE userid LIKE ?`, [`${TEST_PARTNER}_%`]);
            if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
        }
        const redis_mod = await import("../dist/db/redis.js");
        const test_userids = [userid_a, userid_b, userid_c, userid_d, userid_e, userid_f, userid_g, userid_h];
        for (const userid of test_userids) {
            await redis_mod.DeleteJson(`user:info:${userid}`);
            await redis_mod.DeleteJson(`user:play:othello:${userid}`);
            await redis_mod.DeleteJson(`user:play:rps:${userid}`);
            await redis_mod.DeleteJson(`active_game:${userid}`);
        }
        // 랭킹 ZSET 에도 테스트 유저가 들어가므로 멤버만 지운다 (키 전체를 지우면 실제 랭킹이 날아간다)
        const zset = redis_mod.GetRedisClient();
        const keys = await zset.keys("rank_zset:othello:*");
        for (const key of keys) await zset.zrem(key, ...test_userids);
        zset.disconnect();
        console.log("  Redis 캐시/랭킹 멤버 삭제 완료");
    }
    await pool.end();
}

await Main();
