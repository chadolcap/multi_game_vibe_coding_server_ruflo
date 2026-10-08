// SEND_NOTICE 채널 필터 + C→S payload 형식 검증 스크립트 (2026-10-06)
//
// 검증 대상:
//   1) SEND_NOTICE 의 channel 에 들어간 채널에만 공지가 가는지 (대상 채널은 받고, 비대상은 못 받는지)
//   2) C→S 메시지를 { payload: {...} }(문서 형식)로 보내도 서버가 payload 를 제대로 읽는지
//      — ADMIN_CHANNEL_USER{lobby:N} 의 응답이 lobby:N 을 그대로 echo 하는지로 확인한다
//        (envelope 을 못 벗기면 message.lobby 가 undefined 가 되어 echo 값도 달라진다)
//
// ⚠️ 이 스크립트는 DB 를 건드리지 않는다. ENTER_LOBBY 를 보내지 않고 로비 룸에만 붙어 있어도
//    공지는 받는다(noticePubSub 이 room.clients 전체에 보낸다) — 그래서 유저 레코드를 만들지 않는다.
//    단 로비는 접속 후 ENTER_LOBBY_TIMEOUT_SEC(10초) 안에 ENTER_LOBBY 가 없으면 끊으므로, 공지 수신을
//    그 안에 끝낸다.
//
// ⚠️ 채널 이름 충돌 주의: 공지는 Redis Pub/Sub 으로 **같은 Redis 를 구독하는 모든 프로세스**에 퍼지고,
//    각 프로세스가 "내 room_name 이 channel 목록에 있는지"로 거른다. 그래서 운영 중인 채널 이름
//    (lobby_1 등)으로 검증하면 그 채널에 붙어 있는 실제 유저에게 검증용 공지가 날아간다.
//    검증은 LOBBY_CHANNEL_NO 로 **지금 아무도 쓰지 않는 채널 번호**를 골라서 한다(기본 2).
//
// 사용법 (둘 다 임시 포트로 띄운 뒤):
//   WATCHER_PORT=6091 node dist/index.js watcher 1
//   LOBBY_PORTS=6092,6093 node dist/index.js lobby 2          # → lobby_2, 포트 6093
//   WATCHER_PORT=6091 WATCHER_ROOM_ID=... LOBBY_PORT=6093 LOBBY_ROOM_ID=... node scripts/check-send-notice.mjs
//
// 자격증명은 .env 의 ADMIN_ID/ADMIN_PASSWORD 를 읽고, 화면에 출력하지 않는다.

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const watcher_port = Number(process.env.WATCHER_PORT ?? 6001);
const watcher_room_id = process.env.WATCHER_ROOM_ID ?? "";
const lobby_port = Number(process.env.LOBBY_PORT ?? 6011);
const lobby_room_id = process.env.LOBBY_ROOM_ID ?? "";
const lobby_channel_no = Number(process.env.LOBBY_CHANNEL_NO ?? 2);
const lobby_room_name = `lobby_${lobby_channel_no}`;

const admin_id = process.env.ADMIN_ID ?? "";
const admin_password = process.env.ADMIN_PASSWORD ?? "";

const checker = client.CreateChecker();

// 관리자로 접속해 로그인까지 끝낸 연결을 돌려준다.
// ⚠️ ADMIN_LOGIN 을 envelope 형식({payload:{...}})으로 보낸다 — 문서 형식이 실제로 통하는지도 겸해 본다.
async function ConnectAsAdmin() {
    const reservation = await client.ReserveSeat({ host, port: watcher_port, room_name: "watcher", room_id: watcher_room_id });
    const connection = await client.ConnectWithSeat({ host, port: watcher_port, reservation });
    if (!connection.ok) throw new Error(`Watcher 접속 실패: ${JSON.stringify(connection)}`);

    const result = client.WaitForMessage(connection, "ADMIN_LOGIN");
    connection.Send("ADMIN_LOGIN", { payload: { id: admin_id, password: admin_password } });
    const payload = await result;
    if (payload?.result !== "Y") throw new Error(`관리자 로그인 실패: ${JSON.stringify(payload)}`);
    return connection;
}

