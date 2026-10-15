// 접속/퇴장, 클라이언트↔서버 프로토콜 로그
// 기존 [LobbyRoom]/[RpsGameRoom]/[LobbyManager] 같은 대괄호 태그 스타일을 따르되,
// 색(ANSI)과 화살표로 C→S(클라이언트→서버) / S→C(서버→클라이언트)를 구분한다.
// 색이 안 보이는 터미널이어도 [C→S] / [S→C] 텍스트 자체로 구분되도록 한다.

import type { Client, Room } from "@colyseus/core";
import * as types from "./types.js";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m"; // 접속
const GRAY = "\x1b[90m"; // 퇴장
const GREEN = "\x1b[32m"; // C → S
const MAGENTA = "\x1b[35m"; // S → C

function RoomTag(room: Room): string {
    return `${room.roomName}(${room.roomId})`;
}

// phone 은 개인정보라 로그에도 값 그대로 남기지 않는다 (뒷자리 4자리만 남기고 마스킹).
// CLAUDE.md: "phone 은 개인정보다. ... 로그 ... 에 넣지 않는다"
export function MaskPhone(phone: unknown): string {
    if (typeof phone !== "string" || phone.length === 0) return String(phone);
    return phone.length <= 4 ? "*".repeat(phone.length) : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

// 통계/순위 데이터가 담기는 메시지 — 그대로 로그에 남기면(특히 외부로 전달되는 로그 수집기 등을 통해)
// 유저 개개인의 플레이 기록·순위가 유출될 수 있어 payload 자체를 생략한다.
// (사용자 전역 보안 규칙: "통계등 자료에 대한 유출 절대 금지")
const STATS_MESSAGE_TYPES = new Set<string>([
    types.MessageType.PLAY_INFO,
    types.MessageType.RANK_DAILY,
    types.MessageType.RANK_WEEKLY,
    types.MessageType.GAME_RESULT,
]);

// 자격증명이 담기는 메시지 — payload 를 아예 남기지 않는다. ADMIN_LOGIN 은 {id, password} 를 통째로
// 받으므로 비밀번호만 가려도 관리자 계정명(id)이 남아 절반이 유출된다.
// (사용자 전역 보안 규칙: "서버 계정, 관리자 계정 유출 절대 금지")
const SECRET_MESSAGE_TYPES = new Set<string>([types.MessageType.ADMIN_LOGIN]);

// 값을 통째로 가려야 하는 필드 이름. phone 처럼 뒷자리를 남기면 안 되는 값들이다
// (비밀번호는 일부만 노출돼도 대입 공격의 단서가 된다).
const SECRET_KEYS = new Set<string>(["password", "passwd", "pw", "token", "secret"]);

// 초당 수십 번 오가는 실시간 메시지 — C↔S 로그를 아예 남기지 않는다(2026-10-15 에어하키 추가).
// 에어하키 한 방이 PUCK_MOVE 만 초당 60건(30Hz × 2명)을 보내므로, 남기면 로그가 다른 메시지를 묻어 버린다.
export const HIGH_FREQUENCY_MESSAGE_TYPES = new Set<string>([
    types.MessageType.PUCK_MOVE,
    types.MessageType.LEVER_MOVE,
]);
const SECRET_MASK = "***";

// payload 를 로그용 문자열로 변환한다. 통계성 메시지(위 STATS_MESSAGE_TYPES)와 자격증명 메시지
// (SECRET_MESSAGE_TYPES)는 payload 를 생략하고, 그 외에는 phone 필드(중첩 포함)를 마스킹하고
// 비밀 필드(SECRET_KEYS, 중첩 포함)는 통째로 가린 뒤 너무 길면 자른다.
// (export 하는 이유: 이 마스킹 규칙 자체가 보안 요구사항이라 단위 테스트로 회귀를 막는다 —
//  common/log.test.ts 참고. console.log 를 가로채는 방식보다 훨씬 단순하다)
export function StringifyPayload(type: string | undefined, payload: unknown, max = 500): string {
    if (type !== undefined && STATS_MESSAGE_TYPES.has(type)) return "[통계 데이터 생략]";
    if (type !== undefined && SECRET_MESSAGE_TYPES.has(type)) return "[민감 데이터 생략]";

    let text: string;
    try {
        text =
            JSON.stringify(payload, (key, value) => {
                if (SECRET_KEYS.has(key)) return SECRET_MASK;
                return key === "phone" ? MaskPhone(value) : value;
            }) ?? String(payload);
    } catch {
        text = String(payload);
    }
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function LogConnect(room: Room, client: Client, extra?: unknown): void {
    const extra_text = extra !== undefined ? ` ${StringifyPayload(undefined, extra)}` : "";
    console.log(
        `${CYAN}[접속]${RESET} ${RoomTag(room)} sessionId=${client.sessionId} (현재 ${room.clients.length}명)${extra_text}`
    );
}

export function LogDisconnect(room: Room, client: Client, code?: number): void {
    console.log(`${GRAY}[퇴장]${RESET} ${RoomTag(room)} sessionId=${client.sessionId} code=${code}`);
}

// 클라이언트 → 서버로 받은 메시지 (C→S)
export function LogClientMessage(room: Room, client: Client, type: string, payload: unknown): void {
    if (HIGH_FREQUENCY_MESSAGE_TYPES.has(type)) return;
    console.log(
        `${GREEN}[C→S]${RESET} ${RoomTag(room)} sessionId=${client.sessionId} type=${type} payload=${StringifyPayload(type, payload)}`
    );
}

// 서버 → 클라이언트로 보낸 메시지 (S→C)
export function LogServerMessage(room: Room, client: Client, type: string, payload: unknown): void {
    if (HIGH_FREQUENCY_MESSAGE_TYPES.has(type)) return;
    console.log(
        `${MAGENTA}[S→C]${RESET} ${RoomTag(room)} sessionId=${client.sessionId} type=${type} payload=${StringifyPayload(type, payload)}`
    );
}

// room.onMessage 등록을 감싸서, 메시지가 도착할 때마다 자동으로 [C→S] 로그를 남긴다.
// (Room 마다 개별적으로 로그 호출을 넣지 않아도 되도록 하는 공통 진입점. RpsGameRoom 같은 게임 Room 의 메시지 핸들러도
//  이 헬퍼로 등록하면 Phase 5 이후에도 로그가 자동으로 남는다)
//
// 여기서 envelope 을 벗겨 핸들러에 payload 만 넘긴다 (types.ReadPayload, 2026-10-06). 모든 C→S 메시지가
// 이 함수를 거치므로, 핸들러마다 따로 신경 쓰지 않아도 "서버는 payload 를 읽는다"는 문서 규칙이 지켜진다.
// `{payload:{...}}`(문서 형식)와 평탄한 `{...}`(기존 동작)를 둘 다 받아들인다 — ReadPayload 주석 참고.
export function RegisterLoggedMessage<T = unknown>(
    room: Room,
    type: string,
    handler: (client: Client, message: T) => unknown
): void {
    room.onMessage(type, (client: Client, message: unknown) => {
        const payload = types.ReadPayload(message) as T;
        // 로그도 벗긴 payload 를 남긴다 — envelope 로 온 메시지가 {"payload":{...}} 로 중첩돼 찍히지 않게.
        LogClientMessage(room, client, type, payload);
        return handler(client, payload);
    });
}
