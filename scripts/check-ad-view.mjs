// 광고 보상(AD_VIEW_COMPLETE) + 관리자 광고 로그(ADMIN_AD_LOG) 실서버 검증 스크립트
//
// 확인 내용:
//   1) 신규 유저 ENTER_LOBBY 응답에 star = 가입 보너스(5)
//   2) ENTER_LOBBY 전에 보낸 AD_VIEW_COMPLETE 는 무시(응답 없음)
//   3) AD_VIEW_COMPLETE → {result:"Y", star_add:1, star:6}, 바로 다시 → {result:"N", error:1, star:6} (10초 간격)
//   4) DB user_member_info.star = 6, ad_log_YYYY_MM 에 Y·N 두 줄(channel = lobby_1), Redis 캐시 star = 6
//   5) 다시 접속(캐시 히트)해도 ENTER_LOBBY star = 6
//   6) ADMIN_AD_LOG: 오늘 요약·목록에 테스트 유저 기록이 있다 / 테이블 없는 달은 빈 결과 / 틀린 날짜는 무시
//
// ⚠️ DB 에 테스트 유저(partner=zzad)를 만들고 끝에 자기 행만 지운다(ad_log 의 그 userid 행 포함). KEEP=1 이면 남긴다.
// JOIN_MATCH 는 보내지 않으므로 실제 클라이언트와 매칭이 섞이지 않는다.
//
// 사용법 (dev 서버가 떠 있을 때): node scripts/check-ad-view.mjs

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const lobby_room_name = "lobby_1";
const watcher_port = Number(process.env.WATCHER_PORT ?? 6001);
const keep_rows = process.env.KEEP === "1";
// 관리자 자격증명은 .env 에서만 읽고 화면에 출력하지 않는다.
const admin_id = process.env.ADMIN_ID ?? "";
const admin_password = process.env.ADMIN_PASSWORD ?? "";

const TEST_PARTNER = "zzad";
const TEST_MID = `a${String(Date.now()).slice(-8)}`;

const checker = client.CreateChecker();

function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}
const TEST_USERID = ExpectedUserid(TEST_PARTNER, TEST_MID);

function Today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function Connect(port, room_name) {
    const reservation = await client.ReserveSeat({ host, port, room_name });
    const connection = await client.ConnectWithSeat({ host, port, reservation });
    if (!connection.ok) throw new Error(`${room_name} 접속 실패: ${JSON.stringify(connection)}`);
    return connection;
}

async function Request(connection, type, payload, timeout_ms = 4000) {
    const result = client.WaitForMessage(connection, type, timeout_ms);
    connection.Send(type, payload);
    return await result;
}

async function EnterLobby(connection) {
    return Request(connection, "ENTER_LOBBY", { partner: TEST_PARTNER, mid: TEST_MID, gender: "F", phone: "01000000000" }, 6000);
}

