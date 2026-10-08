// 클라이언트 메시지 송수신 헬퍼
// - S→C: 항상 envelope 전체({ type, payload, ts })를 보낸다.
// - C→S: 서버는 payload 만 읽는다. (클라이언트는 { payload: {...} } 만 보내도 된다)

import type { Client, Room } from "@colyseus/core";
import * as log from "./log.js";
import * as types from "./types.js";
import type { Envelope, ErrorCode, ErrorPayload } from "./types.js";

// envelope.ts 를 "MM-DD HH:mm:ss:쎈티초" 로 표기한다(예: "10-02 15:12:10:99") — epoch 숫자보다 바로
// 알아보기 쉽게 하려는 사용자 요청(2026-10-02). 서버 로컬 시각 기준.
function FormatTimestamp(date: Date): string {
    const Pad = (n: number): string => String(n).padStart(2, "0");
    const centiseconds = Math.floor(date.getMilliseconds() / 10);
    return `${Pad(date.getMonth() + 1)}-${Pad(date.getDate())} ${Pad(date.getHours())}:${Pad(date.getMinutes())}:${Pad(date.getSeconds())}:${Pad(centiseconds)}`;
}

export function SendMessage<P>(room: Room, client: Client, type: string, payload: P): void {
    const envelope: Envelope<P> = { type, payload, ts: FormatTimestamp(new Date()) };
    log.LogServerMessage(room, client, type, payload);
    client.send(type, envelope);
}

export function SendError(room: Room, client: Client, code: ErrorCode, message: string): void {
    const payload: ErrorPayload = { code, message };
    SendMessage(room, client, types.MessageType.ERROR, payload);
}

// ENTER_LOBBY / NAME 처럼, 요청과 같은 type 이름으로 { result, error? } 를 돌려주는 응답 헬퍼.
// (통신 문서 기준 — 요청 type 을 그대로 재사용해 결과를 알려준다)
export function SendResult<E extends number>(
    room: Room,
    client: Client,
    type: string,
    result: "Y" | "N",
    error?: E
): void {
    SendMessage(room, client, type, error === undefined ? { result } : { result, error });
}

// ReadPayload 는 common/types.ts 로 옮겼다 (2026-10-06) — log.ts 의 RegisterLoggedMessage 가 모든 C→S
// 메시지에 적용해야 하는데, messages.ts 가 log.ts 를 import 하고 있어서 여기 두면 순환 import 가 된다.
