// 점핑(stepping) e2e 검증 스크립트 (2026-10-14).
//
// 검증 대상:
//   1) 로비 매칭 — JOIN_MATCH{game:"stepping"} → MATCH_FOUND{room_name:"stepping_1"}
//   2) 시작 — READY → MAP_SELECT{map:1~3}(양쪽 같은 맵) → 약 2초 뒤 GAME_START → GAME_REMAIN_TIME 59…
//   3) MOVE_INFO 검증 — 순번 재전송/건너뛰기/너무 빠른 입력은 무시되고, 받아들인 것만 양쪽에 중계된다
//   4) 라이프 — 추락마다 life 가 줄고, **4번째 추락(라이프 0 에서 추락)** 에서 게임이 끝난다
//   5) 승패 — 게임 점수(라이프×10 + 칸×5)로 갈린다: 칸을 더 간 A 가 탈락해서 B 가 이긴다
//   6) 재게임 + 게임 중 퇴장 — B 가 나가도 A 는 계속 뛰고, 제한 시간(60초) 종료 후 GAME_RESULT → 그 직후 OUT_USER
//   7) DB — stepping_game_log 2행(map, vs=게임 점수, plays 개수, lose_is_bot), play_info, rank
//
// ⚠️ 이 스크립트는 지우지 말 것 (CLAUDE.md 10장).
// ⚠️ **DB 에 테스트 유저 2명을 만든다.** 끝나고 자기 행만 지운다(TEST_PARTNER 접두사). KEEP=1 이면 정리 생략.
//
// 사용법 (로비와 점핑 채널이 떠 있어야 한다, 약 80초 걸린다 — 출력을 | head 로 자르지 말 것):
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> STEPPING_PORT=6041 node scripts/check-stepping-game.mjs > out.txt

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
const stepping_port = Number(process.env.STEPPING_PORT ?? 6041);
const keep_rows = process.env.KEEP === "1";

// 기존 유저와 겹치지 않는 접두사. 정리할 때 이 값으로만 지운다.
const TEST_PARTNER = "zzstp";
const run_tag = String(Date.now()).slice(-8);

// 서버의 STEPPING_MIN_MOVE_INTERVAL_MS(150ms)보다 넉넉한 간격
const GAP_MS = 250;

// 서버의 STEPPING_GAME_TIME_SEC 와 같은 값 (2026-10-14 20초 → 60초)
const GAME_TIME_SEC = 60;
// 서버의 STEPPING_RESULT_DELAY_SEC 와 같은 값 — 종료 조건 후 GAME_RESULT 까지 대기 (2026-10-14)
const RESULT_DELAY_SEC = 3;

const checker = client.CreateChecker();
const Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// common/userid.ts 의 ConvertMidToUserid 와 같은 규칙 (XOR key 5)
function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}

// 연결이 받은 S→C 메시지를 전부 시간과 함께 기록한다. 나중에 순서/개수로 단정한다.
function Record(conn) {
    const log = [];
    conn.OnMessage((decoded) => log.push({ type: decoded.type, payload: client.TakePayload(decoded), at: Date.now() }));
    return log;
}

// log 에 type 메시지가 from_index 이후로 생길 때까지 기다린다. 그 메시지의 index 를 돌려준다(없으면 -1).
async function WaitInLog(log, type, timeout_ms, from_index = 0) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const index = log.findIndex((entry, i) => i >= from_index && entry.type === type);
        if (index !== -1) return index;
        await Sleep(50);
    }
    return -1;
}

function Move(conn, count, save, x = 0, y = 0) {
    conn.Send("MOVE_INFO", { payload: { count, location: { x, y }, save } });
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
    conn.Send("JOIN_MATCH", { payload: { game: "stepping", select: "Y" } });
    return { conn, userid: enter_result.userid, match_wait };
}

