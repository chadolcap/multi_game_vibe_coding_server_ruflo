// 게임 시작 star 차감 실서버 검증 스크립트
//
// 확인 내용 (청기백기 = 1인, 가위바위보 = 2인 대표):
//   1) 방에 들어와 READY 없이 나가면 star 그대로
//   2) READY → GAME_START 직후 DB·Redis star -1
//   3) 재게임 Y 도 -1, 같은 방에서 GAME_START
//   4) star 0 에서 재게임 Y → GAME_START 없이 RETURN_TO_LOBBY
//   5) star 0 으로 JOIN_MATCH → ERROR{NOT_ENOUGH_STAR}, 로비 연결 유지 → 광고로 충전하면 매칭됨
//   6) 2인: star 없는 쪽만 재게임 Y 여도 로비로, 남은 쪽은 재게임 star 를 쓰지 않고 새 상대를 기다림
//   7) 오델로·점핑·에어하키도 GAME_START 때 양쪽 -1
//
// ⚠️ DB 에 테스트 유저(partner=zzstar)를 만들고 끝에 자기 행만 지운다. KEEP=1 이면 남긴다.
// ⚠️ 6)·7) 은 공용 로비 매칭 큐를 쓴다 — 테스트 유저끼리 매칭되지 않으면 그 단계를 실패로 끝내고 정리한다.
//
// 사용법 (dev 서버가 떠 있을 때, 약 90초): node scripts/check-star-spend.mjs > out.txt

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const flag_port = Number(process.env.FLAG_PORT ?? 6061);
const rps_port = Number(process.env.RPS_PORT ?? 6021);
const keep_rows = process.env.KEEP === "1";

const TEST_PARTNER = "zzstar";
const run_tag = String(Date.now()).slice(-8);
const MID_SOLO = `s${run_tag}`;
const MID_A = `a${run_tag}`;
const MID_B = `b${run_tag}`;

const checker = client.CreateChecker();
const Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ExpectedUserid(mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${TEST_PARTNER}_${xored}`;
}
const ALL_USERIDS = [MID_SOLO, MID_A, MID_B].map(ExpectedUserid);

// 받은 메시지를 모두 쌓아 두고, 아직 안 꺼낸 것 중 type 이 맞는 첫 메시지를 기다린다.
function Track(connection) {
    const received = [];
    connection.OnMessage((decoded) => received.push({ type: decoded.type, payload: client.TakePayload(decoded) }));
    return {
        connection,
        received,
        async WaitFor(type, timeout_ms = 8000) {
            const deadline = Date.now() + timeout_ms;
            while (Date.now() < deadline) {
                const index = received.findIndex((message) => message.type === type);
                if (index !== -1) return received.splice(index, 1)[0].payload ?? {};
                await Sleep(20);
            }
            return undefined;
        },
    };
}

async function EnterLobby(mid) {
    const reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: "lobby_1" });
    const connection = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!connection.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(connection)}`);
    const lobby = Track(connection);
    connection.Send("ENTER_LOBBY", { partner: TEST_PARTNER, mid, gender: "F", phone: "01000000000" });
    const entered = await lobby.WaitFor("ENTER_LOBBY");
    return { lobby, entered };
}

async function EnterRoom(port, match) {
    const connection = await client.ConnectWithSeat({ host, port, reservation: match.seat_reservation });
    if (!connection.ok) throw new Error(`게임방 접속 실패: ${JSON.stringify(connection)}`);
    return Track(connection);
}

