// 채널(로비/게임)별 접속자 목록을 Redis 에 주기적으로 올려 둔다. Watcher 는 별도 프로세스라 로비/게임
// 프로세스의 메모리(roomRegistry)를 직접 읽을 수 없어서, 그 대신 이 스냅샷을 ADMIN_CHANNEL_USER 응답에 쓴다.
// (ADMIN_CHANNEL_COUNT 는 matchMaker.query() 로 그때그때 실시간 집계하므로 이 스냅샷을 쓰지 않는다 — 그건
// Colyseus 의 RedisDriver 가 이미 room 생성/삭제마다 자동으로 관리해 주는 값이라 별도 리포트가 필요 없다)

import * as redis from "./redis.js";
import * as constants from "../common/constants.js";
import type { AdminChannelUserEntry } from "../common/types.js";

function ChannelUsersKey(room_name: string): string {
    return `channel_users:${room_name}`;
}

async function ReportChannelUsers(room_name: string, users: AdminChannelUserEntry[]): Promise<void> {
    await redis.GetRedisClient().set(ChannelUsersKey(room_name), JSON.stringify(users), "EX", constants.CHANNEL_USERS_TTL_SEC);
}

// Watcher 가 ADMIN_CHANNEL_USER 를 처리할 때 읽는다. 값이 없으면(그 채널이 꺼져 있거나, 아직 첫 리포트
// 전이거나, TTL 이 지났으면) 빈 배열로 취급한다.
export async function GetChannelUsers(room_name: string): Promise<AdminChannelUserEntry[]> {
    const raw = await redis.GetRedisClient().get(ChannelUsersKey(room_name));
    if (!raw) return [];
    return JSON.parse(raw) as AdminChannelUserEntry[];
}

// 로비/게임 채널 프로세스가 index.ts 에서 기동 시 한 번 호출한다. getUsers 는 호출할 때마다
// "지금 이 채널의 유저 목록"을 새로 계산해서 돌려줘야 한다 (roomRegistry.GetUserEntriesByRoomName 를 감싼 클로저).
export function StartChannelUsersReporter(room_name: string, getUsers: () => AdminChannelUserEntry[]): void {
    setInterval(() => {
        ReportChannelUsers(room_name, getUsers()).catch((error) => {
            console.error(`[channelUsers] 리포트 실패 room_name=${room_name}:`, error instanceof Error ? error.message : error);
        });
    }, constants.CHANNEL_USERS_REPORT_INTERVAL_SEC * 1000);
}
