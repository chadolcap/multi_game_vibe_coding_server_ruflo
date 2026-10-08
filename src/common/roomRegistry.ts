// 이 프로세스(로비/게임 채널) 안에서 살아있는 Room 인스턴스를 추적한다.
// Watcher 는 별도 프로세스라 이 레지스트리를 직접 조회할 수 없다 — 여기 정보는
// (1) SEND_NOTICE 브로드캐스트(이 프로세스에 붙어 있는 클라이언트에게 즉시 전달)와
// (2) 채널 유저 리포터(db/channelUsers.ts, 이 정보를 주기적으로 Redis 에 올려 Watcher 가 읽게 함)
// (3) 무중단 재시작 드레인(index.ts, 이 채널에 아직 진행 중인 게임이 있는지 확인 — TASKS.md Phase 9)
// 세 용도로만 쓴다. LobbyRoom/게임 Room 클래스(RpsGameRoom 등)가 onCreate 에서 등록하고 onDispose 에서 해제한다.

import type { Room } from "@colyseus/core";
import type { AdminChannelUserEntry } from "./types.js";

interface RegisteredRoom {
    room: Room;
    GetUserEntries: () => AdminChannelUserEntry[];
    IsGameInProgress?: () => boolean; // 게임 Room 클래스(RpsGameRoom 등)만 넘긴다 — 드레인 대기 판단용
}

const rooms = new Map<Room, RegisteredRoom>();

export function RegisterRoom(room: Room, GetUserEntries: () => AdminChannelUserEntry[], IsGameInProgress?: () => boolean): void {
    rooms.set(room, { room, GetUserEntries, IsGameInProgress });
}

export function UnregisterRoom(room: Room): void {
    rooms.delete(room);
}

// 이 프로세스에 등록된 모든 Room (로비는 1개, 게임은 여러 개일 수 있다)
export function GetRegisteredRooms(): Room[] {
    return [...rooms.values()].map((entry) => entry.room);
}

// SEND_NOTICE 브로드캐스트용 — 같은 room_name(예: "rps_1")을 가진 Room 만 고른다.
// 공지는 관리자가 고른 채널(room_name)에만 가야 하므로, 프로세스 단위가 아니라 Room 단위로 걸러야 한다
// (GetUserEntriesByRoomName / CountRoomsInProgress 와 같은 기준).
export function GetRegisteredRoomsByRoomName(room_name: string): Room[] {
    return [...rooms.values()].filter((entry) => entry.room.roomName === room_name).map((entry) => entry.room);
}

// 채널 유저 리포터용 — 같은 room_name(예: "game_1")을 가진 모든 Room 인스턴스의 유저 목록을 합친다.
export function GetUserEntriesByRoomName(room_name: string): AdminChannelUserEntry[] {
    const result: AdminChannelUserEntry[] = [];
    for (const entry of rooms.values()) {
        if (entry.room.roomName === room_name) {
            result.push(...entry.GetUserEntries());
        }
    }
    return result;
}

// 무중단 재시작 드레인용 — 같은 room_name 을 가진 Room 중 "지금 실제로 게임이 진행 중인" 개수.
// "기다리는 방"(상대를 기다리는 중, 아직 게임이 시작 안 됨)은 세지 않는다 — 이미 채널을 닫는 중이라
// 새 상대가 안 들어오므로, 그걸 "진행 중"으로 세면 영원히 드레인이 안 끝난다.
export function CountRoomsInProgress(room_name: string): number {
    let count = 0;
    for (const entry of rooms.values()) {
        if (entry.room.roomName === room_name && entry.IsGameInProgress?.()) count++;
    }
    return count;
}
