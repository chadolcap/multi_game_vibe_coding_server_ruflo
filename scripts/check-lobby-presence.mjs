// 로비에서 서로 보기 실서버 검증 스크립트
//
// 확인 내용:
//   1) A 입장 → LOBBY_USERS 에 자기 자신이 없다
//   2) B 입장 → B 의 LOBBY_USERS 에 A(매표소 앞 좌표), A 는 LOBBY_USER_JOIN{B}
//   3) 다른 유저 정보에 userid·phone·star 가 없고 id 는 로비 sessionId 다
//   4) B 의 LOBBY_MOVE → A 가 LOBBY_MOVES 로 받는다. 연속으로 보내도 묶인 메시지 안에 B 는 마지막 값 하나
//   5) 섬 밖 좌표는 잘리고, 숫자가 아닌 값은 무시되며 연결도 유지된다
//   6) 움직인 뒤 들어온 C 는 B 의 현재 위치를 받는다
//   7) ENTER_LOBBY 전 LOBBY_MOVE 는 무시된다
//   8) 신규 유저가 NAME 을 정하면 다른 유저가 같은 id 로 LOBBY_USER_JOIN 을 다시 받는다
//   9) 퇴장 → LOBBY_USER_LEAVE{id}
//
// ⚠️ DB 에 테스트 유저(partner=zzpre)를 만들고 끝에 자기 행만 지운다. JOIN_MATCH 는 보내지 않는다.
// HOLD_SEC=n 이면 끝에 B 가 n 초 동안 섬을 돌아다닌다(화면으로 움직임을 볼 때 쓴다).
//
// 사용법 (dev 서버가 떠 있을 때, 약 6초): node scripts/check-lobby-presence.mjs > out.txt

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const hold_sec = Number(process.env.HOLD_SEC ?? 0);
const START_Z = 27.2;
const WALK_RADIUS = 28.6;
const FLUSH_WAIT_MS = 350;

const TEST_PARTNER = "zzpre";
const run_tag = String(Date.now()).slice(-8);
const checker = client.CreateChecker();
const Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ExpectedUserid(mid) {
    let xored = "";
    for (const ch of mid) xored += (ch.charCodeAt(0) ^ 5).toString(10);
    return `${TEST_PARTNER}_${xored}`;
}
const MIDS = ["a", "b", "c"].map((prefix) => `${prefix}${run_tag}`);
const ALL_USERIDS = MIDS.map(ExpectedUserid);

