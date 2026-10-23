// 청기백기(flag, 1인) e2e 검증 스크립트 (2026-10-22).
//
// 검증 대상:
//   1) 로비 매칭 — JOIN_MATCH{game:"flag"} 즉시(상대 없이) MATCH_FOUND{room_name:"flag_1"}, opponent 없음
//   2) 입장 — ENTER_ROOM 응답에 player1 만 있다 → READY → GAME_START → ONE_START{no:1,total:5} → QUEST_SHOW{quest,time:5}
//   3) 판정(2026-10-23 정지 버튼 — say 기준, 처음 온 답 하나로 즉시 판정) — 대표 정답(즉시 Y, 뒤에 보낸 답 무시) /
//      반대 방향 정답(내리지마→올림, 올리지마→내림 → Y) / 깃발 둘 중 하나만 보냄(신고 사례) 또는 틀린 방향(즉시 N) /
//      무응답(제한 시간 5초 뒤 N, answer 둘 다 null) / 정답
//      → 마지막 ONE_RESULT 3초 뒤 GAME_RESULT{score:15, correct_count:3, win_per:60}
//   4) 재게임 Y → 같은 방에서 GAME_START 부터 → 5문제 정답 → GAME_RESULT 무응답 10초 → RETURN_TO_LOBBY
//   5) 게임 중 명시적 나가기(LEAVE) — 1문제 맞힌 뒤 나가면 그 점수(5점)로 저장, is_quit=1
//   6) 게임 중 끊김(소켓 닫기) — 재접속 없이 같은 처리. 다시 로비에 들어와도 REJOIN_GAME 이 오지 않는다(방 없음)
//   7) DB — flag_game_log 4행, flag_user_play_info(4게임, 맞춘 수 누적), flag_rank_daily(점수 합)
//   8) 문구 코드(2026-10-23) — 모든 QUEST_SHOW 의 say 가 quest 와 맞는지(움직임 = up/down, 정지 = no_up/no_down/"",
//      양쪽 다 "" 없음). (양손 정지 문제의 "안 누르고 버티기" 검사는 정지 버튼 추가로 없앴다 — 이제 무응답은 항상 N)
//
// ⚠️ 이 스크립트는 지우지 말 것 (CLAUDE.md 10장).
// ⚠️ **DB 에 테스트 유저 1명을 만든다.** 끝나고 자기 행만 지운다(TEST_PARTNER 접두사). KEEP=1 이면 정리 생략.
// ⚠️ 1인 게임이라 로비 매칭 큐가 실제 클라이언트와 섞이지 않는다(상대를 고르지 않음). 그래도 공지 등 다른
//    부작용은 없다.
//
// 사용법 (로비와 청기백기 채널이 떠 있어야 한다, 약 100초 걸린다 — 출력을 | head 로 자르지 말 것):
//   LOBBY_PORT=6011 LOBBY_ROOM_ID=<방id> FLAG_PORT=6061 node scripts/check-flag-game.mjs > out.txt

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
const flag_port = Number(process.env.FLAG_PORT ?? 6061);
const keep_rows = process.env.KEEP === "1";

// 기존 유저와 겹치지 않는 접두사. 정리할 때 이 값으로만 지운다.
const TEST_PARTNER = "zzflg";
const run_tag = String(Date.now()).slice(-8);

// 서버 flagConstants 와 같은 값
const ANSWER_TIME_SEC = 5; // 2026-10-23 2초 → 5초
const RESULT_DELAY_SEC = 3;
const REMATCH_TIMEOUT_SEC = 10;

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
        await Sleep(20);
    }
    return -1;
}

// 답 보내기 — 2026-10-23 정지 버튼 추가 뒤: 값은 1 올림 / 0 정지 / -1 내림, 안 누른 깃발은 키를 뺀다.
// 문제에 나온 깃발의 버튼을 모두 담아 **한 번에** 보낸다(서버는 처음 온 답 하나로 판정).
function Answer(conn, answer) {
    conn.Send("QUEST_SHOW", { payload: { quest: answer } });
}