async function Main() {
    console.log(`SEND_NOTICE 검증 시작 — watcher ws://${host}:${watcher_port}, ${lobby_room_name} ws://${host}:${lobby_port}`);
    console.log(`(자격증명은 .env 에서 읽었고 출력하지 않는다. ADMIN_ID 설정됨=${admin_id !== ""})\n`);

    if (admin_id === "" || admin_password === "") {
        console.error("ADMIN_ID / ADMIN_PASSWORD 가 .env 에 없습니다.");
        process.exitCode = 1;
        return;
    }

    const admin = await ConnectAsAdmin();
    checker.Check("관리자 로그인 (ADMIN_LOGIN 을 envelope 형식으로 전송)", true, "result=Y");

    // --- 1) ADMIN_CHANNEL_COUNT — 2026-10-07 통신규약: C→S {game}, S→C {game, count} ---
    console.log("\n[1] ADMIN_CHANNEL_COUNT{game} → {game, count} (2026-10-07 통신규약)");
    const count_result = client.WaitForMessage(admin, "ADMIN_CHANNEL_COUNT");
    admin.Send("ADMIN_CHANNEL_COUNT", { payload: { game: "rps" } });
    const counts = await count_result;
    checker.Check("응답에 game 이 담겨 온다", counts?.game === "rps", JSON.stringify(counts));
    checker.Check(
        `count 키가 실제 룸 이름이다 (${lobby_room_name} 포함, game_N 아님)`,
        counts?.count !== undefined && Object.hasOwn(counts.count, lobby_room_name) && !Object.keys(counts.count).some((k) => k.startsWith("game_")),
        JSON.stringify(counts?.count)
    );

    // --- 2) ADMIN_CHANNEL_USER — C→S {game, channel}, S→C {game, channel, user, total} ---
    console.log("\n[2] ADMIN_CHANNEL_USER{game, channel} → {game, channel, user, total}");
    const channel_user_result = client.WaitForMessage(admin, "ADMIN_CHANNEL_USER");
    admin.Send("ADMIN_CHANNEL_USER", { payload: { game: "rps", channel: lobby_room_name } });
    const channel_user = await channel_user_result;
    checker.Check(
        `응답이 game/channel 을 그대로 echo 하고 user 배열을 준다 (count 아님)`,
        channel_user?.game === "rps" && channel_user?.channel === lobby_room_name && Array.isArray(channel_user?.user),
        JSON.stringify(channel_user)
    );

    // --- 3) 폐지된 숫자 형식과 알 수 없는 채널은 무시돼야 한다 ---
    console.log("\n[3] 폐지된 숫자 형식 {lobby:N} 과 모르는 채널 이름은 무시돼야 한다");
    const legacy_result = client.WaitForMessage(admin, "ADMIN_CHANNEL_USER", 2500);
    admin.Send("ADMIN_CHANNEL_USER", { payload: { lobby: lobby_channel_no } });
    checker.Check("숫자 형식은 응답이 오지 않는다", (await legacy_result) === undefined, "수신 없음(정상)");

    const unknown_result = client.WaitForMessage(admin, "ADMIN_CHANNEL_USER", 2500);
    admin.Send("ADMIN_CHANNEL_USER", { payload: { game: "rps", channel: "lobby_99" } });
    checker.Check("존재하지 않는 채널은 응답이 오지 않는다", (await unknown_result) === undefined, "수신 없음(정상)");

    const bad_game_result = client.WaitForMessage(admin, "ADMIN_CHANNEL_COUNT", 2500);
    admin.Send("ADMIN_CHANNEL_COUNT", { payload: { game: "othello" } });
    checker.Check("지원하지 않는 game 은 응답이 오지 않는다", (await bad_game_result) === undefined, "수신 없음(정상)");

    // --- 4) 대상 채널은 공지를 받는다 (game 필드 포함 — 2026-10-07 통신규약) ---
    console.log(`\n[4] SEND_NOTICE{game, channel:["${lobby_room_name}"]} → ${lobby_room_name} 클라이언트가 받아야 한다`);
    const lobby_reservation = await client.ReserveSeat({ host, port: lobby_port, room_name: lobby_room_name, room_id: lobby_room_id });
    const lobby = await client.ConnectWithSeat({ host, port: lobby_port, reservation: lobby_reservation });
    if (!lobby.ok) throw new Error(`로비 접속 실패: ${JSON.stringify(lobby)}`);

    const expected_message = `검증용 공지 ${Date.now()}`;
    const notice_wait = client.WaitForMessage(lobby, "SEND_NOTICE", 5000);
    admin.Send("SEND_NOTICE", { payload: { game: "rps", channel: [lobby_room_name], message: expected_message } });
    const notice = await notice_wait;
    checker.Check("공지를 받았다", notice?.message === expected_message, notice === undefined ? "수신 없음" : JSON.stringify(notice));

    // --- 5) 비대상 채널로 보낸 공지는 받지 않는다 (필터가 실제로 거르는지) ---
    // 실제 유저에게 검증용 공지가 가지 않도록, 아무 프로세스도 담당하지 않는 채널 이름을 고른다.
    console.log("\n[5] SEND_NOTICE channel:[\"lobby_9\"] → 이 클라이언트는 받지 않아야 한다");
    const other_notice_wait = client.WaitForMessage(lobby, "SEND_NOTICE", 3000);
    admin.Send("SEND_NOTICE", { payload: { game: "rps", channel: ["lobby_9"], message: `받으면 안 되는 공지 ${Date.now()}` } });
    const other_notice = await other_notice_wait;
    checker.Check("받지 않았다 (채널 필터가 걸렀다)", other_notice === undefined, other_notice === undefined ? "수신 없음(정상)" : JSON.stringify(other_notice));

    // --- 6) 평탄한 형식 + game 생략도 동작한다 (하위 호환) ---
    console.log("\n[6] SEND_NOTICE 를 평탄한 형식 + game 생략으로 보내도 동작해야 한다 (하위 호환)");
    const flat_message = `평탄 형식 공지 ${Date.now()}`;
    const flat_wait = client.WaitForMessage(lobby, "SEND_NOTICE", 5000);
    admin.Send("SEND_NOTICE", { channel: [lobby_room_name], message: flat_message });
    const flat_notice = await flat_wait;
    checker.Check("공지를 받았다", flat_notice?.message === flat_message, flat_notice === undefined ? "수신 없음" : JSON.stringify(flat_notice));

    lobby.Close();
    admin.Close();
    checker.Report();
}

await Main();
