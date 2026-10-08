// 채널(주로 게임 채널)이 "지금 실제로 떠 있는지" + "그 채널을 처리하는 프로세스 ID" 를 Redis 에 TTL 로
// 표시한다 (하트비트, 자동 만료).
//
// Colyseus 의 matchMaker 는 클러스터 전체에서 "어떤 프로세스가 어떤 룸 이름을 처리하는지" 조회할 방법이
// 없다(Stats.fetchAll() 은 프로세스별 roomCount/ccu 만 준다). 그래서 matchMaker.createRoom() 의 기본
// 프로세스 선택 로직(selectProcessIdToCreateRoom, @colyseus/core MatchMaker.ts)은 **roomName 을 아예
// 보지 않고 그냥 "지금 방이 가장 적은 프로세스"를 고른다** — 그 프로세스가 실제로 그 룸 타입을
// 처리할 수 있는지는 전혀 확인하지 않는다.
//
// ⚠️ **실제로 겪은 버그 (2026-09-30)**: 로비와 게임 채널이 같은 Colyseus 클러스터(같은 Redis)를 공유하는
// 이 프로젝트 구조에서, 게임 채널에 방이 여러 개 쌓여 로드(roomCount)가 올라가면 — 그 room 타입을 전혀
// 모르는(`rps_N` 을 `.define()` 하지 않은) **로비** 프로세스가 오히려 "방이 더 적다"는 이유로 선택돼
// `matchMaker.createRoom("rps_1", ...)` 이 로비 프로세스로 라우팅됐다가 "provided room name not
// defined" 로 실패했다. 개발 환경(로비 1 + 게임 1, 프로세스가 딱 2개)에서는 이 오작동이 훨씬 잦다 —
// 후보가 2개뿐이라 "방 개수가 적은 쪽"이 쉽게 로비로 뒤집힌다. 채널이 꺼져 있을 때만 대비하던
// `GetAliveGameChannels` 필터로는 이 경우를 못 막는다(rps_1 은 멀쩡히 켜져 있으니까) — 그래서
// **어떤 채널을 어떤 프로세스가 처리하는지**까지 하트비트에 함께 기록하고, `index.ts` 에서
// `new Server({ selectProcessIdToCreateRoom: SelectProcessIdForRoom })` 로 Colyseus 의 기본 선택
// 로직 자체를 교체했다(SelectProcessIdForRoom 참고) — 이게 근본적인 해결책이다.
//
// 프로세스가 죽으면(정상 종료든 크래시든) 별도 정리 없이 TTL 이 지나면 자동으로 사라진다. 여기서 따로
// SIGINT/SIGTERM 을 잡아 정리하지 않는다 — Colyseus 가 이미 자체적으로 그 시그널을 잡아 graceful shutdown
// 을 하므로(@colyseus/core 의 Server.cjs registerGracefulShutdown), 여기서 또 잡아 처리하면 그 흐름과
// 경합할 수 있다.

import { matchMaker } from "@colyseus/core";
import type { ChannelType, GameType } from "../common/channelNames.js";
import * as constants from "../common/constants.js";
import * as redis from "./redis.js";

function GetHeartbeatKey(channel_type: ChannelType, channel_no: number): string {
    return `channel:${channel_type}:${channel_no}:alive`;
}

function GetClosingKey(channel_type: ChannelType, channel_no: number): string {
    return `channel:${channel_type}:${channel_no}:closing`;
}

// 무중단 재시작(드레인, Phase 9) — 이 채널을 "닫는 중"으로 표시한다. GameRoomMatcher 가 새 방을 만들거나
// "기다리는 방"에 새 상대를 넣을 때 이 표시가 있는 채널은 건너뛴다. index.ts 의 server.onBeforeShutdown
// 에서 호출한다(게임 채널만 — 로비는 끊기면 다른 로비로 재접속하면 되므로 드레인이 필요 없다).
export async function MarkChannelClosing(channel_type: ChannelType, channel_no: number): Promise<void> {
    await redis.GetRedisClient().set(GetClosingKey(channel_type, channel_no), "1", "EX", constants.CHANNEL_CLOSING_TTL_SEC);
}

// 채널이 새로 기동될 때(index.ts) 호출해서, 이전 생애의 "닫는 중" 표시가 남아 있지 않게 한다 —
// TTL 만 믿으면 재시작이 TTL 보다 빠를 때 새 프로세스가 곧바로 "닫는 중"으로 오인될 수 있다.
export async function ClearChannelClosing(channel_type: ChannelType, channel_no: number): Promise<void> {
    await redis.GetRedisClient().del(GetClosingKey(channel_type, channel_no));
}

export async function IsChannelClosing(channel_type: ChannelType, channel_no: number): Promise<boolean> {
    const value = await redis.GetRedisClient().get(GetClosingKey(channel_type, channel_no));
    return value !== null;
}

