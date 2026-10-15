// RPS(가위바위보) — 게임 중 한 명이 나간 뒤 재입장하지 않는 경우 검증 스크립트 (2026-10-13).
//
// 사용자 요청: "RPS 도 게임 중 유저가 1인 나가도 게임 종료 후 해당 유저아이디로 결과 반영 및 DB 저장".
// 오델로에 먼저 넣은 규칙(check-othello-abandon.mjs)을 RPS 에도 적용한 것이고, 메시지 흐름이 달라
// (ONE_START/ONE_REMAIN_TIME/ONE_RESULT 2선승제) 스크립트를 따로 둔다.
//
// 검증 대상:
//   1) 게임 중 B 가 나가도(재입장 없음) 게임이 멈추지 않는다 — 예전에는 좌석이 비면서 그대로 멈췄고
//      `GAME_RESULT`/DB 기록이 **양쪽 모두** 사라졌다
//   2) 나가는 순간에는 OUT_USER 가 **오지 않는다** (오면 클라이언트가 게임을 접어 버린다)
//   3) **남은 유저가 선택하면 그 즉시 나간 유저의 값도 정해져 판이 끝난다** — 제한 시간(10초)을
//      기다리지 않는다 (사용자 요청 2026-10-13: "상대방이 턴 제한 시간을 모두 기다리지 않도록").
//      남은 유저가 먼저 선택한 뒤에 상대가 나간 경우도 그 순간 바로 판정돼야 한다.
//   4) 2선승이 나면 `GAME_RESULT` 에 **나간 유저 정보가 그대로** 담겨 남은 유저에게 간다
//   5) `GAME_RESULT` 뒤에 **나간 유저의 OUT_USER** 가 남은 유저에게 간다
//   6) DB 에 양쪽 모두의 승패가 반영된다 (rps_game_log 1행 + 두 유저의 rps_user_play_info/rps_rank_*)
//   7) 둘 다 나가면 남은 판을 즉시 판정해서 **정상적인 2선승 결과**(vs "2:0"/"2:1")로 DB 에 남는다
//      — 오델로처럼 "중간 점수로 종료" 할 수 없기 때문이다(vs/score 가 2선승 기준)
//
// ⚠️ 이 스크립트는 지우지 말 것 (TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 재현 불가 문제 방지).
//
//   8) **상대가 나간 직후(봇 투입 5초 전) 남은 유저가 고르면 그 순간 판이 끝난다** — 사용자 신고
//      (2026-10-13) 시나리오. 끊김(drop) 경로에서 봇 투입 전까지 기다리던 실제 버그를 재현한다.
//
// ⚠️ DB 에 테스트 유저 6명을 만든다(게임 3판: 한 명 퇴장 / 둘 다 퇴장 / 나간 직후 선택).
//    끝나고 TEST_PARTNER 접두사 행만 지운다(KEEP=1 로 생략).
//
// 사용법:
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> RPS_PORT=6021 node scripts/check-rps-abandon.mjs
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
const rps_port = Number(process.env.RPS_PORT ?? 6021);
const keep_rows = process.env.KEEP === "1";
const leave_mode = process.env.LEAVE_MODE ?? "consent";

const TEST_PARTNER = "zzrps";
const run_tag = String(Date.now()).slice(-8);

const checker = client.CreateChecker();

const ALL_CHOICES = ["가위", "바위", "보"];

// 승패 판정(검증용 독립 구현) — 서버와 같은 모듈을 쓰면 서버 버그가 가려진다.
// 1 = a 승, -1 = b 승, 0 = 무승부.
function Judge(a, b) {
    if (a === b) return 0;
    if ((a === "가위" && b === "보") || (a === "바위" && b === "가위") || (a === "보" && b === "바위")) return 1;
    return -1;
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
    conn.Send("JOIN_MATCH", { payload: { game: "rps", select: "Y" } });
    return { conn, match_wait };
}