async function ConnectLobby() {
    const reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: "lobby_1" });
    const connection = await client.ConnectWithSeat({ host, port: lobby_port, reservation });
    if (!connection.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(connection)}`);
    const received = [];
    connection.OnMessage((decoded) => received.push({ type: decoded.type, payload: client.TakePayload(decoded) }));
    return {
        connection,
        received,
        session_id: reservation.sessionId,
        async WaitFor(type, timeout_ms = 3000) {
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

async function Enter(lobby, mid) {
    lobby.connection.Send("ENTER_LOBBY", { partner: TEST_PARTNER, mid, gender: "F", phone: "01000000000" });
    await lobby.WaitFor("ENTER_LOBBY");
    const payload = await lobby.WaitFor("LOBBY_USERS");
    lobby.my_color = payload?.color;
    return payload?.users;
}

async function Main() {
    const conn = await import("../dist/db/connection.js");
    const redis = await import("../dist/db/redis.js");
    const pool = conn.GetDbPool();
    const lobbies = [];
    try {
        console.log("[1] 입장 — 자기 자신은 목록에 없다");
        const a = await ConnectLobby();
        lobbies.push(a);
        const users_a = await Enter(a, MIDS[0]);
        checker.Check("A 의 LOBBY_USERS 를 받았고 자기 자신이 없다", Array.isArray(users_a) && !users_a.some((user) => user.id === a.session_id), JSON.stringify(users_a));

        console.log("\n[2] 두 번째 유저 — 서로 보인다");
        const b = await ConnectLobby();
        lobbies.push(b);
        const early = await (async () => {
            b.connection.Send("LOBBY_MOVE", { x: 3, z: 3 });
            await Sleep(FLUSH_WAIT_MS);
            return a.received.some((message) => message.type === "LOBBY_MOVES");
        })();
        checker.Check("ENTER_LOBBY 전 LOBBY_MOVE 는 무시된다", !early);
        const users_b = await Enter(b, MIDS[1]);
        const seen_a = users_b?.find((user) => user.id === a.session_id);
        checker.Check("B 의 목록에 A 가 매표소 앞 좌표로 있다", seen_a?.x === 0 && seen_a?.z === START_Z, JSON.stringify(seen_a));
        const joined_b = await a.WaitFor("LOBBY_USER_JOIN");
        checker.Check("A 가 LOBBY_USER_JOIN{B} 를 받았다", joined_b?.id === b.session_id, JSON.stringify(joined_b));
        checker.Check(
            "다른 유저 정보에 userid·phone·star 가 없다",
            joined_b !== undefined && !("userid" in joined_b) && !("phone" in joined_b) && !("star" in joined_b) && !JSON.stringify(joined_b).includes(TEST_PARTNER)
        );
        checker.Check("내 오리 색이 남에게도 같은 색 — A 가 받은 내 색 = B 가 보는 A 색", typeof a.my_color === "number" && seen_a?.color === a.my_color, `A=${a.my_color} B가본A=${seen_a?.color}`);
        checker.Check("B 가 받은 내 색 = A 가 보는 B 색", typeof b.my_color === "number" && joined_b?.color === b.my_color, `B=${b.my_color} A가본B=${joined_b?.color}`);
        // 다른 실제 접속자가 있으면 그 수만큼 색이 겹칠 수 있어, 팔레트(12색)보다 사람이 적을 때만 단정한다
        const present_colors = [...(users_b ?? []).map((user) => user.color), b.my_color];
        if (present_colors.length <= 12) {
            checker.Check("동시에 있는 유저끼리 색이 모두 다르다", new Set(present_colors).size === present_colors.length, JSON.stringify(present_colors));
        }

        console.log("\n[3] 위치 공유 — 묶어서 보낸다");
        for (const x of [1, 2, 3, 4, 5]) b.connection.Send("LOBBY_MOVE", { x, z: 10 });
        const moved = await a.WaitFor("LOBBY_MOVES");
        const b_moves = moved?.moves?.filter(([id]) => id === b.session_id) ?? [];
        checker.Check("연속 5번이 묶인 메시지에서 B 는 한 항목", b_moves.length === 1, JSON.stringify(moved));
        await Sleep(FLUSH_WAIT_MS);
        const later = a.received.filter((message) => message.type === "LOBBY_MOVES").flatMap((message) => message.payload.moves);
        const last = (later.length > 0 ? later.at(-1) : b_moves[0]) ?? [];
        checker.Check("마지막 위치는 (5,10)", last[1] === 5 && last[2] === 10, JSON.stringify(last));
        a.received.length = 0;

        console.log("\n[4] 잘못된 값");
        b.connection.Send("LOBBY_MOVE", { x: 3000, z: 0 });
        const clamped = await a.WaitFor("LOBBY_MOVES");
        checker.Check("섬 밖 좌표는 걷는 반지름으로 잘린다", clamped?.moves?.[0]?.[1] === WALK_RADIUS, JSON.stringify(clamped));
        b.connection.Send("LOBBY_MOVE", { x: "abc", z: null });
        b.connection.Send("LOBBY_MOVE", { x: 1e999, z: 0 });
        await Sleep(FLUSH_WAIT_MS);
        checker.Check("숫자가 아니면 무시한다", !a.received.some((message) => message.type === "LOBBY_MOVES"));
        b.connection.Send("LOBBY_MOVE", { x: 7, z: -3 });
        const alive = await a.WaitFor("LOBBY_MOVES");
        checker.Check("그 뒤로도 연결이 유지된다", alive?.moves?.[0]?.[1] === 7, JSON.stringify(alive));

        console.log("\n[5] 나중에 들어온 유저 / 별명");
        const c = await ConnectLobby();
        lobbies.push(c);
        const users_c = await Enter(c, MIDS[2]);
        const seen_b = users_c?.find((user) => user.id === b.session_id);
        checker.Check("C 는 B 의 현재 위치를 받는다", seen_b?.x === 7 && seen_b?.z === -3, JSON.stringify(seen_b));
        await a.WaitFor("LOBBY_USER_JOIN");
        const name = `프${run_tag.slice(-5)}`;
        c.connection.Send("NAME", { name });
        const renamed = await a.WaitFor("LOBBY_USER_JOIN");
        checker.Check("별명을 정하면 같은 id 로 다시 온다", renamed?.id === c.session_id && renamed?.name === name, JSON.stringify(renamed));

        console.log("\n[6] 퇴장");
        c.connection.Close();
        const left = await a.WaitFor("LOBBY_USER_LEAVE");
        checker.Check("LOBBY_USER_LEAVE{C}", left?.id === c.session_id, JSON.stringify(left));

        if (hold_sec > 0) {
            console.log(`\nB 가 ${hold_sec}초 동안 돌아다닙니다`);
            const started = Date.now();
            while (Date.now() - started < hold_sec * 1000) {
                const angle = (Date.now() - started) / 2500;
                b.connection.Send("LOBBY_MOVE", { x: Math.cos(angle) * 8.5, z: 13 + Math.sin(angle) * 3 });
                await Sleep(200);
            }
        }
    } finally {
        for (const lobby of lobbies) lobby.connection.Close();
        await Sleep(500);
        console.log("\n정리:");
        const placeholders = ALL_USERIDS.map(() => "?").join(",");
        for (const table of ["rps_user_play_info", "othello_user_play_info", "stepping_user_play_info", "airhockey_user_play_info", "flag_user_play_info", "user_member_info", "user_partner_info"]) {
            await pool.query(`DELETE FROM ${table} WHERE userid IN (${placeholders})`, ALL_USERIDS);
        }
        for (const userid of ALL_USERIDS) await redis.DeleteJson(`user:info:${userid}`);
        console.log("  테스트 유저 행·Redis 키 삭제 완료");
        await pool.end();
        redis.GetRedisClient().disconnect();
    }
    checker.Report();
}

Main().catch((error) => {
    console.error("검증 실패:", error);
    process.exitCode = 1;
});