// 문구(say)에 맞는 대표 정답 — 올려 1 / 내려 -1 / 올리지마·내리지마 정지(0) / 말 안 함은 안 누름(키 없음)
const CORRECT_BY_SAY = { up: 1, down: -1, no_up: 0, no_down: 0 };
// 다른 정답 — 내리지마 → 올림, 올리지마 → 내림 (사용자 결정: 정지 말고 반대 방향도 정답)
const ALT_CORRECT_BY_SAY = { up: 1, down: -1, no_up: -1, no_down: 1 };
// 오답 — 문구와 반대 방향
const WRONG_BY_SAY = { up: -1, down: 1, no_up: 1, no_down: -1 };

function AnswerBySay(say, table) {
    const answer = {};
    if (say.b !== "") answer.b = table[say.b];
    if (say.w !== "") answer.w = table[say.w];
    return answer;
}

function SendCorrect(conn, say) {
    Answer(conn, AnswerBySay(say, CORRECT_BY_SAY));
}

// 문제에 나온 깃발이 둘인지 — 신고 사례("청기 올려, 백기 내리지마" 에서 청기만 보내기) 재현용
function IsTwoFlagSay(say) {
    return say.b !== "" && say.w !== "";
}

// say 가 quest 와 맞는지 — 움직이는 손은 up/down, 정지는 no_up/no_down/"", 양쪽 다 "" 는 없음
function IsSayValid(quest, say) {
    if (!quest || !say) return false;
    const ok = (move, code) => (move === 1 ? code === "up" : move === -1 ? code === "down" : ["no_up", "no_down", ""].includes(code));
    return ok(quest.b, say.b) && ok(quest.w, say.w) && (say.b !== "" || say.w !== "");
}