async function Main() {
    console.log(`점핑 e2e 검증 시작 — lobby ws://${host}:${lobby_port}, stepping ws://${host}:${stepping_port}`);
    const mid_a = `a${run_tag}`;
    const mid_b = `b${run_tag}`;
    const userid_a = ExpectedUserid(TEST_PARTNER, mid_a);
    const userid_b = ExpectedUserid(TEST_PARTNER, mid_b);
    console.log(`테스트 계정: A=${userid_a} / B=${userid_b}\n`);

    // --- 1) 로비 매칭 ---
    console.log('[1] JOIN_MATCH{game:"stepping"} 로 매칭되어야 한다');
    const player_a = await JoinLobbyAndMatch(mid_a);
    const player_b = await JoinLobbyAndMatch(mid_b);
    const [match_a, match_b] = await Promise.all([player_a.match_wait, player_b.match_wait]);
    checker.Check("두 유저 모두 MATCH_FOUND 를 받았다", match_a !== undefined && match_b !== undefined);
    checker.Check('game:"stepping", room_name:"stepping_1"', match_a?.game === "stepping" && match_a?.room_name === "stepping_1", `${match_a?.game} / ${match_a?.room_name}`);
    checker.Check("둘이 같은 방으로 매칭됐다", match_a?.room_id === match_b?.room_id);
    player_a.conn.Close();
    player_b.conn.Close();
    if (!match_a || !match_b) return checker.Report();

    // --- 2) 입장 → READY → MAP_SELECT → GAME_START ---
    console.log("\n[2] ENTER_ROOM → READY → MAP_SELECT → (2초) → GAME_START → GAME_REMAIN_TIME");
    const game_a = await client.ConnectWithSeat({ host, port: stepping_port, reservation: match_a.seat_reservation });
    const game_b = await client.ConnectWithSeat({ host, port: stepping_port, reservation: match_b.seat_reservation });
    if (!game_a.ok || !game_b.ok) throw new Error(`점핑 채널 접속 실패: ${JSON.stringify({ a: game_a, b: game_b })}`);
    const log_a = Record(game_a);
    const log_b = Record(game_b);

    game_a.Send("ENTER_ROOM", { payload: {} });
    game_b.Send("ENTER_ROOM", { payload: {} });
    checker.Check("양쪽이 ENTER_ROOM 응답을 받았다", (await WaitInLog(log_a, "ENTER_ROOM", 6000)) !== -1 && (await WaitInLog(log_b, "ENTER_ROOM", 6000)) !== -1);

    game_a.Send("READY", { payload: { ready: "Y" } });
    game_b.Send("READY", { payload: { ready: "Y" } });
    const map_i_a = await WaitInLog(log_a, "MAP_SELECT", 6000);
    const map_i_b = await WaitInLog(log_b, "MAP_SELECT", 6000);
    const map = log_a[map_i_a]?.payload?.map;
    checker.Check("양쪽이 MAP_SELECT 를 받았고 맵이 같다", map_i_a !== -1 && map_i_b !== -1 && map === log_b[map_i_b]?.payload?.map, `map=${map}`);
    checker.Check("맵 번호가 1~3 이다", [1, 2, 3].includes(map), `map=${map}`);

    const start_i_a = await WaitInLog(log_a, "GAME_START", 6000, map_i_a);
    const delay_ms = start_i_a === -1 ? -1 : log_a[start_i_a].at - log_a[map_i_a].at;
    checker.Check("MAP_SELECT 후 약 2초 뒤 GAME_START", delay_ms >= 1700 && delay_ms <= 2800, `${delay_ms}ms`);
    checker.Check("GAME_START 전에는 GAME_REMAIN_TIME 이 없다", !log_a.slice(0, start_i_a).some((e) => e.type === "GAME_REMAIN_TIME"));

    // --- 3) MOVE_INFO 검증 ---
    console.log("\n[3] MOVE_INFO — 받아들인 것만 양쪽에 중계된다");
    await Sleep(300);
    Move(game_a, 1, "yes", 3, 6);
    await Sleep(GAP_MS);
    Move(game_b, 1, "yes", -2, 1);
    await Sleep(GAP_MS);
    Move(game_b, 1, "yes"); // 재전송 → 무시 (OUT_OF_ORDER)
    await Sleep(GAP_MS);
    Move(game_b, 3, "yes"); // 건너뛰기 → 무시 (OUT_OF_ORDER)
    await Sleep(GAP_MS);
    Move(game_b, 2, "no", 5, 5); // 추락 → life 2
    await Sleep(20);
    Move(game_b, 2, "yes"); // 너무 빠름 → 무시 (TOO_FAST)
    await Sleep(GAP_MS);
    Move(game_b, 2, "yes", 1, 1); // 같은 칸 재도전 → 받아들임
    await Sleep(GAP_MS);
    Move(game_a, 2, "yes");
    await Sleep(GAP_MS);
    Move(game_a, 3, "yes");
    await Sleep(GAP_MS);

    // --- 4) 라이프 / 탈락 ---
    console.log("\n[4] A 가 4번 추락 — 3번째까지는 계속, 4번째에 종료");
    for (let fall = 1; fall <= 3; fall++) {
        Move(game_a, 4, "no");
        await Sleep(GAP_MS);
    }
    checker.Check("라이프 3개를 다 쓸 때까지는 GAME_RESULT 가 없다", !log_a.some((e) => e.type === "GAME_RESULT"));
    const before_last_fall = log_a.length;
    Move(game_a, 4, "no");
    const last_fall_i = await WaitInLog(log_a, "MOVE_INFO", 2000, before_last_fall);
    // 결과 연출 대기(3초) 중에 B 가 뛰어도 받아들이면 안 된다 — 결과가 바뀌면 안 된다
    await Sleep(GAP_MS);
    Move(game_b, 3, "yes");
    const result_i = await WaitInLog(log_a, "GAME_RESULT", (RESULT_DELAY_SEC + 3) * 1000, before_last_fall);
    checker.Check("4번째 추락에서 GAME_RESULT 가 왔다", result_i !== -1);
    const result_delay_ms = result_i === -1 || last_fall_i === -1 ? -1 : log_a[result_i].at - log_a[last_fall_i].at;
    checker.Check(
        `마지막 추락 MOVE_INFO 뒤 약 ${RESULT_DELAY_SEC}초 뒤에 GAME_RESULT (추락 모션 시간)`,
        result_delay_ms >= RESULT_DELAY_SEC * 1000 - 300 && result_delay_ms <= RESULT_DELAY_SEC * 1000 + 800,
        `${result_delay_ms}ms`
    );

    const moves_seen_by_a = log_a.filter((e) => e.type === "MOVE_INFO").map((e) => e.payload);
    const b_moves = moves_seen_by_a.filter((p) => p.userid === userid_b);
    const a_moves = moves_seen_by_a.filter((p) => p.userid === userid_a);
    checker.Check("B 의 MOVE_INFO 는 3개만 중계됐다 (재전송/건너뛰기/너무 빠름/결과 대기 중 무시)", b_moves.length === 3, JSON.stringify(b_moves.map((p) => `${p.count}${p.save}`)));
    checker.Check("A 의 MOVE_INFO 는 7개 중계됐다", a_moves.length === 7, `${a_moves.length}개`);
    checker.Check("B 쪽에도 같은 수(10개)가 중계됐다", log_b.filter((e) => e.type === "MOVE_INFO").length === 10);
    checker.Check("중계에 location 이 그대로 담긴다", a_moves[0]?.location?.x === 3 && a_moves[0]?.location?.y === 6, JSON.stringify(a_moves[0]));
    checker.Check("B 추락 후 life 가 2 로 내려갔다", b_moves[1]?.save === "no" && b_moves[1]?.life === 2, JSON.stringify(b_moves[1]));
    checker.Check("A 의 추락마다 life 가 2→1→0→0 으로 내려갔다", JSON.stringify(a_moves.slice(3).map((p) => p.life)) === "[2,1,0,0]", JSON.stringify(a_moves.slice(3).map((p) => p.life)));

    const remain = log_a.filter((e) => e.type === "GAME_REMAIN_TIME").map((e) => e.payload.count);
    checker.Check(`GAME_REMAIN_TIME 이 ${GAME_TIME_SEC - 1} 부터 1씩 줄었다`, remain.length > 0 && remain[0] === GAME_TIME_SEC - 1 && remain.every((c, i) => c === GAME_TIME_SEC - 1 - i), JSON.stringify(remain));

    // --- 5) 승패 ---
    console.log("\n[5] GAME_RESULT — 칸을 더 간 A(3칸, 라이프 0 = 15점)가 B(2칸, 라이프 2 = 30점)에게 진다");
    const result1 = log_a[result_i]?.payload;
    checker.Check("승자는 B", result1?.winner?.userid === userid_b, JSON.stringify(result1));
    checker.Check("B: win_count 2, life 2, score 30", result1?.winner?.win_count === 2 && result1?.winner?.life === 2 && result1?.winner?.score === 30);
    checker.Check("A: win_count 3, life 0, score 15", result1?.loser?.win_count === 3 && result1?.loser?.life === 0 && result1?.loser?.score === 15);
    checker.Check("무승부가 아니다", result1?.draw === undefined);

    // --- 6) 재게임 + 게임 중 퇴장 ---
    console.log("\n[6] 재게임 → B 가 GAME_START 직후 나감 → A 혼자 2칸 → 60초 종료 → GAME_RESULT 직후 OUT_USER");
    const before_replay = log_a.length;
    game_a.Send("GAME_RESULT", { payload: { replay: "Y" } });
    game_b.Send("GAME_RESULT", { payload: { replay: "Y" } });
    const map2_i = await WaitInLog(log_a, "MAP_SELECT", 6000, before_replay);
    checker.Check("둘 다 재게임 → MAP_SELECT 부터 다시", map2_i !== -1);
    const start2_i = await WaitInLog(log_a, "GAME_START", 6000, map2_i);
    checker.Check("두 번째 GAME_START", start2_i !== -1);

    game_b.Leave();
    await Sleep(GAP_MS);
    Move(game_a, 1, "yes");
    await Sleep(GAP_MS);
    Move(game_a, 2, "yes");
    await Sleep(1000);
    checker.Check("B 가 나가도 게임 중에는 OUT_USER 가 오지 않는다", !log_a.slice(start2_i).some((e) => e.type === "OUT_USER"));

    const result2_i = await WaitInLog(log_a, "GAME_RESULT", (GAME_TIME_SEC + RESULT_DELAY_SEC + 2) * 1000, start2_i);
    const result2 = log_a[result2_i]?.payload;
    const remain2_entries = log_a.slice(start2_i, result2_i).filter((e) => e.type === "GAME_REMAIN_TIME");
    const remain2 = remain2_entries.map((e) => e.payload.count);
    checker.Check(`${GAME_TIME_SEC}초가 다 흐른 뒤 끝났다 (마지막 GAME_REMAIN_TIME 이 0, ${GAME_TIME_SEC}회)`, remain2.at(-1) === 0 && remain2.length === GAME_TIME_SEC, `마지막=${remain2.at(-1)} / ${remain2.length}회`);
    const timeout_delay_ms = result2_i === -1 || remain2_entries.length === 0 ? -1 : log_a[result2_i].at - remain2_entries.at(-1).at;
    checker.Check(
        `GAME_REMAIN_TIME 0 뒤 약 ${RESULT_DELAY_SEC}초 뒤에 GAME_RESULT`,
        timeout_delay_ms >= RESULT_DELAY_SEC * 1000 - 300 && timeout_delay_ms <= RESULT_DELAY_SEC * 1000 + 800,
        `${timeout_delay_ms}ms`
    );
    checker.Check("승자는 A (2칸 + 라이프 3 = 40점 vs B 30점)", result2?.winner?.userid === userid_a && result2?.winner?.score === 40 && result2?.loser?.score === 30, JSON.stringify(result2));
    const out_i = await WaitInLog(log_a, "OUT_USER", 3000, result2_i);
    checker.Check("GAME_RESULT 직후 OUT_USER{B}", out_i > result2_i && log_a[out_i]?.payload?.userid === userid_b, JSON.stringify(log_a[out_i]?.payload));
    game_a.Send("GAME_RESULT", { payload: { replay: "N" } });

    // --- 7) DB ---
    console.log("\n[7] DB 반영 — stepping_game_log / play_info / rank");
    await Sleep(1500);
    const conn_mod = await import("../dist/db/connection.js");
    const pool = conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/steppingGameLogSchema.js");
    const table = log_mod.GetSteppingGameLogTableName(new Date());

    const [logs] = await pool.query(
        `SELECT map, win, lose, vs, score, is_draw, win_is_bot, lose_is_bot, JSON_LENGTH(plays) AS play_count FROM \`${table}\` WHERE win IN (?, ?) ORDER BY id`,
        [userid_a, userid_b]
    );
    checker.Check("stepping_game_log 에 2게임이 기록됐다", logs.length === 2, `${logs.length}행`);
    if (logs.length === 2) {
        checker.Check("1게임: map 일치, vs '30:15', score 20, plays 10개", logs[0].map === map && logs[0].vs === "30:15" && logs[0].score === 20 && Number(logs[0].play_count) === 10, JSON.stringify(logs[0]));
        checker.Check("2게임: 나간 B 가 lose_is_bot=1, vs '40:30'", logs[1].lose === userid_b && logs[1].lose_is_bot === 1 && logs[1].vs === "40:30", JSON.stringify(logs[1]));
    }

    const [plays] = await pool.query(`SELECT userid, total_game_count, total_win_count FROM stepping_user_play_info WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    checker.Check("stepping_user_play_info 두 유저 모두 2게임 1승", plays.length === 2 && plays.every((p) => p.total_game_count === 2 && p.total_win_count === 1), JSON.stringify(plays));
    const [ranks] = await pool.query(`SELECT userid, score FROM stepping_rank_daily WHERE userid IN (?, ?)`, [userid_a, userid_b]);
    checker.Check("stepping_rank_daily 두 유저 모두 20점", ranks.length === 2 && ranks.every((r) => r.score === 20), JSON.stringify(ranks));

    game_a.Leave();
    checker.Report();

    // --- 정리 ---
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        console.log(`\n정리 (이번 테스트 유저 행만):`);
        await pool.query(`DELETE FROM \`${table}\` WHERE win IN (?, ?) OR lose IN (?, ?)`, [userid_a, userid_b, userid_a, userid_b]);
        for (const t of ["stepping_rank_daily", "stepping_rank_weekly", "stepping_user_play_info", "othello_user_play_info", "rps_user_play_info", "airhockey_user_play_info", "user_member_info", "user_partner_info"]) {
            const [r] = await pool.query(`DELETE FROM ${t} WHERE userid IN (?, ?)`, [userid_a, userid_b]);
            if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
        }
        const redis_mod = await import("../dist/db/redis.js");
        const redis = redis_mod.GetRedisClient();
        for (const userid of [userid_a, userid_b]) {
            await redis_mod.DeleteJson(`user:info:${userid}`);
            for (const game of ["rps", "othello", "stepping"]) await redis_mod.DeleteJson(`user:play:${game}:${userid}`);
        }
        // 랭킹 Sorted Set 에서도 테스트 유저를 뺀다 (안 빼면 실제 랭킹 화면에 테스트 유저가 보인다)
        const zset_keys = await redis.keys("rank_zset:stepping:*");
        for (const key of zset_keys) await redis.zrem(key, userid_a, userid_b);
        redis.disconnect();
        console.log("  Redis 캐시/랭킹 삭제 완료");
    }
    await pool.end();
}

await Main();
