// 검증 스크립트용 최소 Colyseus 클라이언트 (2026-10-06)
//
// @colyseus/sdk 를 의존성으로 두지 않고 직접 핸드셰이크한다 — 검증에 필요한 건 "matchmake → WS 접속 →
// 메시지 주고받기" 뿐이고, colyseus.js 는 0.16 까지만 있어 0.18 서버와 맞지 않는다(CLAUDE.md 참고).
// ws + msgpackr 는 둘 다 @colyseus/* 의 의존성으로 이미 node_modules 에 있어 새로 설치할 게 없다.
//
// ⚠️ 이 파일과 이를 쓰는 검증 스크립트들은 지우지 말 것. 과거 검증 스크립트를 전부 임시로 만들고
//    삭제해서 재현이 불가능해진 문제(TASKS.md 의 "임시 스크립트, 테스트 후 삭제" 17곳)를 되풀이하지
//    않기 위해 남겨 둔다.

import { pack, unpack } from "msgpackr";
import { WebSocket } from "ws";

// @colyseus/core Protocol.d.ts 기준
export const PROTOCOL_ERROR = 1; // onAuth 거부 시 서버가 보낸다(525 AUTH_FAILED)
export const PROTOCOL_JOIN_ROOM = 10; // 입장 성공 응답
export const PROTOCOL_LEAVE_ROOM = 12; // 클라이언트의 **명시적 나가기** (아래 Leave 참고)
export const PROTOCOL_ROOM_DATA = 13; // 애플리케이션 메시지

// Colyseus 의 ROOM_DATA 프레임 = [13, 메시지 타입(msgpack fixstr), 본문(msgpack)]
// (@colyseus/core RoomMessages.mjs onData 가 decode.string → msgpackr unpack 순으로 읽는다)
export function EncodeRoomData(type_name, payload) {
    const type_bytes = Buffer.from(type_name, "utf8");
    if (type_bytes.length >= 32) throw new Error("타입 이름이 fixstr 범위를 넘습니다");
    return Buffer.concat([Buffer.from([PROTOCOL_ROOM_DATA, 0xa0 | type_bytes.length]), type_bytes, pack(payload)]);
}

// 위 인코딩의 역순. 서버가 보낸 ROOM_DATA 프레임에서 {type, payload} 를 꺼낸다.
export function DecodeRoomData(bytes) {
    const header = bytes[1];
    if ((header & 0xe0) !== 0xa0) return null; // fixstr 이 아니면 우리가 다루는 형태가 아니다
    const type_length = header & 0x1f;
    const type_name = Buffer.from(bytes.subarray(2, 2 + type_length)).toString("utf8");
    const body = bytes.subarray(2 + type_length);
    return { type: type_name, payload: body.byteLength > 0 ? unpack(Buffer.from(body)) : undefined };
}