// 채널 프로세스가 기동될 때(server.listen() 이후) 한 번 호출한다. CHANNEL_HEARTBEAT_INTERVAL_SEC 마다
// TTL(CHANNEL_HEARTBEAT_TTL_SEC)을 다시 걸어 "살아있음"을 계속 표시한다. 값 자체를 이 프로세스의
// processId 로 저장해서, SelectProcessIdForRoom 이 "이 채널은 정확히 어느 프로세스가 맡고 있는지"
// 바로 알 수 있게 한다(이전엔 단순히 "1" 만 저장했다).
export async function StartChannelHeartbeat(channel_type: ChannelType, channel_no: number, process_id: string): Promise<void> {
    const key = GetHeartbeatKey(channel_type, channel_no);
    const redis_client = redis.GetRedisClient();

    const Beat = async (): Promise<void> => {
        try {
            await redis_client.set(key, process_id, "EX", constants.CHANNEL_HEARTBEAT_TTL_SEC);
        } catch (error) {
            console.error(`[채널 하트비트] ${key} 갱신 실패:`, error instanceof Error ? error.message : error);
        }
    };
    // 최초 1회는 완료를 기다린다 — index.ts 가 로비 룸을 미리 만들 때(matchMaker.createRoom) 곧바로
    // SelectProcessIdForRoom 이 이 채널의 하트비트를 조회하므로, 이 SET 이 아직 Redis 에 반영되기 전에
    // 조회가 먼저 일어나는 경합을 막는다.
    await Beat();
    setInterval(Beat, constants.CHANNEL_HEARTBEAT_INTERVAL_SEC * 1000);
}

// 1..max_channel_no 중 지금 하트비트가 살아있는 그 게임 종류의 채널 번호만 돌려준다.
// GameRoomMatcher 가 새 게임방을 만들 채널을 고를 때 이 목록에 있는 채널만 시도한다.
export async function GetAliveGameChannels(game_type: GameType, max_channel_no: number): Promise<number[]> {
    if (max_channel_no <= 0) return [];

    const channel_numbers = Array.from({ length: max_channel_no }, (_, i) => i + 1);
    const keys = channel_numbers.map((channel_no) => GetHeartbeatKey(game_type, channel_no));
    const values = await redis.GetRedisClient().mget(...keys);
    return channel_numbers.filter((_, i) => values[i] !== null);
}

// roomName("lobby_N"/"rps_N"/"watcher")으로 "그 채널을 지금 실제로 처리하는 프로세스 ID" 를 찾는다.
// 하트비트가 없으면(채널이 꺼져 있거나, 인식 못 하는 룸 이름이면) null.
// ⚠️ watcher 는 GetWatcherRoomName() 이 번호 없이 "watcher" 하나만 돌려주므로(채널이 1개뿐)
// 아래 `_N` 정규식에 안 걸린다 — 이걸 빠뜨리면 다른 채널과 똑같은 문제(엉뚱한 프로세스로
// matchMaker.createRoom("watcher", ...) 가 라우팅돼 "provided room name not defined")가 재현된다.
// 접두사를 특정 이름(lobby|game)으로 고정하지 않고 일반화해 둬서, 게임 종류가 늘어도(오델로 등)
// 이 파일을 또 고칠 필요가 없다.
async function GetChannelProcessId(room_name: string): Promise<string | null> {
    if (room_name === "watcher") {
        return redis.GetRedisClient().get(GetHeartbeatKey("watcher", 1));
    }
    const match = /^([a-z]+)_(\d+)$/.exec(room_name);
    if (!match) return null;
    const channel_type = match[1] as ChannelType;
    const channel_no = Number(match[2]);
    return redis.GetRedisClient().get(GetHeartbeatKey(channel_type, channel_no));
}

// Colyseus 의 기본 selectProcessIdToCreateRoom 을 대체하는 콜백 — `index.ts` 에서
// `new Server({ selectProcessIdToCreateRoom: SelectProcessIdForRoom })` 로 등록한다.
// 하트비트로 "이 채널을 처리하는 프로세스"를 알면 그 프로세스를 그대로 지목하고, 모르면(우리가 인식
// 못 하는 룸 이름 등) Colyseus 기본 동작(방이 가장 적은 프로세스)을 그대로 재현해서 넘어간다.
export async function SelectProcessIdForRoom(room_name: string): Promise<string> {
    const known_process_id = await GetChannelProcessId(room_name);
    if (known_process_id) return known_process_id;

    const all_stats = await matchMaker.stats.fetchAll();
    return all_stats.sort((a, b) => (a.roomCount > b.roomCount ? 1 : -1))[0]?.processId ?? matchMaker.processId;
}
