// 로비 C→S payload 형식 검증 스크립트 (2026-10-06)
//
// 검증 대상: 2026-10-06 에 common/log.ts 의 RegisterLoggedMessage 가 모든 C→S 메시지에서 envelope 을
// 벗기도록(types.ReadPayload) 바뀌었다. 로비 메시지가 두 형식 모두에서 제대로 동작하는지 확인한다.
//   - envelope: { payload: { ... } }  ← 통신 프로토콜 문서 형식
//   - 평탄:     { ... }               ← 그 전까지 서버가 실제로 읽던 형식
// ENTER_LOBBY 는 응답에 userid 가 담겨서 가장 강한 증거가 된다 — payload 를 못 읽으면 partner/mid 가
// undefined 가 되어 형식 오류(result:"N", error:1)가 되고, 읽으면 보낸 값으로 만든 userid 가 돌아온다.
//
// ⚠️ **이 스크립트는 DB 에 유저를 만든다.** 끝나고 자기가 만든 행만 지운다(user_partner_info /
//    user_member_info / rps_user_play_info + Redis 캐시). 기존 유저는 건드리지 않도록, 아무도 쓰지 않는
//    partner 접두사(TEST_PARTNER)를 쓰고 그 접두사로만 지운다. KEEP=1 로 실행하면 정리를 건너뛴다.
//
// ⚠️ JOIN_MATCH{select:"Y"} 는 **일부러 보내지 않는다** — 매칭이 성사되면 실제로 게임방이 만들어지고,
//    방을 만들 채널은 Redis 하트비트로 "지금 켜져 있는 게임 채널"에서 고르기 때문에(GameRoomMatcher)
//    검증과 무관한 채널에 방이 생길 수 있다. payload 읽기 검증에는 취소("N")만으로 충분하다.
//
// 사용법 (로비를 임시 포트로 띄운 뒤):
//   LOBBY_PORTS=6092,6093 node dist/index.js lobby 2       # → lobby_2, 포트 6093
//   LOBBY_PORT=6093 LOBBY_ROOM_ID=<방id> node scripts/check-enter-lobby.mjs

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const lobby_room_id = process.env.LOBBY_ROOM_ID ?? "";
const lobby_channel_no = Number(process.env.LOBBY_CHANNEL_NO ?? 2);
const lobby_room_name = `lobby_${lobby_channel_no}`;
const keep_rows = process.env.KEEP === "1";
// Watcher 를 함께 지정하면 관리자 조회(ADMIN_CHANNEL_USER)까지 검증한다. 없으면 그 단계를 건너뛴다.
const watcher_port = Number(process.env.WATCHER_PORT ?? 0);
const watcher_room_id = process.env.WATCHER_ROOM_ID ?? "";
// 관리자 자격증명은 .env 에서만 읽고 화면에 출력하지 않는다.
const admin_id = process.env.ADMIN_ID ?? "";
const admin_password = process.env.ADMIN_PASSWORD ?? "";

// 기존 유저(partner=ltdbg, ocb)와 겹치지 않는 접두사. 정리할 때 이 값으로만 지운다.
const TEST_PARTNER = "zzchk";
const run_tag = String(Date.now()).slice(-8); // mid 는 영문/숫자만 허용
const MID_ENVELOPE = `e${run_tag}`;
const MID_FLAT = `f${run_tag}`;

const checker = client.CreateChecker();

// common/userid.ts 의 ConvertMidToUserid 와 같은 규칙 (XOR key 5 → 10진수 문자열 이어 붙이기).
// 서버가 돌려준 userid 가 "내가 보낸 mid" 로 만들어졌는지 확인하는 용도다.
function ExpectedUserid(partner, mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${partner}_${xored}`;
}

async function ConnectToLobby() {
    const reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: lobby_room_name, room_id: lobby_room_id });
    const connection = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!connection.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(connection)}`);
    return connection;
}

// ENTER_LOBBY 를 보내고 응답을 받는다. use_envelope 로 전송 형식을 고른다.
async function EnterLobby(connection, mid, use_envelope) {
    const payload = { partner: TEST_PARTNER, mid, gender: "M", phone: "01000000000" };
    const result = client.WaitForMessage(connection, "ENTER_LOBBY", 6000);
    connection.Send("ENTER_LOBBY", use_envelope ? { payload } : payload);
    return await result;
}