// matchmake HTTP 요청으로 좌석을 예약한다.
// ⚠️ **검증할 때는 room_id 를 주는 게 좋다** (joinById 로 그 방에만 붙는다).
//    `joinOrCreate` 는 룸 이름으로만 방을 찾고, 방 목록은 Redis(RedisDriver)에 클러스터 단위로 공유된다.
//    그래서 같은 Redis 를 쓰는 다른 프로세스가 같은 룸 이름을 define 해 두면, 내가 띄운 프로세스가 아니라
//    그쪽 방을 골라 버린다 — 포트를 맞게 줘도 그렇다(응답의 publicAddress 가 다른 포트로 온다).
//    실제로 겪었다(2026-10-06): 임시 포트에 띄운 Watcher 를 검증하려는데 이미 떠 있던 다른 프로세스의
//    watcher 방이 돌아와서, 그대로 믿었다면 **고치기 전 코드를 테스트하고 "통과"로 오판**할 상황이었다.
//    룸 이름이 겹칠 수 있는 상황(채널을 더 띄울 때, 멀티 프로세스 검증 등)에서는 항상 room_id 로 고정할 것.
export async function ReserveSeat({ host, port, room_name, room_id = "" }) {
    const path = room_id === "" ? `joinOrCreate/${room_name}` : `joinById/${room_id}`;
    const response = await fetch(`http://${host}:${port}/matchmake/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    const body = await response.json();
    if (body.error !== undefined) throw new Error(`matchmake 실패: code=${body.code} ${body.error}`);
    return body;
}

// 예약한 좌석으로 WS 접속 + JOIN_ROOM 핸드셰이크까지 끝낸다.
// 성공하면 { ok:true, socket, OnMessage, Send, Close }, onAuth 에 거부되면 { ok:false, auth_rejected:true }.
// extra_headers 로 프록시 헤더 위조를 흉내낼 수 있다.
// reconnection_token 을 주면 **재접속**이 된다 (좌석 예약 대신 토큰으로 기존 좌석을 되찾는다).
// 서버는 그 세션의 onReconnect 를 부르고 onJoin 은 부르지 않는다 — 그래서 재접속한 클라이언트는
// ENTER_ROOM 을 다시 보내 상대 정보/보드 상태를 되찾아야 한다(CLAUDE.md "재접속/봇 대체" 참고).
//
// ⚠️ 재접속 토큰은 **접속 URL 의 쿼리스트링**으로 보낸다(`?reconnectionToken=...`) —
//    @colyseus/ws-transport 의 WebSocketTransport.mjs 가 거기서 읽는다. JOIN_ROOM 프레임에 실으면
//    안 된다: 서버의 JOIN_ROOM 처리(@colyseus/core Room.mjs)는 payload 를 아예 읽지 않고 상태만
//    전환하므로, 토큰을 프레임에 담으면 그냥 무시되고 재접속이 아닌 신규 입장으로 취급돼 거부된다
//    (2026-10-08 실제로 겪어서 확인 — close code 4002).
export function ConnectWithSeat({ host, port, reservation, extra_headers = {}, timeout_ms = 4000, reconnection_token = "" }) {
    const { processId, roomId, sessionId } = reservation;
    const query = reconnection_token === ""
        ? `sessionId=${sessionId}`
        : `sessionId=${sessionId}&reconnectionToken=${encodeURIComponent(reconnection_token)}`;
    const url = `ws://${host}:${port}/${processId}/${roomId}?${query}`;

    return new Promise((resolve) => {
        const socket = new WebSocket(url, { headers: extra_headers });
        const listeners = [];
        let settled = false;

        const Settle = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        socket.on("open", () => {
            // Colyseus 는 접속 직후 클라이언트의 JOIN_ROOM 핸드셰이크를 기다린다.
            // [JOIN_ROOM, reconnectionToken 길이(0), 커스텀 옵션 길이(0)] — 재접속이든 아니든 같다.
            socket.send(Uint8Array.from([PROTOCOL_JOIN_ROOM, 0, 0]));
        });

        socket.on("message", (data) => {
            const bytes = new Uint8Array(data);

            if (bytes[0] === PROTOCOL_ERROR) {
                Settle({ ok: false, auth_rejected: true });
                return;
            }
            // 입장 성공 — ⚠️ ROOM_DATA 를 기다려선 안 된다. LobbyRoom/WatcherRoom 의 onJoin 은
            // 클라이언트에 아무 메시지도 보내지 않아서 영원히 오지 않는다(실제로 겪음).
            if (bytes[0] === PROTOCOL_JOIN_ROOM) {
                Settle({
                    ok: true,
                    socket,
                    // 서버가 보내는 ROOM_DATA 를 {type, payload} 로 받아 보는 콜백을 등록한다.
                    OnMessage: (callback) => listeners.push(callback),
                    Send: (type_name, body) => socket.send(EncodeRoomData(type_name, body)),
                    // **명시적 나가기**(동의 종료). 소켓을 그냥 닫는 Close() 와 서버 쪽 처리가 다르다:
                    //   Leave() → 서버가 CloseCode.CONSENTED 로 보고 **onDrop 을 건너뛰고 onLeave** 를 부른다
                    //             (@colyseus/core Room.mjs: LEAVE_ROOM → _forciblyCloseClient(CONSENTED))
                    //             → 재접속 창이 열리지 않는다 = "나가서 안 돌아오는" 경우
                    //   Close() → 동의 없는 종료 → onDrop → 재접속 유예
                    Leave: () => socket.send(Uint8Array.from([PROTOCOL_LEAVE_ROOM])),
                    Close: () => {
                        try {
                            socket.close();
                        } catch {
                            // 이미 닫혔으면 무시
                        }
                    },
                });
                return;
            }
            if (bytes[0] === PROTOCOL_ROOM_DATA) {
                const decoded = DecodeRoomData(bytes);
                if (decoded) for (const callback of listeners) callback(decoded);
            }
        });

        socket.on("close", (code) => Settle({ ok: false, close_code: code }));
        socket.on("error", (error) => Settle({ ok: false, error: error.message }));
        setTimeout(() => Settle({ ok: false, timeout: true }), timeout_ms);
    });
}

// 서버가 보낸 S→C envelope({type, payload, ts})에서 payload 를 꺼낸다.
export function TakePayload(decoded) {
    return decoded?.payload?.payload;
}

// 특정 type 의 S→C 메시지를 기다린다. 시간 안에 안 오면 undefined.
export function WaitForMessage(connection, type_name, timeout_ms = 4000) {
    return new Promise((resolve) => {
        let settled = false;
        const Settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        connection.OnMessage((decoded) => {
            if (decoded.type === type_name) Settle(TakePayload(decoded));
        });
        setTimeout(() => Settle(undefined), timeout_ms);
    });
}

// 간단한 검증 결과 집계기
export function CreateChecker() {
    const state = { pass: 0, fail: 0 };
    return {
        state,
        Check(label, ok, detail = "") {
            if (ok) {
                state.pass++;
                console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);
            } else {
                state.fail++;
                console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
            }
        },
        Report() {
            console.log(`\n결과: 통과 ${state.pass} / 실패 ${state.fail}`);
            if (state.fail > 0) process.exitCode = 1;
        },
    };
}