// 남은 유저가 받는 메시지를 순서대로 쌓아 두고 하나씩 꺼내 쓰는 큐
// (WaitForMessage 로는 "ONE_START/ONE_RESULT 가 번갈아 오는 루프"를 따라갈 수 없다)
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

// 매칭 → 게임방 입장 → GAME_START 까지. 두 연결을 돌려준다.
async function StartGame(mid_x, mid_y) {
    const p_x = await JoinLobbyAndMatch(mid_x);
    const p_y = await JoinLobbyAndMatch(mid_y);
    const [match_x, match_y] = await Promise.all([p_x.match_wait, p_y.match_wait]);
    p_x.conn.Close();
    p_y.conn.Close();
    if (!match_x || !match_y) throw new Error("MATCH_FOUND 를 받지 못했습니다");

    const game_x = await client.ConnectWithSeat({ host, port: rps_port, reservation: match_x.seat_reservation });
    const game_y = await client.ConnectWithSeat({ host, port: rps_port, reservation: match_y.seat_reservation });
    if (!game_x.ok || !game_y.ok) throw new Error("RPS 채널 접속 실패");

    const enter_x = client.WaitForMessage(game_x, "ENTER_ROOM", 8000);
    const enter_y = client.WaitForMessage(game_y, "ENTER_ROOM", 8000);
    game_x.Send("ENTER_ROOM", { payload: {} });
    game_y.Send("ENTER_ROOM", { payload: {} });
    const [room_x] = await Promise.all([enter_x, enter_y]);

    const start_x = client.WaitForMessage(game_x, "GAME_START", 8000);
    game_x.Send("READY", { payload: { ready: "Y" } });
    game_y.Send("READY", { payload: { ready: "Y" } });
    const started = await start_x;
    // match_y 는 drop 모드 정리(같은 세션으로 재접속)에 쓴다
    return { game_x, game_y, room_x, started, match_y };
}

