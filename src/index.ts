// 서버 진입점 — 실행할 때 "어떤 채널로 켤지" 를 받아 해당 포트로 서버 하나를 기동한다.
// 사용법: node dist/index.js <watcher|lobby|rps|othello> <채널 번호>   (채널 번호는 1부터)
//   예) node dist/index.js lobby 1     → lobby_1 룸, 포트 6011
//       node dist/index.js othello 1   → othello_1 룸, 포트 6031
// 채널 하나 = 서버 프로세스 하나 = 포트 하나 (CLAUDE.md 규모 스펙)
// ⚠️ 2026-10-02 "게임별 분리 구조" — 두 번째 인자가 "game" 이 아니라 **구체적인 게임 종류**(rps 등)다.
// 오델로를 추가하면 "othello" 를 새 분기로 더한다(기존 분기는 안 건드림).

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { RedisPresence } from "@colyseus/redis-presence";
import { RedisDriver } from "@colyseus/redis-driver";
import { config } from "./common/config.js";
import * as channelNames from "./common/channelNames.js";
import type { ChannelType } from "./common/channelNames.js";
import * as constants from "./common/constants.js";
import * as roomRegistry from "./common/roomRegistry.js";
import * as channelHeartbeat from "./db/channelHeartbeat.js";
import * as channelUsers from "./db/channelUsers.js";
import * as noticePubSub from "./db/noticePubSub.js";
import { LobbyRoom } from "./game/lobby/LobbyRoom.js";
import { OthelloGameRoom } from "./game/othello/OthelloGameRoom.js";
import { RpsGameRoom } from "./game/rps/RpsGameRoom.js";
import { WatcherRoom } from "./watch/WatcherRoom.js";

function Sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 무중단 재시작(드레인, TASKS.md Phase 9) — 이 게임 채널에 진행 중인 게임이 하나도 없어질 때까지
// 기다린다. CHANNEL_DRAIN_MAX_WAIT_SEC 가 지나도 안 끝나면(드문 경우) 포기하고 그냥 종료를 진행한다 —
// 영원히 기동 못 하는 것보다, 극단적인 경우 진행 중인 게임 몇 개가 끊기는 쪽이 낫다고 판단했다.
async function WaitUntilGamesFinish(room_name: string): Promise<void> {
    const deadline = Date.now() + constants.CHANNEL_DRAIN_MAX_WAIT_SEC * 1000;
    while (Date.now() < deadline) {
        const in_progress = roomRegistry.CountRoomsInProgress(room_name);
        if (in_progress === 0) return;
        console.log(`[${room_name}] 드레인 대기 중 — 진행 중인 게임 ${in_progress}개`);
        await Sleep(constants.CHANNEL_DRAIN_POLL_INTERVAL_SEC * 1000);
    }
    console.warn(`[${room_name}] 드레인 최대 대기 시간(${constants.CHANNEL_DRAIN_MAX_WAIT_SEC}초)을 넘겨 포기하고 종료를 진행합니다`);
}

function ParseArgs(): { channel_type: ChannelType; channel_no: number } {
    const [type_arg, no_arg] = process.argv.slice(2);

    // 게임 종류는 channelNames.ALL_GAME_TYPES 를 그대로 쓴다 — 게임을 추가할 때 여기를 또 고치지
    // 않도록 일반화했다(2026-10-07 오델로 추가).
    if (type_arg !== "watcher" && type_arg !== "lobby" && !channelNames.IsGameType(type_arg)) {
        const games = channelNames.ALL_GAME_TYPES.join("|");
        throw new Error(`사용법: node dist/index.js <watcher|lobby|${games}> <채널 번호>`);
    }
    const channel_no = Number(no_arg ?? "1");
    if (!Number.isInteger(channel_no)) {
        throw new Error(`채널 번호는 정수여야 합니다: ${no_arg}`);
    }
    return { channel_type: type_arg, channel_no };
}