async function EnterLobby(mid) {
    const reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: `lobby_${lobby_channel_no}`, room_id: lobby_room_id });
    const conn = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!conn.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(conn)}`);
    const lobby_log = Record(conn);

    conn.Send("ENTER_LOBBY", { payload: { partner: TEST_PARTNER, mid, gender: "M", phone: "01000000000" } });
    const enter_i = await WaitInLog(lobby_log, "ENTER_LOBBY", 6000);
    const enter_result = lobby_log[enter_i]?.payload;
    if (enter_result?.result !== "Y") throw new Error(`ENTER_LOBBY 실패: ${JSON.stringify(enter_result)}`);
    return { conn, lobby_log, userid: enter_result.userid };
}

// 로비 → JOIN_MATCH{flag} → MATCH_FOUND → 게임방 접속 → ENTER_ROOM → READY → GAME_START 까지
async function StartNewGame(mid) {
    const lobby = await EnterLobby(mid);
    lobby.conn.Send("JOIN_MATCH", { payload: { game: "flag", select: "Y" } });
    const match_i = await WaitInLog(lobby.lobby_log, "MATCH_FOUND", 6000);
    const match = lobby.lobby_log[match_i]?.payload;
    lobby.conn.Close();
    if (!match) throw new Error("MATCH_FOUND 가 오지 않았다");

    const game = await client.ConnectWithSeat({ host, port: flag_port, reservation: match.seat_reservation });
    if (!game.ok) throw new Error(`청기백기 채널 접속 실패: ${JSON.stringify(game)}`);
    const log = Record(game);
    game.Send("ENTER_ROOM", { payload: {} });
    const enter_i = await WaitInLog(log, "ENTER_ROOM", 6000);
    game.Send("READY", { payload: { ready: "Y" } });
    const start_i = await WaitInLog(log, "GAME_START", 6000);
    return { match, game, log, enter: log[enter_i]?.payload, start_i };
}

// 다음 QUEST_SHOW 를 기다려 { quest, index } 를 돌려준다
async function NextQuest(log, from_index) {
    const index = await WaitInLog(log, "QUEST_SHOW", 8000, from_index);
    return { quest: log[index]?.payload?.quest, payload: log[index]?.payload, index };
}

async function NextOneResult(log, from_index, timeout_ms = 4000) {
    const index = await WaitInLog(log, "ONE_RESULT", timeout_ms, from_index);
    return { result: log[index]?.payload, index, at: log[index]?.at };
}

async function Main() {
    console.log(`청기백기 e2e 검증 시작 — lobby ws://${host}:${lobby_port}, flag ws://${host}:${flag_port}`);
    const mid = `f${run_tag}`;
    const userid = ExpectedUserid(TEST_PARTNER, mid);
    console.log(`테스트 계정: ${userid}\n`);

    let pool = null;
    try {
        // --- 1) 로비 매칭 + 2) 입장 ---
        console.log('[1] JOIN_MATCH{game:"flag"} → 상대 없이 바로 MATCH_FOUND');
        const g1 = await StartNewGame(mid);
        checker.Check('game:"flag", room_name:"flag_1"', g1.match.game === "flag" && g1.match.room_name === "flag_1", `${g1.match.game} / ${g1.match.room_name}`);
        checker.Check("MATCH_FOUND 에 opponent 가 없다", g1.match.opponent === undefined, JSON.stringify(g1.match.opponent));

        console.log("\n[2] ENTER_ROOM → READY → GAME_START → ONE_START → QUEST_SHOW");
        checker.Check("ENTER_ROOM 에 player1 만 있다", g1.enter?.player1?.userid === userid && g1.enter?.player2 === undefined, JSON.stringify(g1.enter));
        checker.Check("READY 뒤 GAME_START", g1.start_i !== -1);
        const one_start_i = await WaitInLog(g1.log, "ONE_START", 5000, g1.start_i);
        checker.Check("ONE_START{no:1,total:5}", g1.log[one_start_i]?.payload?.no === 1 && g1.log[one_start_i]?.payload?.total === 5, JSON.stringify(g1.log[one_start_i]?.payload));

        // --- 3) 판정 5종 ---
        console.log("\n[3] 문제 5개 — 대표 정답 / 반대 방향 정답(내리지마→올림) / 오답(부분 답·틀린 방향) / 무응답 / 정답");
        let q = await NextQuest(g1.log, one_start_i);
        checker.Check(`QUEST_SHOW{quest, say, time:${ANSWER_TIME_SEC}}`, q.quest !== undefined && q.payload?.say !== undefined && q.payload?.time === ANSWER_TIME_SEC, JSON.stringify(q.payload));
        let sent_at = Date.now();
        let sent = AnswerBySay(q.payload.say, CORRECT_BY_SAY);
        Answer(g1.game, sent);
        let r = await NextOneResult(g1.log, q.index);
        checker.Check(`① 대표 정답(문구 ${JSON.stringify(q.payload.say)}, 답 ${JSON.stringify(sent)}) → 즉시 Y, score 5`, r.result?.quest === "Y" && r.result?.score === 5 && r.at - sent_at < 1000, `${JSON.stringify(r.result)} ${r.at - sent_at}ms`);
        // 판정 뒤 온 답은 무시돼야 한다 — 두 번째 ONE_RESULT 가 없어야 함
        Answer(g1.game, AnswerBySay(q.payload.say, WRONG_BY_SAY));

        q = await NextQuest(g1.log, r.index);
        const extra_results = g1.log.filter((entry, i) => i > r.index && i < q.index && entry.type === "ONE_RESULT").length;
        checker.Check("판정 뒤 다시 보낸 답은 무시된다 (ONE_RESULT 한 번)", extra_results === 0, `${extra_results}개 더 옴`);
        sent = AnswerBySay(q.payload.say, ALT_CORRECT_BY_SAY);
        Answer(g1.game, sent);
        r = await NextOneResult(g1.log, q.index);
        checker.Check(`② 반대 방향 정답(문구 ${JSON.stringify(q.payload.say)}, 답 ${JSON.stringify(sent)}) → Y, score 10`, r.result?.quest === "Y" && r.result?.score === 10, JSON.stringify(r.result));

        q = await NextQuest(g1.log, r.index);
        sent_at = Date.now();
        // 신고 사례: 깃발 둘인 문제에 한쪽만 맞게 보내면 정답이 아니어야 한다. 한쪽 문제면 틀린 방향을 보낸다.
        const say3 = q.payload.say;
        if (IsTwoFlagSay(say3)) {
            sent = { b: CORRECT_BY_SAY[say3.b] };
        } else {
            sent = AnswerBySay(say3, WRONG_BY_SAY);
        }
        Answer(g1.game, sent);
        r = await NextOneResult(g1.log, q.index);
        checker.Check(`③ ${IsTwoFlagSay(say3) ? "깃발 둘 중 하나만 정답" : "틀린 방향"}(문구 ${JSON.stringify(say3)}, 답 ${JSON.stringify(sent)}) → 즉시 N, score 그대로 10`, r.result?.quest === "N" && r.result?.score === 10 && r.at - sent_at < 1000, `${JSON.stringify(r.result)} ${r.at - sent_at}ms`);

        q = await NextQuest(g1.log, r.index);
        const shown_at = g1.log[q.index].at;
        r = await NextOneResult(g1.log, q.index, ANSWER_TIME_SEC * 1000 + 2000);
        const waited = r.at - shown_at;
        // 양손 정지 문제도 버튼을 눌러야 정답이라(2026-10-23) 무응답은 항상 N
        const game1_correct = 3;
        checker.Check(`④ 무응답(문구 ${JSON.stringify(q.payload.say)}) → ${ANSWER_TIME_SEC}초 뒤 N, answer 둘 다 null`, r.result?.quest === "N" && r.result?.answer?.b === null && r.result?.answer?.w === null && waited >= ANSWER_TIME_SEC * 1000 - 200 && waited < ANSWER_TIME_SEC * 1000 + 800, `${JSON.stringify(r.result)} ${waited}ms`);

        q = await NextQuest(g1.log, r.index);
        SendCorrect(g1.game, q.payload.say);
        r = await NextOneResult(g1.log, q.index);
        checker.Check(`⑤ 정답 → Y, score ${game1_correct * 5}`, r.result?.quest === "Y" && r.result?.score === game1_correct * 5, JSON.stringify(r.result));

        const result_i = await WaitInLog(g1.log, "GAME_RESULT", 6000, r.index);
        const result_wait = g1.log[result_i]?.at - r.at;
        const result1 = g1.log[result_i]?.payload;
        checker.Check("마지막 ONE_RESULT 3초 뒤 GAME_RESULT", result_i !== -1 && result_wait >= RESULT_DELAY_SEC * 1000 - 200 && result_wait < RESULT_DELAY_SEC * 1000 + 800, `${result_wait}ms`);
        checker.Check(`GAME_RESULT{score:${game1_correct * 5}, correct_count:${game1_correct}, win_per:${game1_correct * 20}}`, result1?.score === game1_correct * 5 && result1?.correct_count === game1_correct && result1?.win_per === game1_correct * 20, JSON.stringify(result1));

        // --- 4) 재게임 → 만점 → 재게임 무응답 ---
        console.log("\n[4] 재게임 Y → GAME_START 부터 → 5문제 정답 → 무응답 10초 → RETURN_TO_LOBBY");
        g1.game.Send("GAME_RESULT", { payload: { replay: "Y" } });
        const restart_i = await WaitInLog(g1.log, "GAME_START", 3000, result_i);
        checker.Check("재게임 GAME_START (READY 없이)", restart_i !== -1);
        let from = restart_i;
        for (let i = 0; i < 5; i++) {
            q = await NextQuest(g1.log, from);
            SendCorrect(g1.game, q.payload.say);
            r = await NextOneResult(g1.log, q.index);
            from = r.index;
        }
        checker.Check("5문제 모두 Y, score 25", r.result?.quest === "Y" && r.result?.score === 25, JSON.stringify(r.result));
        const result2_i = await WaitInLog(g1.log, "GAME_RESULT", 6000, from);
        const result2 = g1.log[result2_i]?.payload;
        const win_per2 = Math.round(((game1_correct + 5) / 10) * 100);
        checker.Check(`GAME_RESULT{score:25, correct_count:5, win_per:${win_per2}} — (${game1_correct}+5)/(2×5)`, result2?.score === 25 && result2?.correct_count === 5 && result2?.win_per === win_per2, JSON.stringify(result2));

        // --- 문구 코드 (1·2게임에서 받은 모든 QUEST_SHOW) ---
        console.log("\n[8] QUEST_SHOW.say 문구 코드");
        const shows = g1.log.filter((entry) => entry.type === "QUEST_SHOW");
        const bad_say = shows.filter((entry) => !IsSayValid(entry.payload?.quest, entry.payload?.say));
        checker.Check(`QUEST_SHOW ${shows.length}개 모두 say 가 quest 와 맞다`, shows.length === 10 && bad_say.length === 0, JSON.stringify(bad_say.map((entry) => entry.payload)));
        console.log(`  받은 문제: ${shows.map((entry) => `${JSON.stringify(entry.payload.quest)}${JSON.stringify(entry.payload.say)}`).join(" ")}`);
        const lobby_i = await WaitInLog(g1.log, "RETURN_TO_LOBBY", (REMATCH_TIMEOUT_SEC + 2) * 1000, result2_i);
        const lobby_wait = g1.log[lobby_i]?.at - g1.log[result2_i]?.at;
        checker.Check("무응답 10초 → RETURN_TO_LOBBY", lobby_i !== -1 && lobby_wait >= REMATCH_TIMEOUT_SEC * 1000 - 300, `${lobby_wait}ms`);
        g1.game.Close();

        // --- 5) 게임 중 명시적 나가기 ---
        console.log("\n[5] 1문제 맞히고 게임 중 나가기(LEAVE) → 현재 점수로 저장");
        const g2 = await StartNewGame(mid);
        q = await NextQuest(g2.log, g2.start_i);
        SendCorrect(g2.game, q.payload.say);
        r = await NextOneResult(g2.log, q.index);
        checker.Check("1문제 정답", r.result?.quest === "Y");
        g2.game.Leave();
        await Sleep(500);

        // --- 6) 게임 중 끊김 ---
        console.log("\n[6] 1문제 맞히고 소켓 끊기(drop) → 재접속 없이 저장, 로비 재입장 시 REJOIN_GAME 없음");
        const g3 = await StartNewGame(mid);
        q = await NextQuest(g3.log, g3.start_i);
        SendCorrect(g3.game, q.payload.say);
        r = await NextOneResult(g3.log, q.index);
        checker.Check("1문제 정답", r.result?.quest === "Y");
        g3.game.Close();
        await Sleep(1500);
        const relobby = await EnterLobby(mid);
        const rejoin_i = await WaitInLog(relobby.lobby_log, "REJOIN_GAME", 2000);
        checker.Check("끊긴 뒤 로비에 다시 들어와도 REJOIN_GAME 이 오지 않는다 (방이 없어짐)", rejoin_i === -1);
        relobby.conn.Leave();

        // --- 7) DB ---
        console.log("\n[7] DB 반영 — flag_game_log / play_info / rank");
        await Sleep(1500);
        const conn_mod = await import("../dist/db/connection.js");
        pool = conn_mod.GetDbPool();
        const log_mod = await import("../dist/db/flagGameLogSchema.js");
        const table = log_mod.GetFlagGameLogTableName(new Date());

        const [logs] = await pool.query(
            `SELECT score, correct_count, quest_count, is_quit, JSON_LENGTH(plays) AS play_count, JSON_EXTRACT(plays, '$[0].say') AS first_say FROM \`${table}\` WHERE userid = ? ORDER BY id`,
            [userid]
        );
        const Row = (row) => row && [row.score, row.correct_count, row.quest_count, row.is_quit, Number(row.play_count)].join(",");
        checker.Check("flag_game_log 에 4게임이 기록됐다", logs.length === 4, `${logs.length}행`);
        checker.Check("plays 에 say(문구 코드)가 남는다", logs.length > 0 && logs.every((row) => row.first_say !== null), JSON.stringify(logs.map((row) => row.first_say)));
        checker.Check(`1게임: ${game1_correct * 5}점, ${game1_correct}개, 5문제, 완주`, Row(logs[0]) === `${game1_correct * 5},${game1_correct},5,0,5`, Row(logs[0]));
        checker.Check("2게임: 25점, 5개, 5문제, 완주", Row(logs[1]) === "25,5,5,0,5", Row(logs[1]));
        checker.Check("3게임(나가기): 5점, 1개, 1문제, is_quit=1", Row(logs[2]) === "5,1,1,1,1", Row(logs[2]));
        checker.Check("4게임(끊김): 5점, 1개, 1문제, is_quit=1", Row(logs[3]) === "5,1,1,1,1", Row(logs[3]));

        const [plays] = await pool.query(`SELECT total_game_count, total_win_count, total_score FROM flag_user_play_info WHERE userid = ?`, [userid]);
        const total_correct = game1_correct + 5 + 1 + 1;
        checker.Check(`flag_user_play_info: 4게임, 맞춘 수 ${total_correct}, 점수 ${total_correct * 5}`, plays[0]?.total_game_count === 4 && plays[0]?.total_win_count === total_correct && plays[0]?.total_score === total_correct * 5, JSON.stringify(plays[0]));
        const [ranks] = await pool.query(`SELECT score FROM flag_rank_daily WHERE userid = ?`, [userid]);
        checker.Check(`flag_rank_daily ${total_correct * 5}점`, ranks[0]?.score === total_correct * 5, JSON.stringify(ranks[0]));
    } catch (error) {
        checker.Check("예외 없이 끝났다", false, error instanceof Error ? error.message : String(error));
    } finally {
        checker.Report();
        await Cleanup(pool, userid);
    }
}

