// 로비에서 온 유저를 게임방에 입장시키는 역할 (로비 프로세스 안에서 동작하며,
// Redis 기반 Presence/Driver 를 통해 다른 프로세스(게임 채널)의 방에 좌석을 예약한다).
// 2026-10-02 "게임별 분리 구조" — 게임 종류(GameType)마다 이 클래스의 인스턴스를 하나씩 둔다
// (LobbyManager 참고). 이 클래스 자체는 어떤 게임인지 몰라도 되는 범용 매칭 로직만 가지고 있다.

import { matchMaker } from "@colyseus/core";
import type { GameType } from "../../common/channelNames.js";
import * as channelNames from "../../common/channelNames.js";
import * as constants from "../../common/constants.js";
import type { GameSeatAuth, OpponentInfo, SeatReservation, UserInfo } from "../../common/types.js";
import * as channelHeartbeat from "../../db/channelHeartbeat.js";
import * as playInfoRepository from "../../db/playInfoRepository.js";
import * as waitingRooms from "./waitingRooms.js";
import type { ActiveGameEntry } from "./types.js";

export interface NewRoomMatch {
    room_name: string;
    room_id: string;
    reservation_a: SeatReservation;
    reservation_b: SeatReservation;
}

export interface WaitingRoomMatch {
    room_name: string;
    room_id: string;
    reservation: SeatReservation;
    opponent: OpponentInfo;
}

export interface RejoinMatch {
    room_name: string;
    room_id: string;
    reconnection_token: string;
}

function ToPublicOpponentInfo(user: UserInfo): OpponentInfo {
    return { name: user.name, avatar: user.avatar };
}

// 게임 중이던 유저가 (F5 등으로) 로비를 거쳐 다시 들어왔을 때, activeGame.ts 에 저장해 둔 재접속
// 토큰이 아직 유효한지 확인한다. room_id 하나만 있으면 되는 게임 종류 무관 로직이라 독립 함수로
// 둔다(LobbyManager 는 재접속 대상 유저가 어느 게임에 있었는지 몰라도 — room_id 로 바로 확인 가능).
// ⚠️ matchMaker.reconnect() 가 돌려주는 값(ISeatReservation)에는 reconnectionToken 필드가 없다 —
// 원래는 클라이언트가 이미 그 토큰을 들고 있다고 가정하고(client.reconnect(token) 호출 시 클라이언트가
// 직접 넘김) 방/세션만 확인해 주는 API 라서 그렇다. 그래서 여기서는 그 반환값을 그대로 클라이언트에
// 넘기지 않고, "유효한지"만 확인하는 용도로만 쓰고(유효하면 예외 없이 반환, 무효/방 소멸 시 예외),
// 클라이언트에 돌려줄 값은 우리가 Redis 에 들고 있던 reconnection_token 을 그대로 쓴다 — 클라이언트는
// 이 값으로 client.reconnect(reconnection_token, room_name) 을 부르면 된다(consumeSeatReservation 이
// 아니다 — REJOIN_GAME payload 주석 참고).
export async function TryReconnectToGame(active_game: ActiveGameEntry): Promise<RejoinMatch | null> {
    try {
        await matchMaker.reconnect(active_game.room_id, { reconnectionToken: active_game.reconnection_token });
        return { room_name: active_game.room_name, room_id: active_game.room_id, reconnection_token: active_game.reconnection_token };
    } catch (error) {
        console.warn(
            `[GameRoomMatcher] 게임 재접속 확인 실패, 평범한 로비 입장으로 진행 (room_id=${active_game.room_id}):`,
            error instanceof Error ? error.message : error
        );
        return null;
    }
}

// TryJoinWaitingRoom 에서 드레인 중인 채널의 "기다리는 방"을 건너뛰고 재시도할 최대 횟수.
// 평소엔 0번이면 충분하다(드레인 중인 채널 자체가 드묾) — 여러 채널이 동시에 재시작 중인 극단적인
// 경우를 대비한 안전 상한일 뿐이다.
const MAX_WAITING_ROOM_SKIP_ATTEMPTS = 5;

export class GameRoomMatcher {
    constructor(
        private readonly game_type: GameType,
        private readonly channel_count: number
    ) {}

    // 좌석 예약에 담을 유저 정보를 **이 게임의 통계**로 맞춘다 (2026-10-07 오델로 추가).
    // ⚠️ 로비가 넘겨주는 UserInfo 의 통계는 가위바위보 것이다 — ENTER_LOBBY 때 queries/userInfo.ts 가
    // `JOIN rps_user_play_info` 로 가져오기 때문. 그대로 오델로 방에 넘기면 그 방이 보여주는 승률
    // (ENTER_ROOM 의 win_per, GAME_RESULT 등)이 RPS 것이 된다. 좌석 예약 직전에 한 번만 바꿔 두면
    // 게임방 코드는 "내가 받은 통계는 내 게임 것"이라고 가정할 수 있다.
    private async ToSeatUser(user: UserInfo): Promise<UserInfo> {
        try {
            return await playInfoRepository.WithGamePlayInfo(user, this.game_type);
        } catch (error) {
            // 통계 조회가 실패해도 매칭 자체를 막지는 않는다 — 승률 표시만 지난 값(또는 RPS 값)이 된다.
            console.error(`[GameRoomMatcher] ${this.game_type} 통계 조회 실패:`, error instanceof Error ? error.message : error);
            return user;
        }
    }