async function Main() {
    console.log(`RPS "나간 유저 자동 모드" 검증 시작 — lobby ws://${host}:${lobby_port}, rps ws://${host}:${rps_port}\n`);

    const mid_a = `a${run_tag}`;
    const mid_b = `b${run_tag}`;
    const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
    const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);

    // --- [1] 매칭 → 게임 시작 ---
    console.log("[1] 매칭 → ENTER_ROOM → READY → GAME_START");
    const { game_x: game_a, game_y: game_b, room_x: room_a, started } = await StartGame(mid_a, mid_b);
    checker.Check("GAME_START 까지 진행됐다", started !== undefined, started === undefined ? "수신 없음" : "수신");
    // player1 = 먼저 입장한 쪽. A 가 먼저 입장하므로 ONE_RESULT 의 player1 이 A 의 선택이다.
    const a_is_player1 = room_a?.player1?.userid === userid_a;
    checker.Check("A 가 player1 이다 (ONE_RESULT 해석 기준)", a_is_player1, `player1=${room_a?.player1?.userid}`);

    const NextA = CreateEventQueue(game_a, ["ONE_START", "ONE_REMAIN_TIME", "ONE_RESULT", "GAME_RESULT", "OUT_USER"]);

    // --- [2] 첫 판이 시작되면 B 가 **선택하지 않은 채** 나간다 ---
    console.log("\n[2] 첫 판(ONE_START) 진행 중에 B 가 나간다 — 선택하지 않은 상태로");
    const first_start = await NextA(15000); // GAME_START 후 RPS_GAME_START_DELAY_SEC(5초) 뒤에 온다
    checker.Check("첫 판 ONE_START 를 받았다", first_start?.type === "ONE_START", `type=${first_start?.type} count=${first_start?.payload?.count}`);

    // A 는 매 판 즉시 선택한다 — 그래도 B 가 선택을 안 하므로 판은 제한 시간까지 간다.
    game_a.Send("SELECT_GAME", { payload: { select: "바위" } });

    if (leave_mode === "drop") {
        console.log("    LEAVE_MODE=drop — B 의 소켓을 그냥 끊는다 → onDrop(5초 뒤 봇 투입)");
        game_b.socket.close();
    } else {
        console.log("    LEAVE_MODE=consent — B 가 명시적으로 나가기 → onDrop 없이 곧장 onLeave");
        game_b.Leave();
    }
    const left_at = Date.now();

    // --- [3] 남은 유저 혼자 끝까지 ---
    console.log("\n[3] A 혼자 끝까지 — A 가 선택하면 그 즉시 판이 끝나고 2선승이 나야 한다");
    let out_user_before_result = null;
    let out_user_after_result = null;
    let game_result = null;
    let rounds = 0;
    let draw_rounds = 0;
    let wrong_judge = 0;
    // 첫 판과 그 뒤 판을 따로 잰다 — 즉시 판정을 **두 경로**로 확인하기 위해서다:
    //   · 첫 판: A 가 **먼저 선택한 뒤** B 가 나갔다 → 나가는 순간(또는 봇 투입 순간) 판정돼야 한다
    //   · 그 뒤 판: B 가 이미 나간 상태에서 A 가 선택했다 → 선택하는 순간 판정돼야 한다
    const round_delays = [];
    const round_ticks = [];
    let current_start_at = first_start?.at ?? left_at;
    let current_ticks = 0;
    let a_win_count = 0;
    let b_win_count = 0;

    for (let guard = 0; guard < 200; guard++) {
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

        if (ev.type === "ONE_REMAIN_TIME") {
            current_ticks++;
            continue;
        }

        if (ev.type === "ONE_START") {
            current_start_at = ev.at;
            current_ticks = 0;
            game_a.Send("SELECT_GAME", { payload: { select: "바위" } });
            continue;
        }

        if (ev.type === "ONE_RESULT") {
            rounds++;
            round_delays.push(ev.at - current_start_at);
            round_ticks.push(current_ticks);

            // player1 = A, player2 = B(나간 유저 — 서버가 대신 낸 값)
            const choice_a = ev.payload.player1;
            const choice_b = ev.payload.player2;
            const judge = Judge(choice_a, choice_b);
            const expected_win = judge === 1 ? userid_a : judge === -1 ? userid_b : undefined;
            if (ev.payload.win !== expected_win) wrong_judge++;
            if (judge === 0) draw_rounds++;
            else if (judge === 1) a_win_count++;
            else b_win_count++;

            if (!ALL_CHOICES.includes(choice_b)) {
                checker.Check(`${rounds}판: 나간 유저의 값이 자동으로 채워졌다`, false, `player2=${JSON.stringify(choice_b)}`);
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

    checker.Check("나간 뒤에도 판이 계속 진행됐다 (게임이 멈추지 않았다)", rounds > 0, `진행된 판 ${rounds}판(무승부 ${draw_rounds}판)`);
    checker.Check("매 판 승패 판정이 독립 계산과 일치한다", wrong_judge === 0, `불일치 ${wrong_judge}판`);
    if (round_delays.length > 0) {
        // (가) 첫 판 — A 가 먼저 선택한 뒤 B 가 나갔다. 나가는(끊기는) **그 순간** 판정돼야 한다.
        // ⚠️ 2026-10-13 수정 전에는 drop 모드에서 이 판이 봇 투입(5초)까지 기다렸고, 이 스크립트가 그걸
        //    "봇 투입 5초 직후 기대" 라며 **정상으로 단정**하고 있었다 — 버그를 기대값으로 적어 둔 것이다.
        //    지금은 끊긴 즉시 자동 모드라 두 모드 모두 즉시여야 한다.
        const first_delay = round_delays[0];
        checker.Check(
            "이미 선택한 상태에서 상대가 나가거나 끊기면 그 즉시 판정된다 (봇 투입 5초도 기다리지 않는다)",
            first_delay < 2000,
            `ONE_START→ONE_RESULT ${first_delay}ms (LEAVE_MODE=${leave_mode})`
        );

        // (나) 그 뒤 판 — B 가 이미 나간 상태에서 A 가 선택한다 → 선택하는 순간 끝나야 한다.
        const later_delays = round_delays.slice(1);
        const later_ticks = round_ticks.slice(1);
        if (later_delays.length > 0) {
            const max_delay = Math.max(...later_delays);
            const avg_delay = Math.round(later_delays.reduce((a, b) => a + b, 0) / later_delays.length);
            checker.Check(
                "나간 뒤의 판은 남은 유저가 선택하는 즉시 끝난다 (제한 시간을 기다리지 않는다)",
                max_delay < 2000,
                `ONE_START→ONE_RESULT 평균 ${avg_delay}ms / 최대 ${max_delay}ms (${later_delays.length}판)`
            );
            checker.Check(
                "그 판들은 ONE_REMAIN_TIME 카운트다운이 거의/전혀 오지 않는다 (1초 안에 끝나므로)",
                Math.max(...later_ticks) <= 1,
                `판별 수신 횟수 최대 ${Math.max(...later_ticks)}회`
            );
        }
    }

    // --- [4] OUT_USER 전송 시점 ---
    console.log("\n[4] OUT_USER 는 게임이 끝난 뒤에 와야 한다");
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

    // --- [5] GAME_RESULT 에 나간 유저가 그대로 담겨 있다 ---
    console.log("\n[5] GAME_RESULT 에 나간 유저 정보가 담겨 있어야 한다");
    checker.Check("GAME_RESULT 를 받았다", game_result !== null, game_result === null ? "수신 없음" : "수신");

    if (game_result) {
        const userids = [game_result.winner?.userid, game_result.loser?.userid];
        checker.Check(
            "winner/loser 에 두 유저가 모두 담겨 있다 (나간 유저 포함)",
            userids.includes(userid_a) && userids.includes(userid_b),
            JSON.stringify(userids)
        );
        const expected_winner = a_win_count >= 2 ? userid_a : userid_b;
        checker.Check(
            "승자가 2선승한 쪽이다",
            game_result.winner?.userid === expected_winner,
            `서버 ${game_result.winner?.userid} / 기대 ${expected_winner} (A ${a_win_count}승 : B ${b_win_count}승)`
        );
        const win_counts = { [userid_a]: a_win_count, [userid_b]: b_win_count };
        checker.Check(
            "win_count 가 각자 이긴 판 수와 일치한다 (무승부 제외)",
            game_result.winner?.win_count === win_counts[game_result.winner.userid] &&
                game_result.loser?.win_count === win_counts[game_result.loser.userid],
            `winner ${game_result.winner?.win_count} / loser ${game_result.loser?.win_count}`
        );
        console.log(`    최종 ${a_win_count}:${b_win_count} (A:B), 승자=${game_result.winner?.userid === userid_b ? "B(나간 유저)" : "A"}`);
    }

    // A 는 나가기를 선택해 방을 정리한다
    game_a.Send("GAME_RESULT", { payload: { replay: "N" } });
    await new Promise((r) => setTimeout(r, 500));
    game_a.Close();

    // --- [6] DB 반영 — 나간 유저의 승패에도 적용됐는지 ---
    console.log("\n[6] DB 에 양쪽 모두의 결과가 반영돼야 한다");
    await new Promise((r) => setTimeout(r, 1500)); // DB 저장은 GAME_RESULT 전송 뒤에 비동기로 돈다

    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/rpsGameLogSchema.js");
    const log_table = log_mod.GetRpsGameLogTableName(new Date());

    // ⚠️ 접두사(LIKE 'zzrps_%')로 세지 않고 **이 게임의 두 유저로** 좁힌다 — 접두사로 세면 앞선 실행이
    //    남긴 행 하나에도 "2행"으로 실패해서 서버 버그처럼 보인다(오델로 검증에서 실제로 겪었다).
    const [log_rows] = await pool.query(
        `SELECT win, lose, vs, score, win_is_bot, lose_is_bot, JSON_LENGTH(plays) AS play_count
         FROM \`${log_table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`,
        [userid_a, userid_b, userid_a, userid_b]
    );
    checker.Check("rps_game_log 에 이 게임이 1행 기록됐다", log_rows.length === 1, `${log_rows.length}행`);

    if (log_rows.length === 1) {
        const row = log_rows[0];
        checker.Check(
            "로그의 win/lose 에 두 유저가 모두 들어 있다 (나간 유저 포함)",
            [row.win, row.lose].includes(userid_a) && [row.win, row.lose].includes(userid_b),
            `win=${row.win} lose=${row.lose} vs=${row.vs} score=${row.score}`
        );
        checker.Check(
            "vs/score 가 2선승 형식이다",
            (row.vs === "2:0" && row.score === 20) || (row.vs === "2:1" && row.score === 10),
            `vs=${row.vs} score=${row.score}`
        );
        // 나간 B 는 서버가 대신 냈으므로 봇으로 기록돼야 한다
        const b_is_bot = row.win === userid_b ? row.win_is_bot : row.lose_is_bot;
        checker.Check("나간 유저가 봇으로 기록됐다 (win_is_bot/lose_is_bot)", b_is_bot === 1, `b_is_bot=${b_is_bot}`);
        const a_is_bot = row.win === userid_a ? row.win_is_bot : row.lose_is_bot;
        checker.Check("남아 있던 유저는 봇이 아니다", a_is_bot === 0, `a_is_bot=${a_is_bot}`);
        checker.Check(
            "plays 에 무승부를 포함한 모든 판이 기록됐다",
            row.play_count === rounds,
            `${row.play_count}판 기록 / 실제 ${rounds}판(무승부 ${draw_rounds}판)`
        );
    }

    const [play_rows] = await pool.query(
        `SELECT userid, total_game_count, total_win_count, total_score FROM rps_user_play_info WHERE userid IN (?, ?) ORDER BY userid`,
        [userid_a, userid_b]
    );
    checker.Check("두 유저의 rps_user_play_info 가 모두 존재한다", play_rows.length === 2, `${play_rows.length}행`);
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
        checker.Check(
            "승자의 승수가 1이다",
            by_userid[game_result.winner.userid]?.total_win_count === 1,
            `A승=${by_userid[userid_a]?.total_win_count} B승=${by_userid[userid_b]?.total_win_count}`
        );
    }

    const [rank_rows] = await pool.query(
        `SELECT userid, score FROM rps_rank_daily WHERE userid IN (?, ?) ORDER BY userid`,
        [userid_a, userid_b]
    );
    checker.Check("랭킹(rps_rank_daily)에도 두 유저가 들어갔다", rank_rows.length === 2, JSON.stringify(rank_rows.map((r) => `${r.userid.slice(-4)}=${r.score}`)));

    // --- [7] 둘 다 나간 경우 — 남은 판을 즉시 판정해 정상적인 2선승 결과를 남긴다 ---
    console.log("\n[7] 둘 다 나가면 남은 판이 즉시 판정되고 DB 에 2선승 결과가 남아야 한다");
    const mid_c = `c${run_tag}`;
    const mid_d = `d${run_tag}`;
    const userid_c = ExpectedUserid(TEST_PARTNER, mid_c);
    const userid_d = ExpectedUserid(TEST_PARTNER, mid_d);

    const { game_x: game_c, game_y: game_d, started: started2 } = await StartGame(mid_c, mid_d);
    checker.Check("두 번째 게임도 GAME_START 까지 진행됐다", started2 !== undefined, started2 === undefined ? "수신 없음" : "수신");

    const NextC = CreateEventQueue(game_c, ["ONE_START"]);
    const first_start2 = await NextC(15000);
    checker.Check("두 번째 게임도 첫 판이 시작됐다", first_start2?.type === "ONE_START", `type=${first_start2?.type}`);

    // 첫 판 진행 중에 둘 다 명시적으로 나간다
    game_c.Leave();
    game_d.Leave();
    const both_left_at = Date.now();
    await new Promise((r) => setTimeout(r, 2500)); // 즉시 판정 + DB 저장(비동기)을 기다린다

    const [log2_rows] = await pool.query(
        `SELECT win, lose, vs, score, win_is_bot, lose_is_bot, JSON_LENGTH(plays) AS play_count, end_time
         FROM \`${log_table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`,
        [userid_c, userid_d, userid_c, userid_d]
    );
    checker.Check("둘 다 나가도 게임 로그가 1행 남는다", log2_rows.length === 1, `${log2_rows.length}행`);
    if (log2_rows.length === 1) {
        const row2 = log2_rows[0];
        checker.Check(
            "중간 점수가 아니라 **정상적인 2선승 결과**로 기록됐다",
            (row2.vs === "2:0" && row2.score === 20) || (row2.vs === "2:1" && row2.score === 10),
            `vs=${row2.vs} score=${row2.score} plays=${row2.play_count}판`
        );
        checker.Check(
            "양쪽 모두 봇으로 기록됐다 (둘 다 나갔으므로)",
            row2.win_is_bot === 1 && row2.lose_is_bot === 1,
            `win_is_bot=${row2.win_is_bot} lose_is_bot=${row2.lose_is_bot}`
        );
        checker.Check(
            "남은 판을 기다리지 않고 즉시 판정했다 (방이 dispose 되기 전에 끝나야 한다)",
            new Date(row2.end_time).getTime() - both_left_at < 2500,
            `나간 뒤 ${new Date(row2.end_time).getTime() - both_left_at}ms 에 종료 (판마다 10초를 기다리면 못 끝낸다)`
        );
    }

    const [play2_rows] = await pool.query(
        `SELECT userid, total_game_count FROM rps_user_play_info WHERE userid IN (?, ?) ORDER BY userid`,
        [userid_c, userid_d]
    );
    checker.Check(
        "두 유저 모두의 승패에 반영됐다",
        play2_rows.length === 2 && play2_rows.every((r) => r.total_game_count === 1),
        JSON.stringify(play2_rows.map((r) => `${r.userid.slice(-4)}=${r.total_game_count}`))
    );

    // --- [8] 사용자 신고 시나리오 (2026-10-13) — 상대가 나간 **직후**(봇 투입 5초 전) 남은 유저가 고르면 즉시 ---
    // "A유저가 게임중 나가서 재입장을 하지 않았고 … 턴 남은 시간이 10 부터 시작". 끊김(drop)은 봇이 끊긴 지
    // 5초 뒤에야 투입돼서, 그 사이 남은 유저가 골라도 판이 끝나지 않고 기다렸다. 여기서는 판이 시작되자마자
    // 상대가 나가고 **1초 뒤** 남은 유저가 고른다 — 그 선택과 동시에 판이 끝나야 한다.
    console.log("\n[8] 상대가 나간 직후(봇 투입 전) 남은 유저가 고르면 그 순간 판이 끝나야 한다");
    const mid_e = `e${run_tag}`;
    const mid_f = `f${run_tag}`;
    const userid_e = ExpectedUserid(TEST_PARTNER, mid_e);
    const userid_f = ExpectedUserid(TEST_PARTNER, mid_f);

    const { game_x: game_e, game_y: game_f, room_x: room_e, match_y: match_f } = await StartGame(mid_e, mid_f);
    checker.Check("세 번째 게임이 시작됐다 (E 가 player1)", room_e?.player1?.userid === userid_e, `player1=${room_e?.player1?.userid}`);

    // drop 모드 정리(재접속 → 명시적 나가기)에 쓸 토큰을 끊기 전에 읽어 둔다
    const activeGame_mod = await import("../dist/game/room/activeGame.js");
    const active_f = await activeGame_mod.GetActiveGame(userid_f);
    const match_f_reservation = match_f?.seat_reservation;

    const NextE = CreateEventQueue(game_e, ["ONE_START", "ONE_RESULT"]);
    const start3 = await NextE(15000);
    checker.Check("세 번째 게임 첫 판이 시작됐다", start3?.type === "ONE_START", `type=${start3?.type}`);

    // 판이 시작되자마자 F 가 나간다(아무것도 고르지 않은 채) — 아직 E 도 고르지 않았다
    if (leave_mode === "drop") game_f.socket.close();
    else game_f.Leave();
    const f_left_at = Date.now();

    await new Promise((r) => setTimeout(r, 1000)); // 1초 뒤 — 봇 투입(5초)보다 한참 전
    const e_selected_at = Date.now();
    game_e.Send("SELECT_GAME", { payload: { select: "바위" } });
    const result3 = await NextE(12000);

    checker.Check("ONE_RESULT 가 왔다", result3?.type === "ONE_RESULT", `type=${result3?.type}`);
    if (result3?.type === "ONE_RESULT") {
        const after_select = result3.at - e_selected_at;
        checker.Check(
            "남은 유저가 고른 **그 순간** 판이 끝났다 (봇 투입 5초도, 제한 시간 10초도 기다리지 않았다)",
            after_select < 500,
            `E 선택→ONE_RESULT ${after_select}ms / F 가 나간 지 ${result3.at - f_left_at}ms (LEAVE_MODE=${leave_mode})`
        );
        checker.Check(
            "나간 유저의 값이 서버에서 채워졌다",
            ALL_CHOICES.includes(result3.payload.player2),
            `player1(E)=${result3.payload.player1} player2(F, 자동)=${result3.payload.player2}`
        );
    }

    // 정리 — 둘 다 **명시적으로** 나가게 해서 즉시 판정 경로로 방을 끝낸다(소켓만 닫으면 재접속 창이 열려
    // 방이 한참 더 돌다가 정리 단계 뒤에 DB 행을 남긴다 — 오델로 검증에서 실제로 겪었다).
    if (leave_mode === "drop" && active_f && match_f_reservation) {
        const f_back = await client.ConnectWithSeat({
            host,
            port: rps_port,
            reservation: { processId: match_f_reservation.processId, roomId: active_f.room_id, sessionId: match_f_reservation.sessionId },
            reconnection_token: active_f.reconnection_token,
            timeout_ms: 8000,
        });
        if (f_back.ok) f_back.Leave();
        await new Promise((r) => setTimeout(r, 500));
    }
    game_e.Leave();
    await new Promise((r) => setTimeout(r, 2500));

    checker.Report();

    // --- 정리 ---
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        console.log(`\n정리 (partner='${TEST_PARTNER}' 인 행만):`);
        await pool.query(`DELETE FROM \`${log_table}\` WHERE win LIKE ? OR lose LIKE ?`, [`${TEST_PARTNER}_%`, `${TEST_PARTNER}_%`]);
        for (const t of ["rps_rank_daily", "rps_rank_weekly", "othello_rank_daily", "othello_rank_weekly", "rps_user_play_info", "othello_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "user_member_info", "user_partner_info"]) {
            const [r] = await pool.query(`DELETE FROM ${t} WHERE userid LIKE ?`, [`${TEST_PARTNER}_%`]);
            if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
        }
        const redis_mod = await import("../dist/db/redis.js");
        const test_userids = [userid_a, userid_b, userid_c, userid_d, userid_e, userid_f];
        for (const userid of test_userids) {
            await redis_mod.DeleteJson(`user:info:${userid}`);
            await redis_mod.DeleteJson(`user:play:rps:${userid}`);
            await redis_mod.DeleteJson(`user:play:othello:${userid}`);
            await redis_mod.DeleteJson(`active_game:${userid}`);
        }
        // 랭킹 ZSET 에도 테스트 유저가 들어가므로 멤버만 지운다 (키 전체를 지우면 실제 랭킹이 날아간다)
        const zset = redis_mod.GetRedisClient();
        const keys = await zset.keys("rank_zset:rps:*");
        for (const key of keys) await zset.zrem(key, ...test_userids);
        zset.disconnect();
        console.log("  Redis 캐시/랭킹 멤버 삭제 완료");
    }
    await pool.end();
}

await Main();
