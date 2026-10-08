// 관리자 로그인 보안 검증 스크립트 (2026-10-06)
//
// 검증 대상 (CLAUDE.md "무차별 대입 방어" 절):
//   1) 프록시 헤더(x-real-ip 등)를 붙인 접속이 거부되는지
//   2) 올바른 자격증명으로는 로그인되고, 틀리면 result:"N" 인지 (기존 기능 회귀 확인)
//   3) 틀린 비밀번호를 ADMIN_LOGIN_MAX_FAIL_COUNT(5)회 보내면 그 다음 접속이 거부되는지
//   4) 잠긴 동안에는 올바른 자격증명으로도 접속이 거부되는지
//   5) 서버 로그에 비밀번호 평문이 남지 않는지 → 이건 서버 쪽 콘솔을 사람이 눈으로 확인한다
//
// ⚠️ 이 스크립트는 지우지 말 것. 과거 검증 스크립트를 전부 임시로 만들고 삭제해서 재현이 불가능해진
//    문제(TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 17곳)를 되풀이하지 않기 위해 남겨 둔다.
//
// 사용법:
//   node scripts/check-admin-login.mjs                       # .env 의 WATCHER_PORT, joinOrCreate 로 접속
//   WATCHER_PORT=6091 ROOM_ID=<방id> node scripts/check-admin-login.mjs
//   ENVELOPE=1 ... node scripts/check-admin-login.mjs        # ADMIN_LOGIN 을 문서 형식으로 전송
//
// ⚠️ ROOM_ID 를 꼭 주는 게 좋다 — 이유는 colyseus-test-client.mjs 의 ReserveSeat 주석 참고.
// ⚠️ 이 스크립트는 ::1 을 10분간 잠근다(테스트 3). 다시 돌리려면 Watcher 를 재시작해 잠금을 비워야 한다
//    (잠금은 메모리에만 있다).
//
// 자격증명은 .env 의 ADMIN_ID/ADMIN_PASSWORD 를 읽는다 — 인자로 받지 않는다(명령 이력에 남지 않게).
// 이 스크립트는 자격증명을 화면에 절대 출력하지 않는다.

import * as client from "./colyseus-test-client.mjs";

try {
    process.loadEnvFile();
} catch {
    // .env 가 없으면 환경 변수만 사용
}

const host = process.env.PUBLIC_HOST ?? "localhost";
const port = Number(process.env.WATCHER_PORT ?? 6001);
const room_id = process.env.ROOM_ID ?? "";
// ENVELOPE=1 이면 ADMIN_LOGIN 을 { payload: {...} }(통신 프로토콜 문서 형식)로 보낸다. 기본은 평탄한 형식.
const use_envelope = process.env.ENVELOPE === "1";

const admin_id = process.env.ADMIN_ID ?? "";
const admin_password = process.env.ADMIN_PASSWORD ?? "";

const checker = client.CreateChecker();

// ADMIN_LOGIN 을 한 번 보내고 결과를 받는다. 접속 자체가 거부되면 그 사실을 돌려준다.
async function TryAdminLogin(id, password, extra_headers = {}) {
    let reservation;
    try {
        reservation = await client.ReserveSeat({ host, port, room_name: "watcher", room_id });
    } catch (error) {
        return { connect_rejected: true, stage: "matchmake", detail: error.message };
    }

    const connection = await client.ConnectWithSeat({ host, port, reservation, extra_headers });
    if (connection.auth_rejected === true) {
        return { connect_rejected: true, stage: "onAuth", detail: "서버가 ERROR 프레임(525)으로 거부" };
    }
    if (!connection.ok) {
        return { connect_rejected: true, stage: "websocket", detail: `close=${connection.close_code ?? connection.error ?? "timeout"}` };
    }

    // 서버는 두 형식을 모두 받는다 (common/types.ts ReadPayload):
    //   - envelope: { payload: { id, password } }  ← 통신 프로토콜 문서 형식
    //   - 평탄:     { id, password }               ← 그 전까지 서버가 실제로 읽던 형식
    const body = use_envelope ? { payload: { id, password } } : { id, password };

    const result = client.WaitForMessage(connection, "ADMIN_LOGIN");
    connection.Send("ADMIN_LOGIN", body);
    const payload = await result;
    connection.Close();

    return { connect_rejected: false, result: payload?.result ?? "?", payload };
}

async function Main() {
    console.log(`Watcher 검증 시작 — ws://${host}:${port}`);
    console.log(`ADMIN_LOGIN 전송 형식: ${use_envelope ? "{ payload: {...} } (문서 형식)" : "{ id, password } (평탄)"}`);
    console.log(`(자격증명은 .env 에서 읽었고 화면에 출력하지 않는다. ADMIN_ID 설정됨=${admin_id !== ""}, ADMIN_PASSWORD 설정됨=${admin_password !== ""})\n`);

    if (admin_id === "" || admin_password === "") {
        console.error("ADMIN_ID / ADMIN_PASSWORD 가 .env 에 없습니다 — Watcher 는 이 설정 없이는 기동하지 않습니다.");
        process.exitCode = 1;
        return;
    }

    // --- 1) 프록시 헤더 위조 거부 ---
    console.log("[1] 프록시 헤더(x-real-ip)를 붙인 접속은 거부돼야 한다");
    const spoofed = await TryAdminLogin(admin_id, admin_password, { "x-real-ip": "1.2.3.4" });
    checker.Check("x-real-ip 를 붙인 접속이 거부됨", spoofed.connect_rejected === true, spoofed.detail ?? `result=${spoofed.result}`);

    // --- 2) 정상 로그인 (회귀 확인) ---
    console.log("\n[2] 올바른 자격증명으로는 로그인돼야 한다 (기존 기능 회귀 확인)");
    const good = await TryAdminLogin(admin_id, admin_password);
    checker.Check("ADMIN_LOGIN result=Y", good.result === "Y", good.detail ?? `result=${good.result}`);

    // --- 3) 연속 실패 → IP 잠금 ---
    console.log("\n[3] 틀린 비밀번호 5회 후 6번째 접속은 거부돼야 한다");
    for (let attempt = 1; attempt <= 5; attempt++) {
        const bad = await TryAdminLogin(admin_id, `wrong-password-${attempt}`);
        checker.Check(`${attempt}회차: 접속은 되고 result=N`, bad.connect_rejected === false && bad.result === "N", bad.detail ?? `result=${bad.result}`);
    }

    const locked = await TryAdminLogin(admin_id, "wrong-password-6");
    checker.Check("6회차: 접속 자체가 거부됨 (IP 잠금)", locked.connect_rejected === true, locked.detail ?? `result=${locked.result}`);

    // --- 4) 잠긴 뒤에는 올바른 자격증명도 막혀야 한다 ---
    console.log("\n[4] 잠긴 동안에는 올바른 자격증명으로도 접속이 거부돼야 한다");
    const after_lock = await TryAdminLogin(admin_id, admin_password);
    checker.Check("잠금 중 정상 자격증명도 거부됨", after_lock.connect_rejected === true, after_lock.detail ?? `result=${after_lock.result}`);

    checker.Report();
    console.log("⚠️ 서버 콘솔에 ADMIN_LOGIN payload 가 [민감 데이터 생략] 으로 찍혔는지 직접 확인할 것.");
}

await Main();