async function Main() {
    const conn = await import("../dist/db/connection.js");
    const redis = await import("../dist/db/redis.js");
    const pool = conn.GetDbPool();

    async function DbStar(userid) {
        const [rows] = await pool.query("SELECT star FROM user_member_info WHERE userid = ?", [userid]);
        return rows[0]?.star;
    }
    async function SetStar(userid, star) {
        await pool.query("UPDATE user_member_info SET star = ? WHERE userid = ?", [star, userid]);
        await redis.DeleteJson(`user:info:${userid}`);
    }
    async function CheckStar(label, userid, expected) {
        await Sleep(300); // 차감은 응답을 늦추지 않으려고 기다리지 않는다
        const db_star = await DbStar(userid);
        const cached = await redis.GetJson(`user:info:${userid}`);
        checker.Check(`${label}: DB·Redis star = ${expected}`, db_star === expected && cached?.star === expected, `db=${db_star} redis=${cached?.star}`);
    }
    // 5문제를 바로 답해서 GAME_RESULT 까지 진행한다 (약 18초)
    async function PlayFlagGame(room) {
        for (let no = 0; no < 5; no++) {
            await room.WaitFor("QUEST_SHOW");
            room.connection.Send("QUEST_SHOW", { quest: { b: 1, w: 1 } });
            await room.WaitFor("ONE_RESULT");
        }
        return room.WaitFor("GAME_RESULT");
    }

    const userid_solo = ExpectedUserid(MID_SOLO);
    console.log(`star 차감 검증 시작 — ${ALL_USERIDS.join(", ")}\n`);
    try {
        console.log("[1] 방에 들어왔다 그냥 나가면 차감 없음");
        const first = await EnterLobby(MID_SOLO);
        checker.Check("신규 유저 star = 5", first.entered?.star === 5, JSON.stringify(first.entered));
        first.lobby.connection.Send("JOIN_MATCH", { game: "flag", select: "Y" });
        const match_1 = await first.lobby.WaitFor("MATCH_FOUND");
        const room_1 = await EnterRoom(flag_port, match_1);
        room_1.connection.Send("ENTER_ROOM", {});
        await room_1.WaitFor("ENTER_ROOM");
        room_1.connection.Leave();
        await CheckStar("READY 없이 퇴장", userid_solo, 5);

        console.log("\n[2] 게임 시작 -1 · 재게임 -1 · star 0 재게임은 로비로");
        await Sleep(500);
        await SetStar(userid_solo, 2);
        const second = await EnterLobby(MID_SOLO);
        checker.Check("ENTER_LOBBY star = 2", second.entered?.star === 2, `star=${second.entered?.star}`);
        second.lobby.connection.Send("JOIN_MATCH", { game: "flag", select: "Y" });
        const match_2 = await second.lobby.WaitFor("MATCH_FOUND");
        const room_2 = await EnterRoom(flag_port, match_2);
        room_2.connection.Send("ENTER_ROOM", {});
        await room_2.WaitFor("ENTER_ROOM");
        room_2.connection.Send("READY", { ready: "Y" });
        checker.Check("GAME_START 수신", (await room_2.WaitFor("GAME_START")) !== undefined);
        await CheckStar("게임 시작", userid_solo, 1);

        const flag_result_1 = await PlayFlagGame(room_2);
        checker.Check("GAME_RESULT.star = 1", flag_result_1?.star === 1, JSON.stringify(flag_result_1));
        await CheckStar("게임 결과 저장 뒤에도 유지", userid_solo, 1);
        room_2.connection.Send("GAME_RESULT", { replay: "Y" });
        checker.Check("재게임 GAME_START 수신", (await room_2.WaitFor("GAME_START")) !== undefined);
        await CheckStar("재게임 시작", userid_solo, 0);

        const flag_result_2 = await PlayFlagGame(room_2);
        checker.Check("GAME_RESULT.star = 0", flag_result_2?.star === 0, JSON.stringify(flag_result_2));
        await Sleep(300);
        room_2.connection.Send("GAME_RESULT", { replay: "Y" });
        checker.Check("star 0 재게임 Y → RETURN_TO_LOBBY", (await room_2.WaitFor("RETURN_TO_LOBBY", 3000)) !== undefined);
        checker.Check("GAME_START 는 오지 않음", !room_2.received.some((message) => message.type === "GAME_START"));
        await Sleep(500);

        console.log("\n[3] star 0 매칭 차단 → 광고로 충전하면 매칭");
        const third = await EnterLobby(MID_SOLO);
        checker.Check("ENTER_LOBBY star = 0", third.entered?.star === 0, `star=${third.entered?.star}`);
        third.lobby.connection.Send("JOIN_MATCH", { game: "flag", select: "Y" });
        const star_error = await third.lobby.WaitFor("ERROR", 3000);
        checker.Check("ERROR{NOT_ENOUGH_STAR}", star_error?.code === "NOT_ENOUGH_STAR", JSON.stringify(star_error));
        third.lobby.connection.Send("AD_VIEW_COMPLETE", {});
        const ad = await third.lobby.WaitFor("AD_VIEW_COMPLETE", 3000);
        checker.Check("연결 유지 — 광고로 star 1", ad?.result === "Y" && ad?.star === 1, JSON.stringify(ad));
        third.lobby.connection.Send("JOIN_MATCH", { game: "flag", select: "Y" });
        const match_3 = await third.lobby.WaitFor("MATCH_FOUND", 3000);
        checker.Check("충전 뒤 MATCH_FOUND", match_3 !== undefined);
        if (match_3) (await EnterRoom(flag_port, match_3)).connection.Leave();

        console.log("\n[4] 2인 — star 없는 쪽만 로비로, 남은 쪽은 새 상대 대기");
        const userid_a = ExpectedUserid(MID_A);
        const userid_b = ExpectedUserid(MID_B);
        for (const mid of [MID_A, MID_B]) (await EnterLobby(mid)).lobby.connection.Close();
        await Sleep(500);
        await SetStar(userid_a, 1);
        await SetStar(userid_b, 2);
        const lobby_a = (await EnterLobby(MID_A)).lobby;
        const lobby_b = (await EnterLobby(MID_B)).lobby;
        lobby_a.connection.Send("JOIN_MATCH", { game: "rps", select: "Y" });
        lobby_b.connection.Send("JOIN_MATCH", { game: "rps", select: "Y" });
        const match_a = await lobby_a.WaitFor("MATCH_FOUND");
        const match_b = await lobby_b.WaitFor("MATCH_FOUND");
        if (match_a?.room_id === undefined || match_a.room_id !== match_b?.room_id) {
            checker.Check("테스트 유저끼리 매칭됨", false, "실제 클라이언트와 섞였을 수 있어 이 단계를 중단");
            for (const match of [match_a, match_b]) if (match) (await EnterRoom(rps_port, match)).connection.Leave();
            return;
        }
        const room_a = await EnterRoom(rps_port, match_a);
        const room_b = await EnterRoom(rps_port, match_b);
        for (const room of [room_a, room_b]) room.connection.Send("ENTER_ROOM", {});
        for (const room of [room_a, room_b]) await room.WaitFor("ENTER_ROOM");
        for (const room of [room_a, room_b]) room.connection.Send("READY", { ready: "Y" });
        for (const room of [room_a, room_b]) await room.WaitFor("GAME_START");
        await CheckStar("A 게임 시작", userid_a, 0);
        await CheckStar("B 게임 시작", userid_b, 1);

        for (let round = 0; round < 2; round++) {
            for (const room of [room_a, room_b]) await room.WaitFor("ONE_START");
            room_a.connection.Send("SELECT_GAME", { select: "바위" });
            room_b.connection.Send("SELECT_GAME", { select: "가위" });
            for (const room of [room_a, room_b]) await room.WaitFor("ONE_RESULT");
        }
        const rps_results = [await room_a.WaitFor("GAME_RESULT"), await room_b.WaitFor("GAME_RESULT")];
        checker.Check(
            "양쪽 GAME_RESULT 에 승자 A star 0 / 패자 B star 1",
            rps_results.every((result) => result?.winner?.userid === userid_a && result.winner.star === 0 && result?.loser?.userid === userid_b && result.loser.star === 1),
            JSON.stringify(rps_results[0])
        );
        await Sleep(300);
        for (const room of [room_a, room_b]) room.connection.Send("GAME_RESULT", { replay: "Y" });
        checker.Check("A(star 0) RETURN_TO_LOBBY", (await room_a.WaitFor("RETURN_TO_LOBBY", 3000)) !== undefined);
        await Sleep(500);
        checker.Check("B 는 방에 남고 GAME_START 없음", !room_b.received.some((message) => ["GAME_START", "RETURN_TO_LOBBY"].includes(message.type)));
        await CheckStar("재게임 안 된 B 는 차감 없음", userid_b, 1);
        room_b.connection.Leave();
        await Sleep(500);

        console.log("\n[5] 나머지 2인 게임도 시작 때 양쪽 -1");
        for (const [game, port, expected_star] of [["othello", 6031, 9], ["stepping", 6041, 8], ["airhockey", 6051, 7]]) {
            await SetStar(userid_a, expected_star + 1);
            await SetStar(userid_b, expected_star + 1);
            const entry_a = (await EnterLobby(MID_A)).lobby;
            const entry_b = (await EnterLobby(MID_B)).lobby;
            entry_a.connection.Send("JOIN_MATCH", { game, select: "Y" });
            entry_b.connection.Send("JOIN_MATCH", { game, select: "Y" });
            const found_a = await entry_a.WaitFor("MATCH_FOUND");
            const found_b = await entry_b.WaitFor("MATCH_FOUND");
            if (found_a?.room_id === undefined || found_a.room_id !== found_b?.room_id) {
                checker.Check(`${game}: 테스트 유저끼리 매칭됨`, false, "실제 클라이언트와 섞였을 수 있어 이 단계를 중단");
                for (const found of [found_a, found_b]) if (found) (await EnterRoom(port, found)).connection.Leave();
                return;
            }
            const players = [await EnterRoom(port, found_a), await EnterRoom(port, found_b)];
            for (const room of players) room.connection.Send("ENTER_ROOM", {});
            for (const room of players) await room.WaitFor("ENTER_ROOM");
            for (const room of players) room.connection.Send("READY", { ready: "Y" });
            for (const room of players) await room.WaitFor("GAME_START");
            await CheckStar(`${game} A`, userid_a, expected_star);
            await CheckStar(`${game} B`, userid_b, expected_star);
            for (const room of players) room.connection.Leave();
            await Sleep(1000);
        }
    } finally {
        if (keep_rows) {
            console.log("\nKEEP=1 — 정리 건너뜀");
        } else {
            console.log("\n정리:");
            await Sleep(500);
            await Cleanup(pool, redis);
        }
        await pool.end();
        redis.GetRedisClient().disconnect();
    }
    checker.Report();
}