// wss(TLS) 사용 시 https 서버, 아니면 http 서버 위에 WebSocket 을 올린다
function CreateHttpServer(): http.Server | https.Server {
    if (!config.use_tls) {
        return http.createServer();
    }
    if (!config.tls_cert_path || !config.tls_key_path) {
        throw new Error("USE_TLS=true 이면 TLS_CERT_PATH, TLS_KEY_PATH 를 .env 에 설정해야 합니다");
    }
    return https.createServer({
        cert: fs.readFileSync(config.tls_cert_path),
        key: fs.readFileSync(config.tls_key_path),
    });
}

async function Main(): Promise<void> {
    const { channel_type, channel_no } = ParseArgs();
    const port = channelNames.GetChannelPort(channel_type, channel_no);
    const channel_id = channelNames.GetChannelId(channel_type, channel_no);
    const room_name = channelNames.GetChannelRoomName(channel_type, channel_no);

    // 관리자 계정이 .env 에 없으면(빈 문자열) 누구나 빈 비밀번호로 로그인 가능한 사고로 이어질 수 있어
    // Watcher 채널 자체를 기동하지 않는다 (config.ts 참고).
    if (channel_type === "watcher" && (config.admin_id === "" || config.admin_password === "")) {
        throw new Error("ADMIN_ID / ADMIN_PASSWORD 가 .env 에 설정되어 있지 않습니다 (Watcher 채널 기동 거부)");
    }

    // 로비 프로세스가 다른 프로세스(게임 채널)의 방에 좌석을 예약하려면, 모든 채널이
    // 같은 Redis 를 통해 방 목록/좌석 예약 요청을 주고받아야 한다 (Presence = pub/sub, Driver = 방 목록 저장소).
    const redis_options = { host: config.redis_host, port: config.redis_port };
    const server = new Server({
        transport: new WebSocketTransport({ server: CreateHttpServer() }),
        presence: new RedisPresence(redis_options),
        driver: new RedisDriver(redis_options),
        // ⚠️ 채널마다 프로세스/포트가 다르므로 반드시 필요하다. 이게 없으면 클라이언트가
        // consumeSeatReservation() 을 호출할 때 "원래 접속했던 주소"(로비)로 다시 연결을 시도해서,
        // 좌석이 실제로 있는 게임 채널(다른 포트)에 닿지 못하고 "seat reservation expired" 로 실패한다.
        // (실제로 재현해서 확인한 문제 — 나중에 ip/port 를 명시로 응답하는 방식으로 바뀌면 이 옵션은 필요 없어진다)
        publicAddress: `${config.public_host}:${port}`,
        // ⚠️ Colyseus 기본 room 생성 라우팅(selectProcessIdToCreateRoom)은 roomName 을 안 보고 그냥
        // "방이 가장 적은 프로세스"를 고른다 — 로비/게임이 같은 클러스터(같은 Redis)를 공유하는 이 프로젝트
        // 구조에서는, 게임 채널에 방이 쌓이면 오히려 rps_N 을 전혀 모르는 로비 프로세스가 선택돼
        // "provided room name not defined" 로 실패하는 걸 실제로 겪었다(db/channelHeartbeat.ts 참고).
        // 우리 하트비트로 "이 채널을 처리하는 프로세스"를 정확히 지목하도록 기본 로직을 교체한다.
        selectProcessIdToCreateRoom: channelHeartbeat.SelectProcessIdForRoom,
    });

    if (channel_type === "lobby") {
        server.define(room_name, LobbyRoom);
    } else if (channel_type === "watcher") {
        server.define(room_name, WatcherRoom);
    } else if (channelNames.IsGameType(channel_type)) {
        // 게임 종류별 Room 클래스. 게임을 추가하면 이 맵에 한 줄 더한다 — 아래 드레인 처리는
        // 게임 무관이라 그대로 공유된다(2026-10-07 오델로 추가 때 일반화).
        const GAME_ROOM_CLASSES = {
            rps: RpsGameRoom,
            othello: OthelloGameRoom,
        } as const;
        server.define(room_name, GAME_ROOM_CLASSES[channel_type]);

        // 무중단 재시작(드레인, TASKS.md Phase 9) — 로비는 끊기면 다른 로비로 재접속하면 되므로
        // 게임 채널만 이 처리가 필요하다. Colyseus 의 기본 SIGINT/SIGTERM 핸들러(registerGracefulShutdown)
        // 는 onBeforeShutdown 콜백이 끝난 뒤에야 클라이언트를 전부 끊고 process.exit() 한다 — 그 사이에
        // "새 매칭을 막고 진행 중인 게임이 끝나길 기다리는" 시간을 벌 수 있다.
        server.onBeforeShutdown(async () => {
            console.log(`[${channel_id}] 재시작/종료 신호 수신 — ${room_name} 채널을 닫는 중으로 표시합니다`);
            await channelHeartbeat.MarkChannelClosing(channel_type, channel_no);
            await WaitUntilGamesFinish(room_name);
        });
    }

    // matchMaker.accept() 가 listen() 안에서 실행되므로, 룸을 미리 만드는 작업은 listen() 이후에 한다
    await server.listen(port);

    // ⚠️ 이 검사를 특정 게임으로 하드코딩하면(예전에는 `=== "rps"` 였다) 새 게임이 "닫는 중" 표시를
    // 못 지워서, 무중단 재시작을 한 번 거친 뒤부터 그 채널이 새 매칭을 영구히 못 받는다.
    if (channelNames.IsGameType(channel_type)) {
        // 이전 생애(재시작 전)의 "닫는 중" 표시가 남아 있을 수 있으니, 새로 뜰 때마다 지우고 시작한다.
        await channelHeartbeat.ClearChannelClosing(channel_type, channel_no);
    }

    // 이 채널이 "지금 켜져 있음" + "이 프로세스가 처리한다" 를 Redis 에 표시한다 — 로비가 게임 채널로
    // 매칭할 때 켜진 채널만 고르는 데(GameRoomMatcher.CreateRoomForTwo) 쓰고, SelectProcessIdForRoom 이
    // 방 생성을 정확한 프로세스로 라우팅하는 데도 쓴다. 최초 1회 완료를 기다린 뒤에 이어져야
    // (아래 로비 룸 생성이 이 하트비트를 바로 조회하므로) 안전하다.
    await channelHeartbeat.StartChannelHeartbeat(channel_type, channel_no, matchMaker.processId);

    if (channel_type === "lobby" || channel_type === "watcher") {
        // 로비/Watcher 룸은 사람이 없어도 사라지지 않아야 하므로(autoDispose=false), 매칭/접속을
        // 기다리지 않고 서버 기동 시점에 바로 만들어 둔다.
        await matchMaker.createRoom(room_name, {});
        console.log(`[${channel_id}] ${room_name} 룸을 미리 생성했습니다`);
    }

    if (channel_type !== "watcher") {
        // 관리자 공지(SEND_NOTICE) 수신 대기 — Watcher 가 SEND_NOTICE 를 받으면 Redis Pub/Sub 로 모든
        // 로비/게임 채널에 전파하고, 이 구독이 "내 room_name 이 관리자가 고른 채널 목록에 있는지" 확인한
        // 뒤에만 이 프로세스에 붙어 있는 클라이언트에게 뿌린다.
        noticePubSub.SubscribeNotice(room_name);
        // ADMIN_CHANNEL_USER 조회용 — 이 채널의 접속자 목록을 주기적으로 Redis 에 올려 둔다.
        channelUsers.StartChannelUsersReporter(room_name, () => roomRegistry.GetUserEntriesByRoomName(room_name));
    }

    const protocol = config.use_tls ? "wss" : "ws";
    console.log(`[${channel_id}] 서버 시작 ${protocol}://localhost:${port}`);
}

Main().catch((error) => {
    console.error("[index] 서버 시작 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
});