    // "기다리는 방"이 있으면 유저 1명을 그 방에 넣는다. 없거나(정상) 실패하면(경합 등, 드묾) null.
    //
    // ⚠️ 무중단 재시작 드레인 중(채널이 "닫는 중")인 방은 건너뛴다 — 그 채널 프로세스는 새 상대가 영원히
    // 안 들어오길 기다리고 있으므로(진행 중인 게임만 드레인 대상이라 "기다리는 방"은 그 집계에서 빠진다,
    // roomRegistry.CountRoomsInProgress 참고), 여기서 새로 넣어주지 않아야 그 채널이 재시작을 끝낼 수
    // 있다. 큐에서 꺼낸 걸 그대로 버린다(되돌려 넣지 않는다) — 어차피 그 방은 채널이 재시작되면 함께
    // 사라지므로 다시 큐에 넣어도 다음 번에도 또 걸러질 뿐이다. 최대 몇 번만 다시 시도하고 그래도 안
    // 되면(드레인 중인 "기다리는 방"이 여러 개 겹친 드문 경우) null 로 새 방 생성 경로로 넘긴다.
    public async TryJoinWaitingRoom(user: UserInfo): Promise<WaitingRoomMatch | null> {
        for (let attempt = 0; attempt < MAX_WAITING_ROOM_SKIP_ATTEMPTS; attempt++) {
            const entry = await waitingRooms.PopWaitingRoom(this.game_type);
            if (!entry) return null;

            const channel_no = channelNames.ParseChannelNo(entry.room_name);
            if (await channelHeartbeat.IsChannelClosing(this.game_type, channel_no)) {
                continue; // 드레인 중인 채널의 기다리는 방 — 버리고 다음 걸 시도
            }

            try {
                const room_cache = await matchMaker.getRoomById(entry.room_id);
                const seat_user = await this.ToSeatUser(user);
                const reservation = await matchMaker.reserveSeatFor(room_cache, {}, { user: seat_user } satisfies GameSeatAuth);
                return {
                    room_name: entry.room_name,
                    room_id: entry.room_id,
                    reservation,
                    opponent: entry.opponent,
                };
            } catch (error) {
                // 그 사이 방이 사라졌거나(상대가 나감) 꽉 찬 경우 — 드문 경합. 이 유저는 새 방 매칭으로 넘어가면 된다.
                console.warn(
                    `[GameRoomMatcher] 기다리는 방 입장 실패, 새 매칭으로 넘어감 (room_id=${entry.room_id}):`,
                    error instanceof Error ? error.message : error
                );
                return null;
            }
        }
        return null;
    }

    // 2명을 위한 새 게임방을 만든다. 지금 켜져 있는 채널 중 번호가 빠른 순으로 채우고, 꽉 차면 다음 채널.
    // 켜진 채널이 하나도 없거나 전부 실패하면 null.
    //
    // ⚠️ 채널 번호를 1..channel_count 로 무조건 순회하지 않고, 하트비트로 "지금 켜져 있는 채널"만
    // 추린다(GetAliveGameChannels) — 게임 채널이 고정적으로 항상 다 떠 있는 게 아니라 개별적으로 내려갈
    // 수 있기 때문이다(CLAUDE.md "무중단 게임 서비스" 참고). 꺼진 채널까지 시도하면 matchMaker.createRoom()
    // 이 그 룸 타입을 모르는 엉뚱한(로드가 가장 적은) 프로세스로 라우팅됐다가 "provided room name not
    // defined" 로 실패하는 문제가 실제로 있었다 — Colyseus 자체에는 "어떤 프로세스가 어떤 룸 이름을
    // 처리하는지" 클러스터 전체에서 조회할 방법이 없어서, 하트비트를 직접 만들어 확인한다.
    public async CreateRoomForTwo(user_a: UserInfo, user_b: UserInfo): Promise<NewRoomMatch | null> {
        const alive_channel_numbers = await channelHeartbeat.GetAliveGameChannels(this.game_type, this.channel_count);

        for (const channel_no of alive_channel_numbers) {
            // 무중단 재시작 드레인 중인 채널 — 켜져 있긴 하지만(하트비트 살아있음) 새 방을 받지 않는다.
            if (await channelHeartbeat.IsChannelClosing(this.game_type, channel_no)) continue;

            const room_name = channelNames.GetChannelRoomName(this.game_type, channel_no);

            const existing_rooms = await matchMaker.query({ name: room_name });
            if (existing_rooms.length >= constants.MAX_ROOMS_PER_GAME_CHANNEL) {
                continue; // 이 채널 꽉 참 — 다음 채널 시도
            }

            try {
                const room_cache = await matchMaker.createRoom(room_name, {});
                const [seat_user_a, seat_user_b] = await Promise.all([this.ToSeatUser(user_a), this.ToSeatUser(user_b)]);
                const reservation_a = await matchMaker.reserveSeatFor(room_cache, {}, { user: seat_user_a } satisfies GameSeatAuth);
                const reservation_b = await matchMaker.reserveSeatFor(room_cache, {}, { user: seat_user_b } satisfies GameSeatAuth);
                return { room_name, room_id: room_cache.roomId, reservation_a, reservation_b };
            } catch (error) {
                console.error(`[GameRoomMatcher] ${room_name} 방 생성/좌석 예약 실패:`, error instanceof Error ? error.message : error);
                // 이 채널에서 문제가 생기면 다음 채널로 넘어간다
            }
        }
        return null; // 켜진 채널이 없거나 전부 꽉 찼거나 실패 — NO_GAME_ROOM
    }
}

export { ToPublicOpponentInfo };