async function Cleanup(pool, redis) {
    const placeholders = ALL_USERIDS.map(() => "?").join(",");
    const [ad_tables] = await pool.query("SHOW TABLES LIKE 'ad_log\\_%'");
    const [flag_tables] = await pool.query("SHOW TABLES LIKE 'flag_game_log\\_%'");
    for (const row of [...ad_tables, ...flag_tables]) {
        await pool.query(`DELETE FROM \`${Object.values(row)[0]}\` WHERE userid IN (${placeholders})`, ALL_USERIDS);
    }
    for (const game of ["rps", "othello", "stepping", "airhockey"]) {
        const [log_tables] = await pool.query(`SHOW TABLES LIKE '${game}_game_log\\_%'`);
        for (const row of log_tables) {
            await pool.query(`DELETE FROM \`${Object.values(row)[0]}\` WHERE win IN (${placeholders}) OR lose IN (${placeholders})`, [...ALL_USERIDS, ...ALL_USERIDS]);
        }
    }
    const rank_tables = ["rps", "othello", "stepping", "airhockey", "flag"].flatMap((game) => [`${game}_rank_daily`, `${game}_rank_weekly`]);
    for (const table of [...rank_tables, "rps_user_play_info", "othello_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "flag_user_play_info", "user_member_info", "user_partner_info"]) {
        await pool.query(`DELETE FROM ${table} WHERE userid IN (${placeholders})`, ALL_USERIDS);
    }
    const redis_client = redis.GetRedisClient();
    const zset_keys = await redis_client.keys("rank_zset:*");
    for (const userid of ALL_USERIDS) {
        await redis.DeleteJson(`user:info:${userid}`);
        await redis.DeleteJson(`ad_cooldown:${userid}`);
        for (const game of ["rps", "othello", "stepping", "airhockey", "flag"]) await redis.DeleteJson(`user:play:${game}:${userid}`);
        for (const key of zset_keys) await redis_client.zrem(key, userid);
    }
    console.log("  테스트 유저 행·Redis 키 삭제 완료");
}

Main().catch((error) => {
    console.error("검증 실패:", error);
    process.exitCode = 1;
});
