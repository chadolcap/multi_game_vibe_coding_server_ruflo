// 채널 ID / 룸 이름 규칙
// - 채널 번호(channel_no)는 **1부터** 센다. (channel_no == 채널 ID, 둘이 같은 값)
// - Colyseus 룸 이름은 채널마다 따로 등록하며, 채널별 통계도 이 이름으로 구분한다.

import { config } from "./config.js";
import * as constants from "./constants.js";

// 실제 게임 종류 목록 — 게임을 추가하면 여기에 하나 더한다(2026-10-02 "게임별 분리 구조" 참고).
// 채널(프로세스/포트)과 DB 통계 테이블이 게임별로 완전히 분리돼 있으므로, 새 게임을 추가할 때
// GetChannelPort 의 분기 하나 + .env 의 포트 목록 + common/constants.ts 의 채널수 상수를 같이 늘린다.
export type GameType = "rps" | "othello";

export type ChannelType = "watcher" | "lobby" | GameType;

// 실제로 지원하는 게임 목록 — 게임을 추가하면 여기에도 더한다. 런타임 화이트리스트로도 쓴다
// (클라이언트가 보낸 game 값은 TypeScript 타입으로 막히지 않으므로, 이 목록으로 직접 검사해야 한다).
// 2026-10-07: LobbyManager 안에만 있던 걸 여기로 옮겼다 — WatcherManager 도 관리자 메시지의 game 필드를
// 검사해야 해서, 게임을 추가할 때 고칠 자리가 두 군데로 흩어지지 않게 한 곳에 모았다.
export const ALL_GAME_TYPES: GameType[] = ["rps", "othello"];

export function IsGameType(value: unknown): value is GameType {
    return typeof value === "string" && (ALL_GAME_TYPES as string[]).includes(value);
}

// 룸 이름("rps_1", "othello_2")에서 게임 종류를 뽑는다. 게임 룸 이름이 아니면(예: "lobby_1", "watcher")
// undefined. REJOIN_GAME 처럼 "이 방이 어느 게임인지"를 room_name 으로만 알 수 있는 곳에서 쓴다.
export function ParseGameTypeFromRoomName(room_name: string): GameType | undefined {
    const prefix = room_name.split("_")[0];
    return IsGameType(prefix) ? prefix : undefined;
}

// 그 게임의 채널이 몇 개인지. 게임을 추가하면 분기를 하나 더한다(GetChannelPort 와 같은 이유로 상수다 —
// GameRoomMatcher 가 "몇 번 채널까지 있는지"를 알아야 한다).
export function GetGameChannelCount(game: GameType): number {
    if (game === "rps") return constants.RPS_CHANNEL_COUNT;
    if (game === "othello") return constants.OTHELLO_CHANNEL_COUNT;
    throw new Error(`알 수 없는 게임 종류입니다: ${game}`);
}

// Watcher 룸 이름 — 채널이 1개뿐이라 번호를 붙이지 않는다. 그 외(lobby/게임 종류)는 모두
// `${channel_type}_${channel_no}` 패턴이 같다(lobby_1, rps_1 등) — 예전엔 로비/게임 전용 함수가
// 따로 있었는데, "game" 이 구체적인 게임 종류(rps 등)로 바뀌면서 패턴이 통일돼 하나로 합쳤다.
export function GetChannelRoomName(channel_type: ChannelType, channel_no: number): string {
    if (channel_type === "watcher") return "watcher";
    return `${channel_type}_${channel_no}`;
}

// "rps_2" → 2 처럼, 룸 이름 끝의 번호만 뽑는다. 접두사(어떤 게임/로비인지)는 신경 쓰지 않는다 —
// 게임 Room 클래스는 자기 채널 번호를 따로 안 들고 있어서, "기다리는 방" 등록(WaitingRoomEntry.channel_no)
// 시 this.roomName 에서 이걸로 구한다.
export function ParseChannelNo(room_name: string): number {
    const match = /_(\d+)$/.exec(room_name);
    if (!match) throw new Error(`채널 룸 이름 형식이 아닙니다: ${room_name}`);
    return Number(match[1]);
}

// 채널 ID (로그/통계 표시용): lobby-1, rps-3 처럼 종류별로 1부터. channel_no 와 같은 값이라 그대로 이어 붙인다
export function GetChannelId(channel_type: ChannelType, channel_no: number): string {
    return `${channel_type}-${channel_no}`;
}

// 채널 종류와 번호로 포트를 찾는다. 범위를 벗어나면 에러
export function GetChannelPort(channel_type: ChannelType, channel_no: number): number {
    if (channel_type === "watcher") {
        if (channel_no !== 1) throw new Error(`watcher 채널은 1번 하나뿐입니다: ${channel_no}`);
        return config.watcher_port;
    }

    if (channel_type === "lobby") {
        const ports = config.lobby_ports;
        // 로비 채널 수는 상수(코드에 박아두지 않음)가 아니라 .env 의 LOBBY_PORTS 목록 길이로 정한다 —
        // 로비 채널은 서로 독립적이라(매칭 시 다른 로비 채널을 알 필요 없음) 다른 프로세스가 "몇 개인지"를
        // 알아야 할 이유가 없다. 그래서 트래픽이 몰릴 때 .env 에 포트만 추가하고 그 채널 프로세스만
        // 새로 띄우면 되고, 코드 수정/재빌드나 이미 떠 있는 다른 채널 재시작이 필요 없다.
        return GetPortFromList(channel_type, channel_no, ports, ports.length);
    }

    // 게임 종류(GameType)별 분기 — 게임을 추가하면 여기 if 를 하나 더한다.
    // (GameRoomMatcher 가 "지금 켜진 채널 몇 번까지 있는지"를 알아야 해서 채널수는 상수로 둔다 —
    // CLAUDE.md "로비/게임 채널 늘리기" 참고)
    if (channel_type === "rps") {
        return GetPortFromList(channel_type, channel_no, config.rps_ports, constants.RPS_CHANNEL_COUNT);
    }

    if (channel_type === "othello") {
        return GetPortFromList(channel_type, channel_no, config.othello_ports, constants.OTHELLO_CHANNEL_COUNT);
    }

    throw new Error(`알 수 없는 채널 종류입니다: ${channel_type}`);
}

function GetPortFromList(channel_type: ChannelType, channel_no: number, ports: number[], channel_count: number): number {
    if (!Number.isInteger(channel_no) || channel_no < 1 || channel_no > channel_count) {
        throw new Error(`${channel_type} 채널 번호는 1~${channel_count} 이어야 합니다: ${channel_no}`);
    }
    const port = ports[channel_no - 1];
    if (port === undefined) {
        throw new Error(`${channel_type} ${channel_no}번 채널의 포트 설정이 없습니다 (.env 확인)`);
    }
    return port;
}