async function Cleanup(pool, redis) {
    const [tables] = await pool.query("SHOW TABLES LIKE 'ad_log\\_%'");
    for (const row of tables) {
        const table = Object.values(row)[0];
        const [result] = await pool.query(`DELETE FROM \`${table}\` WHERE userid = ?`, [TEST_USERID]);
        if (result.affectedRows > 0) console.log(`  ${table}: ${result.affectedRows}행 삭제`);
    }
    for (const table of ["rps_user_play_info", "othello_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "flag_user_play_info", "user_member_info", "user_partner_info"]) {
        await pool.query(`DELETE FROM ${table} WHERE userid = ?`, [TEST_USERID]);
    }
    await redis.DeleteJson(`user:info:${TEST_USERID}`);
    await redis.DeleteJson(`ad_cooldown:${TEST_USERID}`);
    console.log(`  테스트 유저 ${TEST_USERID} 행·Redis 키 삭제 완료`);
}

async function Main() {
    const conn = await import("../dist/db/connection.js");
    const redis = await import("../dist/db/redis.js");
    const adLogSchema = await import("../dist/db/adLogSchema.js");
    const pool = conn.GetDbPool();

    console.log(`광고 보상 검증 시작 — 테스트 유저 ${TEST_USERID}\n`);
    try {
        console.log("[1] ENTER_LOBBY 전 AD_VIEW_COMPLETE 는 무시된다");
        const lobby = await Connect(lobby_port, lobby_room_name);
        const early = await Request(lobby, "AD_VIEW_COMPLETE", {}, 1500);
        checker.Check("응답 없음", early === undefined, JSON.stringify(early));

        console.log("\n[2] 신규 유저 star = 5");
        const entered = await EnterLobby(lobby);
        checker.Check("ENTER_LOBBY result=Y, new=Y", entered?.result === "Y" && entered?.new === "Y", JSON.stringify(entered));
        checker.Check("star = 5", entered?.star === 5, `star=${entered?.star}`);

        console.log("\n[3] 광고 보상 + 10초 간격 제한");
        const first = await Request(lobby, "AD_VIEW_COMPLETE", { payload: {} });
        checker.Check("1회째 result=Y, star_add=1, star=6", first?.result === "Y" && first?.star_add === 1 && first?.star === 6, JSON.stringify(first));
        const second = await Request(lobby, "AD_VIEW_COMPLETE", {});
        checker.Check("바로 2회째 result=N, error=1, star=6", second?.result === "N" && second?.error === 1 && second?.star === 6, JSON.stringify(second));

        console.log("\n[4] DB · Redis 반영");
        const [star_rows] = await pool.query("SELECT star FROM user_member_info WHERE userid = ?", [TEST_USERID]);
        checker.Check("user_member_info.star = 6", star_rows[0]?.star === 6, `star=${star_rows[0]?.star}`);
        const table = adLogSchema.GetAdLogTableName(new Date());
        const [log_rows] = await pool.query(`SELECT result, star_add, star_after, channel FROM \`${table}\` WHERE userid = ? ORDER BY id`, [TEST_USERID]);
        checker.Check(
            `${table} 에 Y(1→6), N(0→6) 두 줄, channel=lobby_1`,
            log_rows.length === 2 &&
                log_rows[0].result === "Y" && log_rows[0].star_add === 1 && log_rows[0].star_after === 6 &&
                log_rows[1].result === "N" && log_rows[1].star_add === 0 && log_rows[1].star_after === 6 &&
                log_rows.every((row) => row.channel === lobby_room_name),
            JSON.stringify(log_rows)
        );
        const cached = await redis.GetJson(`user:info:${TEST_USERID}`);
        checker.Check("Redis user:info star = 6", cached?.star === 6, `star=${cached?.star}`);

        console.log("\n[5] 다시 접속(캐시 히트)해도 star 유지");
        lobby.Close();
        await new Promise((resolve) => setTimeout(resolve, 800));
        const lobby2 = await Connect(lobby_port, lobby_room_name);
        const re_entered = await EnterLobby(lobby2);
        checker.Check("ENTER_LOBBY new=N, star=6", re_entered?.new === "N" && re_entered?.star === 6, JSON.stringify(re_entered));
        lobby2.Close();

        console.log("\n[6] ADMIN_AD_LOG");
        if (admin_id === "" || admin_password === "") {
            checker.Check(".env 에 관리자 자격증명이 있다", false, "ADMIN_ID/ADMIN_PASSWORD 없음 — 관리자 단계 건너뜀");
        } else {
            const watcher = await Connect(watcher_port, "watcher");
            const login = await Request(watcher, "ADMIN_LOGIN", { id: admin_id, password: admin_password });
            checker.Check("ADMIN_LOGIN result=Y", login?.result === "Y", `result=${login?.result}`);

            const today = await Request(watcher, "ADMIN_AD_LOG", { date: Today() });
            const mine = (today?.list ?? []).filter((row) => row.userid === TEST_USERID);
            checker.Check(
                "오늘 목록에 테스트 유저 Y·N 두 줄 (최신순: N 먼저)",
                mine.length === 2 && mine[0].result === "N" && mine[1].result === "Y" && /^\d{2}:\d{2}:\d{2}$/.test(mine[0].time),
                JSON.stringify(mine)
            );
            const s = today?.summary;
            checker.Check(
                "요약: view_count≥1, user_count≥1, star_total≥1, reject_count≥1, total≥2 (숫자 타입)",
                typeof s?.view_count === "number" && s.view_count >= 1 && s.user_count >= 1 && s.star_total >= 1 && s.reject_count >= 1 && today.total >= 2,
                JSON.stringify(s) + ` total=${today?.total}`
            );

            const empty = await Request(watcher, "ADMIN_AD_LOG", { date: "2031-01-15" });
            checker.Check("테이블 없는 달은 빈 결과", empty?.total === 0 && empty?.list?.length === 0 && empty?.summary?.view_count === 0, JSON.stringify(empty));

            const invalid = await Request(watcher, "ADMIN_AD_LOG", { date: "2026-02-30" }, 1500);
            checker.Check("틀린 날짜는 무시(응답 없음)", invalid === undefined, JSON.stringify(invalid));
            watcher.Close();
        }
    } finally {
        if (keep_rows) {
            console.log("\nKEEP=1 — 정리 건너뜀");
        } else {
            console.log("\n정리:");
            await Cleanup(pool, redis);
        }
        await pool.end();
        redis.GetRedisClient().disconnect();
    }
    checker.Report();
}

Main().catch((error) => {
    console.error("검증 실패:", error);
    process.exitCode = 1;
});