async function Cleanup(existing_pool, userid) {
    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
        if (existing_pool) await existing_pool.end();
        return;
    }
    console.log(`\n정리 (이번 테스트 유저 행만):`);
    const conn_mod = await import("../dist/db/connection.js");
    const pool = existing_pool ?? conn_mod.GetDbPool();
    const log_mod = await import("../dist/db/flagGameLogSchema.js");
    const table = log_mod.GetFlagGameLogTableName(new Date());
    await pool.query(`DELETE FROM \`${table}\` WHERE userid = ?`, [userid]).catch(() => undefined);
    for (const t of ["flag_rank_daily", "flag_rank_weekly", "flag_user_play_info", "airhockey_user_play_info", "stepping_user_play_info", "othello_user_play_info", "rps_user_play_info", "user_member_info", "user_partner_info"]) {
        const [r] = await pool.query(`DELETE FROM ${t} WHERE userid = ?`, [userid]);
        if (r.affectedRows > 0) console.log(`  ${t}: ${r.affectedRows}행 삭제`);
    }
    const redis_mod = await import("../dist/db/redis.js");
    const redis = redis_mod.GetRedisClient();
    await redis_mod.DeleteJson(`user:info:${userid}`);
    for (const game of ["rps", "othello", "stepping", "airhockey", "flag"]) await redis_mod.DeleteJson(`user:play:${game}:${userid}`);
    // 랭킹 Sorted Set 에서도 테스트 유저를 뺀다 (안 빼면 실제 랭킹 화면에 테스트 유저가 보인다)
    const zset_keys = await redis.keys("rank_zset:flag:*");
    for (const key of zset_keys) await redis.zrem(key, userid);
    redis.disconnect();
    console.log("  Redis 캐시/랭킹 삭제 완료");
    await pool.end();
}

await Main();
