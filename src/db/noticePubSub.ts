// 관리자 공지(SEND_NOTICE) 를 Redis Pub/Sub 으로 모든 로비/게임 채널 프로세스에 전파한다. 관리자가
// 지정한 채널(room_name 목록)에 붙어 있는 유저에게만 전달한다 — 엑셀본 "관리자" 시트 기준(2026-09-30).
// 흐름: 관리자 페이지 → (소켓) → Watcher(PublishNotice) → Redis Pub/Sub(모든 채널이 구독) →
//       각 로비/게임 채널(SubscribeNotice)이 "내 channels 목록에 내 room_name 이 있는지" 확인 →
//       있으면 이 프로세스에 붙어 있는 클라이언트에게 SEND_NOTICE 전송 (없으면 무시)
//
// ioredis 는 subscribe 모드로 들어간 연결로는 다른 명령(get/set 등)을 실행할 수 없다 — 그래서
// db/redis.ts 의 공유 클라이언트를 재사용하지 않고, publish 용/subscribe 용 커넥션을 각각 따로 둔다.

import { Redis } from "ioredis";
import { config } from "../common/config.js";
import * as messages from "../common/messages.js";
import * as roomRegistry from "../common/roomRegistry.js";
import * as types from "../common/types.js";
import type { NoticePayload } from "../common/types.js";

const NOTICE_CHANNEL = "notice:broadcast";

// Redis Pub/Sub 으로 실어 나르는 내부 전송 형식 — 클라이언트에 그대로 보내는 NoticePayload 와 달리
// "어느 채널에 보낼지" 정보(channels)가 얹혀 있다.
interface NoticeBroadcast {
    channels: string[];
    message: string;
}

let publisher: Redis | undefined;

function GetPublisher(): Redis {
    if (!publisher) {
        publisher = new Redis({ host: config.redis_host, port: config.redis_port });
    }
    return publisher;
}

// Watcher 프로세스에서 SEND_NOTICE 를 받으면 호출한다. channels 는 room_name(lobby_1, game_1 등) 목록.
export async function PublishNotice(message: string, channels: string[]): Promise<void> {
    const broadcast: NoticeBroadcast = { channels, message };
    await GetPublisher().publish(NOTICE_CHANNEL, JSON.stringify(broadcast));
}

// 로비/게임 채널 프로세스가 기동 시 한 번 호출한다 (index.ts). room_name 은 이 프로세스가 담당하는
// 채널 이름(예: "lobby_1") — 수신한 공지의 channels 목록에 이 이름이 있을 때만 로컬 클라이언트에게 뿌린다.
export function SubscribeNotice(room_name: string): void {
    const subscriber = new Redis({ host: config.redis_host, port: config.redis_port });

    subscriber.subscribe(NOTICE_CHANNEL).catch((error) => {
        console.error("[noticePubSub] 구독 실패:", error instanceof Error ? error.message : error);
    });

    subscriber.on("message", (_channel: string, raw: string) => {
        let broadcast: NoticeBroadcast;
        try {
            broadcast = JSON.parse(raw) as NoticeBroadcast;
        } catch {
            console.error("[noticePubSub] SEND_NOTICE 페이로드 파싱 실패:", raw);
            return;
        }

        if (!Array.isArray(broadcast.channels)) return; // channels 가 없으면 보낼 대상을 알 수 없다
        if (!broadcast.channels.includes(room_name)) return; // 이 채널은 대상이 아니다

        const payload: NoticePayload = { message: broadcast.message };
        // ⚠️ GetRegisteredRooms()(이 프로세스의 모든 Room)가 아니라 room_name 으로 거른 Room 에만 보낸다.
        // 지금은 한 프로세스가 한 채널만 담당해서 결과가 같지만, 공지를 "관리자가 고른 채널에만" 보낸다는
        // 규칙을 프로세스 단위가 아니라 Room 단위로 지켜야 한다 (2026-10-06 수정).
        for (const room of roomRegistry.GetRegisteredRoomsByRoomName(room_name)) {
            for (const client of room.clients) {
                messages.SendMessage(room, client, types.MessageType.SEND_NOTICE, payload);
            }
        }
    });
}