// 검증으로 만들어진 행을 지운다. TEST_PARTNER 로 시작하는 userid 만 대상으로 한다.
async function CleanupTestRows() {
    const conn = await import("../dist/db/connection.js");
    const redis = await import("../dist/db/redis.js");
    const pool = conn.GetDbPool();

    const [rows] = await pool.query("SELECT userid FROM user_partner_info WHERE partner = ?", [TEST_PARTNER]);
    if (rows.length === 0) {
        console.log("\n정리: 지울 테스트 행이 없습니다.");
    } else {
        console.log(`\n정리 대상 (partner='${TEST_PARTNER}' 인 행만):`);
        for (const row of rows) console.log(`  ${row.userid}`);

        // FK 가 user_partner_info 를 참조하므로 자식 테이블부터 지운다.
        for (const table of ["rps_user_play_info", "othello_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "flag_user_play_info", "user_member_info", "user_partner_info"]) {
            const [result] = await pool.query(
                `DELETE FROM ${table} WHERE userid IN (SELECT userid FROM (SELECT userid FROM user_partner_info WHERE partner = ?) AS t)`,
                [TEST_PARTNER]
            );
            console.log(`  ${table}: ${result.affectedRows}행 삭제`);
        }
        // Redis 캐시(user:info:{userid}, TTL 120초)도 지워서 흔적을 남기지 않는다.
        for (const row of rows) await redis.DeleteJson(`user:info:${row.userid}`);
        console.log("  Redis 캐시 삭제 완료");
    }

    await pool.end();
    redis.GetRedisClient().disconnect();
}

async function Main() {
    console.log(`로비 payload 형식 검증 시작 — ${lobby_room_name} ws://${host}:${lobby_port}`);
    console.log(`테스트 계정: partner='${TEST_PARTNER}', mid='${MID_ENVELOPE}'(envelope) / '${MID_FLAT}'(평탄)\n`);

    // --- 1) envelope 형식 ---
    console.log("[1] ENTER_LOBBY 를 { payload: {...} }(문서 형식)로 보낸다");
    const conn_envelope = await ConnectToLobby();
    const entered_envelope = await EnterLobby(conn_envelope, MID_ENVELOPE, true);
    checker.Check("result=Y", entered_envelope?.result === "Y", JSON.stringify(entered_envelope));
    checker.Check(
        "userid 가 내가 보낸 partner/mid 로 만들어졌다 (payload 가 그대로 전달된 증거)",
        entered_envelope?.userid === ExpectedUserid(TEST_PARTNER, MID_ENVELOPE),
        `기대=${ExpectedUserid(TEST_PARTNER, MID_ENVELOPE)} 실제=${entered_envelope?.userid}`
    );
    checker.Check("new=Y (신규 유저로 등록됐다)", entered_envelope?.new === "Y", `new=${entered_envelope?.new}`);

    // --- 2) 같은 연결에서 다른 로비 메시지도 envelope 으로 ---
    console.log("\n[2] 다른 로비 메시지도 envelope 형식으로 동작해야 한다");
    const name_result = client.WaitForMessage(conn_envelope, "NAME", 6000);
    conn_envelope.Send("NAME", { payload: { name: `검증${run_tag}` } });
    const named = await name_result;
    checker.Check("NAME result=Y", named?.result === "Y", JSON.stringify(named));

    const play_result = client.WaitForMessage(conn_envelope, "PLAY_INFO", 6000);
    conn_envelope.Send("PLAY_INFO", { payload: { game: "rps" } });
    const play_info = await play_result;
    checker.Check("PLAY_INFO 응답이 온다", play_info?.result === "Y", JSON.stringify(play_info));

    const rank_result = client.WaitForMessage(conn_envelope, "RANK_DAILY", 6000);
    conn_envelope.Send("RANK_DAILY", { payload: { game: "rps" } });
    const rank = await rank_result;
    checker.Check("RANK_DAILY 응답에 date/my 가 있다", rank?.date !== undefined && rank?.my !== undefined, JSON.stringify(rank).slice(0, 120));

    // JOIN_MATCH 는 취소("N")만 보낸다 — "Y" 는 실제로 게임방을 만든다(위 ⚠️ 참고).
    conn_envelope.Send("JOIN_MATCH", { payload: { select: "N", game: "rps" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    checker.Check("JOIN_MATCH{select:N} 을 보내도 연결이 유지된다", conn_envelope.socket.readyState === 1, `readyState=${conn_envelope.socket.readyState}`);

    // --- 2-1) 관리자 ADMIN_CHANNEL_USER 가 이 유저를 실제로 집계하는지 ---
    // 2026-10-07 에 사용자가 "로비에 유저 1명이 있는데 관리자 조회가 0으로 나온다"고 신고한 그 상황을
    // 그대로 재현한다. 원인은 옛 코드가 channel 을 무시하고 GetChannelRoomName("rps", message.game) 로
    // "rps_rps" 를 조회하던 것이었다. 위 conn_envelope 를 **닫지 않고** 붙여 둔 채로 조회해야 의미가 있다.
    if (watcher_port > 0 && admin_id !== "" && admin_password !== "") {
        console.log(`\n[2-1] 관리자 ADMIN_CHANNEL_USER{channel:"${lobby_room_name}"} 가 이 유저를 집계해야 한다`);

        // 채널 유저 목록은 CHANNEL_USERS_REPORT_INTERVAL_SEC(5초)마다 Redis 에 올라가므로 한 주기 기다린다.
        await new Promise((resolve) => setTimeout(resolve, 6500));

        const admin_reservation = await client.ReserveSeat({ host, port: watcher_port, room_name: "watcher", room_id: watcher_room_id });
        const admin = await client.ConnectWithSeat({ host, port: watcher_port, reservation: admin_reservation });
        if (!admin.ok) throw new Error(`Watcher 접속 실패: ${JSON.stringify(admin)}`);

        const login = client.WaitForMessage(admin, "ADMIN_LOGIN");
        admin.Send("ADMIN_LOGIN", { payload: { id: admin_id, password: admin_password } });
        const logged_in = await login;
        checker.Check("관리자 로그인", logged_in?.result === "Y", JSON.stringify(logged_in));

        const query = client.WaitForMessage(admin, "ADMIN_CHANNEL_USER", 6000);
        admin.Send("ADMIN_CHANNEL_USER", { payload: { game: "rps", channel: lobby_room_name } });
        const result = await query;

        checker.Check("응답에 channel 이 echo 된다 (옛 코드에는 없던 필드)", result?.channel === lobby_room_name, JSON.stringify(result));
        const expected_userid = ExpectedUserid(TEST_PARTNER, MID_ENVELOPE);
        checker.Check(
            "접속해 있는 테스트 유저가 목록에 있다 (0명이 아니다)",
            Array.isArray(result?.user) && result.user.some((u) => u.userid === expected_userid),
            `total=${result?.total} user=${JSON.stringify(result?.user)}`
        );
        admin.Close();
    } else {
        console.log("\n[2-1] 건너뜀 — WATCHER_PORT / ADMIN 자격증명이 없습니다.");
    }

    conn_envelope.Close();

    // --- 3) 평탄 형식도 여전히 동작한다 ---
    console.log("\n[3] ENTER_LOBBY 를 평탄한 형식으로 보내도 동작해야 한다 (하위 호환)");
    const conn_flat = await ConnectToLobby();
    const entered_flat = await EnterLobby(conn_flat, MID_FLAT, false);
    checker.Check("result=Y", entered_flat?.result === "Y", JSON.stringify(entered_flat));
    checker.Check(
        "userid 가 내가 보낸 partner/mid 로 만들어졌다",
        entered_flat?.userid === ExpectedUserid(TEST_PARTNER, MID_FLAT),
        `기대=${ExpectedUserid(TEST_PARTNER, MID_FLAT)} 실제=${entered_flat?.userid}`
    );
    conn_flat.Close();

    // --- 4) 형식 오류는 여전히 error:1 로 거부돼야 한다 ---
    console.log("\n[4] 형식이 틀린 payload 는 error:1 로 거부돼야 한다 (검증이 느슨해지지 않았는지)");
    const conn_bad = await ConnectToLobby();
    const bad_result = client.WaitForMessage(conn_bad, "ENTER_LOBBY", 6000);
    conn_bad.Send("ENTER_LOBBY", { payload: { partner: TEST_PARTNER, mid: `x${run_tag}`, gender: "X", phone: "" } });
    const bad = await bad_result;
    checker.Check("result=N, error=1", bad?.result === "N" && bad?.error === 1, JSON.stringify(bad));
    conn_bad.Close();

    checker.Report();

    if (keep_rows) {
        console.log("\nKEEP=1 — 테스트 행을 그대로 둡니다.");
    } else {
        await CleanupTestRows();
    }
}

await Main();
