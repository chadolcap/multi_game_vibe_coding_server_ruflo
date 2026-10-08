// "기다리는 방" 목록 — Redis 에 기록해 로비 프로세스가 볼 수 있게 한다 (CLAUDE.md 게임 규칙 12번).
// 게임방 프로세스(게임 Room 클래스, 지금은 RpsGameRoom)가 등록/삭제하고, 로비 프로세스
// (GameRoomMatcher)가 꺼내 쓴다.
// Redis LIST 를 FIFO 큐로 쓴다 — RPUSH(등록) / LPOP(꺼내기) 는 각각 원자적이라
// 로비 채널 2개가 동시에 같은 방을 집어가는 경합이 생기지 않는다.
// 2026-10-02 "게임별 분리 구조" — 큐를 게임 종류별로 나눈다(각 게임이 자기 게임의 "기다리는 방"만
// 보게). 그렇지 않으면 가위바위보 대기자가 오델로 "기다리는 방"에 잘못 들어갈 수 있다.

import type { GameType } from "../../common/channelNames.js";
import * as redis from "../../db/redis.js";
import type { WaitingRoomEntry } from "./types.js";

function GetWaitingRoomsKey(game_type: GameType): string {
    return `waiting_rooms:${game_type}`;
}

// 방에 혼자 남은 유저가 생겼을 때 등록한다 (Phase 5 에서 사용)
export async function PushWaitingRoom(game_type: GameType, entry: WaitingRoomEntry): Promise<void> {
    await redis.GetRedisClient().rpush(GetWaitingRoomsKey(game_type), JSON.stringify(entry));
}

// 가장 먼저 등록된 기다리는 방 하나를 꺼낸다. 없으면 null (원자적 — 여러 로비 프로세스가 동시에 불러도 안전)
export async function PopWaitingRoom(game_type: GameType): Promise<WaitingRoomEntry | null> {
    const raw = await redis.GetRedisClient().lpop(GetWaitingRoomsKey(game_type));
    if (raw === null) return null;
    return JSON.parse(raw) as WaitingRoomEntry;
}

// 등록된 뒤 유저가 나가버리는 등, 대기를 그만둘 때 목록에서 지운다 (Phase 5 에서 사용).
// PushWaitingRoom 에 넘겼던 것과 내용이 같은 entry 를 넘겨야 정확히 지워진다.
export async function RemoveWaitingRoom(game_type: GameType, entry: WaitingRoomEntry): Promise<void> {
    await redis.GetRedisClient().lrem(GetWaitingRoomsKey(game_type), 0, JSON.stringify(entry));
}
