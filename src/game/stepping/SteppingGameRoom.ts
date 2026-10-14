// 점핑(stepping) 게임이 진행되는 모듈 (2인, 2026-10-14 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `stepping` 시트가 기준이다.
//
// 구조는 OthelloGameRoom 과 의도적으로 같다 — 플랫폼 공통 부분(좌석 채우기/ENTER_ROOM/READY/재접속/
// 재게임·기다리는 방/activeGame/roomRegistry)은 거의 그대로 가져왔고, 게임 전용 부분만 다르다:
//   오델로: GAME_START → 돌 색 선택 → TURN_START/SELECT_GAME 턴 루프 → GAME_RESULT
//   점핑:   MAP_SELECT → (2초) → GAME_START → 60초 동안 GAME_REMAIN_TIME + 양쪽이 **동시에** MOVE_INFO
//           → 종료 조건(탈락 / 60초 / 양쪽 모두 완주) → GAME_RESULT
//
// ⚠️ 턴제가 아니라 실시간이다. 점프 판정(블록 안에 착지했는지)은 클라이언트가 하고, 서버는 MOVE_INFO 를
//    검증(steppingRules.ValidateMove)·반영·중계하고 승패를 낸다.
// ⚠️ 오델로/RPS 와 달리 **서버가 대신 둘 수 없다**(점프는 사람 손으로만 가능). 그래서 게임 중 끊김/퇴장은
//    "자동 플레이"가 아니라 **그 유저의 기록이 그 자리에서 멈춘다** — 좌석은 남겨 두고 남은 유저는 시간이
//    끝날 때까지 계속 뛴다. 재접속하면 GAME_STATUS 로 자기 칸을 되찾아 이어서 뛸 수 있다.

import { Room, CloseCode, type Client, type Deferred, type Delayed } from "@colyseus/core";
import * as channelNames from "../../common/channelNames.js";
import * as constants from "../../common/constants.js";
import * as log from "../../common/log.js";
import * as messages from "../../common/messages.js";
import * as types from "../../common/types.js";
import type {
    AdminChannelUserEntry,
    EnterRoomPayload,
    GameSeatAuth,
    OpponentJoinedPayload,
    OutUserPayload,
    ReadyPayload,
    RoomPlayerInfo,
    UserInfo,
} from "../../common/types.js";
import * as roomRegistry from "../../common/roomRegistry.js";
import * as steppingConstants from "./steppingConstants.js";
import * as steppingRules from "./steppingRules.js";
import type {
    SteppingGameResultPayload,
    SteppingGameResultPlayerInfo,
    SteppingGameStatusPayload,
    SteppingMapSelectPayload,
    SteppingMoveInfoPayload,
    SteppingMoveInfoResultPayload,
    SteppingPlayerState,
    SteppingPlayerStatus,
    SteppingPlayRecord,
    SteppingRemainTimePayload,
    SteppingReplayPayload,
} from "./steppingTypes.js";
import * as steppingGameResultRepository from "../../db/steppingGameResultRepository.js";
import * as userCache from "../../db/userCache.js";
import * as activeGame from "../room/activeGame.js";
import * as waitingRooms from "../room/waitingRooms.js";
import type { ActiveGameEntry, WaitingRoomEntry } from "../room/types.js";

const GAME_TYPE = "stepping" as const;

// 승률(0~100 정수). 한 판도 안 한 유저는 0. 게임 전용 모듈끼리 서로 import 하지 않도록(게임별 분리 원칙) 각자 둔다.
function ComputeWinPer(total_win_count: number, total_game_count: number): number {
    if (total_game_count === 0) return 0;
    return Math.round((total_win_count / total_game_count) * 100);
}

function ToRoomPlayerInfo(user: UserInfo): RoomPlayerInfo {
    return {
        userid: user.userid,
        name: user.name,
        avatar: user.avatar,
        win_per: ComputeWinPer(user.total_win_count, user.total_game_count),
    };
}

export class SteppingGameRoom extends Room {
    maxClients = constants.PLAYERS_PER_ROOM;

    // --- 플랫폼 공통 상태 (OthelloGameRoom 과 같은 의미) ---

    // sessionId → 좌석 예약에 담겨 온 유저 정보. Map 은 입력 순서를 유지하므로 player1/player2 순서
    // (먼저 입장한 쪽이 player1)를 그대로 이 순서에서 가져온다.
    private readonly players = new Map<string, UserInfo>();
    private readonly entered_by_session = new Set<string>();
    private enter_room_sent = false;
    private readonly ready_by_session = new Map<string, boolean>();
    // MAP_SELECT 를 보낸 순간부터 true. (GAME_START 전 맵 연출 2초도 "게임 중"으로 본다 — 그 사이 퇴장도
    // 게임 중 퇴장 규칙을 따르게 하기 위해서다)
    private game_started = false;
    private game_over = false;
    private game_started_at: Date | null = null;

    private readonly replay_by_session = new Map<string, boolean>();
    private replay_timeout: Delayed | null = null;
    private readonly kicked_to_lobby = new Set<string>();
    private waiting_room_entry: WaitingRoomEntry | null = null;
    private waiting_session: string | null = null;

    // 끊긴 지 RECONNECT_WAIT_SEC(5초)가 지나면 bot_sessions 에 넣는 타이머. 점핑은 서버가 대신 뛰지
    // 않으므로 bot_sessions 는 **DB 의 win_is_bot/lose_is_bot 판정에만** 쓴다("자리를 비운 채 끝났다").
    private readonly bot_timeout_by_session = new Map<string, Delayed>();
    private readonly bot_sessions = new Set<string>();
    private readonly reconnection_by_session = new Map<string, Deferred<Client>>();

    // 게임 중 **최종 퇴장**해서 재입장하지 않는 세션. 좌석(players/state_by_session)은 그대로 남겨
    // 결과를 그 유저의 승패에도 반영하고, 게임이 끝나면 FlushAbandonedPlayers() 가 OUT_USER 를 보낸다.
    private readonly abandoned_sessions = new Set<string>();

    // --- 점핑 전용 상태 ---

    // 이번 게임의 맵 번호(1~3). MAP_SELECT 전에는 null.
    private map: number | null = null;
    // GAME_START 를 보낸 뒤 true — 이때부터 MOVE_INFO 를 받는다(맵 연출 2초 동안은 받지 않는다).
    private play_started = false;
    // 남은 초. GAME_REMAIN_TIME 으로 보낸 마지막 값이고, GAME_STATUS 에도 쓴다.
    private remain_sec = 0;
    // sessionId → 그 유저의 진행 상태(칸 수, 라이프, 도착 시각 …)
    private readonly state_by_session = new Map<string, SteppingPlayerState>();
    // MAP_SELECT → GAME_START 지연 타이머
    private start_timeout: Delayed | null = null;
    // 종료 조건이 된 뒤 STEPPING_RESULT_DELAY_SEC 를 기다렸다가 FinishGame 을 부르는 타이머 (RequestFinish 참고).
    private finish_timeout: Delayed | null = null;
    // GAME_START 뒤 1초마다 GAME_REMAIN_TIME 을 보내는 인터벌. 0 이 되면 게임을 끝낸다.
    private remain_time_interval: Delayed | null = null;
    // 이번 게임에서 받아들인 MOVE_INFO 기록 — DB 로그(stepping_game_log.plays)에 쓴다. StartGame 마다 비운다.
    private readonly plays: SteppingPlayRecord[] = [];

    public onCreate(): void {
        // 이름/roomId 로 직접 들어올 수 없게 잠근다 — 예약된 좌석으로만 입장 가능
        this.lock();
        console.log(`[SteppingGameRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

        // SEND_NOTICE 브로드캐스트 + 채널 유저 리포터 + 무중단 재시작 드레인이 이 방을 찾을 수 있도록 등록
        roomRegistry.RegisterRoom(this, () => this.GetChannelUserEntries(), () => this.IsGameInProgress());

        // 좌석 예약 후 SEAT_RESERVATION_SEC 안에 2명이 다 안 모이면 정리한다
        this.clock.setTimeout(() => this.CheckSeatFillTimeout(), constants.SEAT_RESERVATION_SEC * 1000);

        log.RegisterLoggedMessage(this, types.MessageType.ENTER_ROOM, (client) => {
            this.HandleEnterRoom(client);
        });
        log.RegisterLoggedMessage<ReadyPayload>(this, types.MessageType.READY, (client, message) => {
            this.HandleReady(client, message);
        });
        log.RegisterLoggedMessage<SteppingMoveInfoPayload>(this, types.MessageType.MOVE_INFO, (client, message) => {
            this.HandleMoveInfo(client, message);
        });
        log.RegisterLoggedMessage<SteppingReplayPayload>(this, types.MessageType.GAME_RESULT, (client, message) => {
            this.HandleReplay(client, message);
        });
    }

    public onJoin(client: Client, _options: unknown, auth?: GameSeatAuth): void {
        if (!auth?.user) {
            // 정상 흐름이라면 항상 GameRoomMatcher 가 좌석 예약에 유저 정보를 담아 보낸다.
            console.error(`[SteppingGameRoom] auth.user 없이 입장 시도 sessionId=${client.sessionId}`);
            client.leave(CloseCode.WITH_ERROR);
            return;
        }

        this.players.set(client.sessionId, auth.user);
        log.LogConnect(this, client, { userid: auth.user.userid });
        this.SaveMyActiveGameRecord(client, auth.user.userid);

        if (this.waiting_room_entry) {
            // 혼자 남아 새 상대를 기다리던 방에 방금 새 유저가 들어옴 — 기존 유저에게 알린다.
            // Redis "기다리는 방" 목록에서는 로비가 이미 Pop 해 갔으므로 여기서는 우리 쪽 표시만 지운다.
            const waiting_client = this.clients.find((c) => c.sessionId !== client.sessionId);
            if (waiting_client) {
                const opponent_payload: OpponentJoinedPayload = { player: ToRoomPlayerInfo(auth.user) };
                messages.SendMessage(this, waiting_client, types.MessageType.OPPONENT_JOINED, opponent_payload);
            }
            this.waiting_room_entry = null;
            this.waiting_session = null;
        }
    }

    // 게임 중 연결이 예기치 않게 끊기면 이쪽으로 온다. 재접속 대상이 아니면 그냥 리턴한다 —
    // Colyseus 가 곧바로 onLeave() 를 불러 정리한다.
    // 끊긴 동안 그 유저의 기록은 멈춰 있고(서버가 대신 뛰지 않는다), 남은 유저는 계속 뛴다.
    public onDrop(client: Client, _code?: number): void {
        if (!this.game_started || this.game_over) {
            return;
        }

        const sessionId = client.sessionId;
        console.log(`[SteppingGameRoom] 연결 끊김, 재접속 대기 roomId=${this.roomId} sessionId=${sessionId}`);

        this.bot_timeout_by_session.set(
            sessionId,
            this.clock.setTimeout(() => {
                this.bot_sessions.add(sessionId);
            }, constants.RECONNECT_WAIT_SEC * 1000)
        );

        // "manual" — 재접속은 게임이 끝날 때까지 받는다(FinishGame 에서 강제로 닫는다).
        this.reconnection_by_session.set(sessionId, this.allowReconnection(client, "manual"));
    }

    public onReconnect(client: Client): void {
        const sessionId = client.sessionId;
        this.bot_timeout_by_session.get(sessionId)?.clear();
        this.bot_timeout_by_session.delete(sessionId);
        this.bot_sessions.delete(sessionId);
        this.reconnection_by_session.delete(sessionId);
        console.log(`[SteppingGameRoom] 재접속 roomId=${this.roomId} sessionId=${sessionId}`);

        // reconnectionToken 은 (재)입장마다 새로 발급되므로 다시 저장해 둔다 (F5 재접속 대비)
        const user = this.players.get(sessionId);
        if (user) this.SaveMyActiveGameRecord(client, user.userid);
    }

    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        const left_user = this.players.get(client.sessionId);

        // 게임이 진행 중인데 최종 퇴장했다 = 이 유저는 재입장하지 않는다는 뜻이다.
        // ⚠️ 명시적 나가기(CONSENTED)는 onDrop 을 거치지 않고 곧장 여기로 온다. 재접속 실패도 여기로 온다.
        // 좌석은 비우지 않는다 — 그 유저의 기록(칸 수/라이프)을 그대로 두고 결과를 승패에 반영한다.
        // OUT_USER 는 게임이 끝난 뒤에 보낸다(FlushAbandonedPlayers) — 오델로/RPS 와 같은 규칙.
        const abandoned_mid_game = left_user !== undefined && this.IsGameInProgress();

        if (abandoned_mid_game) {
            this.abandoned_sessions.add(client.sessionId);
            this.bot_sessions.add(client.sessionId);
        } else {
            this.players.delete(client.sessionId);
            this.state_by_session.delete(client.sessionId);
            this.bot_sessions.delete(client.sessionId);
        }

        this.entered_by_session.delete(client.sessionId);
        this.ready_by_session.delete(client.sessionId);
        this.replay_by_session.delete(client.sessionId);
        this.bot_timeout_by_session.get(client.sessionId)?.clear();
        this.bot_timeout_by_session.delete(client.sessionId);
        this.reconnection_by_session.delete(client.sessionId);

        if (left_user) {
            // 로비가 더 이상 이 방으로 재접속을 안내하면 안 되므로 지운다
            activeGame.RemoveActiveGame(left_user.userid).catch((error) => {
                console.error(`[SteppingGameRoom] RemoveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            // 게임방을 떠날 때도 로비와 같은 규칙 — 값을 새로 쓰지 않고 TTL 만 갱신
            userCache.GetUserCache(left_user.userid)
                .then((cached) => (cached ? userCache.TouchUserCache(cached) : undefined))
                .catch((error) => {
                    console.error(`[SteppingGameRoom] TouchUserCache 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
                });
        }

        if (this.waiting_room_entry && client.sessionId === this.waiting_session) {
            // 새 상대를 기다리던 그 유저가 나갔다 — Redis "기다리는 방" 목록에서도 지운다.
            // (sessionId 로 구분해야 한다 — 다른 클라이언트의 onLeave 가 뒤늦게 들어오는 경합 방지)
            waitingRooms.RemoveWaitingRoom(GAME_TYPE, this.waiting_room_entry).catch((error) => {
                console.error(`[SteppingGameRoom] RemoveWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            this.waiting_room_entry = null;
            this.waiting_session = null;
        }

        // 남은 상대에게 알린다. 게임 중 퇴장은 게임이 끝난 뒤 FlushAbandonedPlayers() 가 보낸다.
        if (left_user && !abandoned_mid_game) {
            const payload: OutUserPayload = { userid: left_user.userid };
            for (const remaining_client of this.clients) {
                messages.SendMessage(this, remaining_client, types.MessageType.OUT_USER, payload);
            }
        }

        if (abandoned_mid_game) {
            this.OnPlayerAbandonedMidGame(client.sessionId);
            return;
        }

        // 재게임 응답 대기 중에 상대가 나갔고 남은 유저가 이미 응답했다면 타임아웃을 기다리지 않고 마무리
        if (this.game_over && this.replay_timeout) {
            const remaining_sessions = [...this.players.keys()];
            const all_remaining_responded = remaining_sessions.every((sessionId) => this.replay_by_session.has(sessionId));
            if (remaining_sessions.length > 0 && all_remaining_responded) {
                this.ResolveReplay();
            }
        }
    }

    public onDispose(): void {
        roomRegistry.UnregisterRoom(this);
        console.log(`[SteppingGameRoom] 제거됨 roomId=${this.roomId}`);
    }

    // ADMIN_CHANNEL_USER 용 — 지금 이 방에 있는 유저. 게임 중 나간(좌석만 남은) 유저는 제외한다.
    public GetChannelUserEntries(): AdminChannelUserEntry[] {
        return [...this.players.entries()]
            .filter(([sessionId]) => !this.abandoned_sessions.has(sessionId))
            .map(([, user]) => ({ userid: user.userid, room: this.roomId }));
    }

    // 무중단 재시작 드레인용 — 지금 실제로 게임이 진행 중인지
    public IsGameInProgress(): boolean {
        return this.game_started && !this.game_over;
    }

    private SaveMyActiveGameRecord(client: Client, userid: string): void {
        const entry: ActiveGameEntry = {
            room_name: this.roomName,
            room_id: this.roomId,
            reconnection_token: client.reconnectionToken,
        };
        activeGame.SaveActiveGame(userid, entry).catch((error) => {
            console.error(`[SteppingGameRoom] SaveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }

    private CheckSeatFillTimeout(): void {
        // ⚠️ 이 가드를 빼면 안 된다 — 게임 중 누군가 재접속 유예 중이면 clients.length 가 잠깐 1이라
        // "처음부터 한 명만 온 방"으로 오인해 양쪽을 통째로 끊어버린다(RpsGameRoom 에서 실제로 겪은 버그).
        if (this.game_started) {
            return;
        }
        if (this.clients.length === constants.PLAYERS_PER_ROOM) {
            return; // 정상 — 2명 다 들어옴
        }

        if (this.clients.length === 1) {
            messages.SendMessage(this, this.clients[0], types.MessageType.RETURN_TO_LOBBY, {});
        }

        this.disconnect(CloseCode.WITH_ERROR);
    }

    // ENTER_ROOM (C→S) — 클라이언트가 로딩 등 준비를 마치면 보낸다. 두 명 다 보내면 방/상대 정보를 응답한다.
    // ⚠️ 이미 응답을 보낸 뒤에도 요청한 클라이언트에게만 다시 보낸다 — 재접속한 클라이언트는 onJoin 을
    // 다시 안 타서 상대 정보를 되찾을 방법이 이것뿐이다. 게임 중이면 GAME_STATUS 도 함께 보낸다.
    private HandleEnterRoom(client: Client): void {
        this.entered_by_session.add(client.sessionId);

        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        if (this.enter_room_sent) {
            this.SendEnterRoomTo(client);
            this.SendGameStatusTo(client);
            return;
        }

        const all_entered = [...this.players.keys()].every((sessionId) => this.entered_by_session.has(sessionId));
        if (!all_entered) return;

        this.enter_room_sent = true;
        for (const room_client of this.clients) {
            this.SendEnterRoomTo(room_client);
        }
    }

    private SendEnterRoomTo(client: Client): void {
        const [user_a, user_b] = [...this.players.values()];
        const payload: EnterRoomPayload = {
            result: "Y",
            room: this.roomId,
            player1: ToRoomPlayerInfo(user_a),
            player2: ToRoomPlayerInfo(user_b),
        };
        messages.SendMessage(this, client, types.MessageType.ENTER_ROOM, payload);
    }

    // GAME_STATUS (S→C) — 지금 상태를 **이 클라이언트에게만** 보낸다(재접속 복원용).
    // 시트의 GAME_STATUS 행은 오델로 것이 복사돼 있어서 점핑용 모양으로 새로 정했다(steppingTypes.ts 참고).
    // 게임 전/후에는 복원할 상태가 없으므로 보내지 않는다.
    private SendGameStatusTo(client: Client): void {
        if (!this.IsGameInProgress() || this.map === null) return;

        const [session_a, session_b] = [...this.players.keys()];
        const status_a = this.ToPlayerStatus(session_a);
        const status_b = this.ToPlayerStatus(session_b);
        if (!status_a || !status_b) return;

        const payload: SteppingGameStatusPayload = {
            map: this.map,
            // GAME_START 전(맵 연출 2초)이면 남은 초가 아직 없다 — 곧 오는 GAME_START 로 따라잡는다
            ...(this.play_started ? { count: this.remain_sec } : {}),
            player1: status_a,
            player2: status_b,
        };
        messages.SendMessage(this, client, types.MessageType.GAME_STATUS, payload);
    }

    private ToPlayerStatus(session_id: string | undefined): SteppingPlayerStatus | undefined {
        if (session_id === undefined) return undefined;
        const user = this.players.get(session_id);
        const state = this.state_by_session.get(session_id);
        if (!user || !state) return undefined;
        return { userid: user.userid, count: state.count, life: state.life, location: { ...state.location } };
    }

    private HandleReady(client: Client, message: ReadyPayload): void {
        if (message?.ready !== "Y" && message?.ready !== "N") {
            return; // 형식이 잘못된 요청은 무시한다 (문서에 실패 응답이 없음)
        }

        this.ready_by_session.set(client.sessionId, message.ready === "Y");

        if (this.game_started) return;
        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        const all_ready = [...this.players.keys()].every((sessionId) => this.ready_by_session.get(sessionId) === true);
        if (!all_ready) return;

        this.StartGame();
    }

    // MAP_SELECT 를 보내고 2초 뒤 GAME_START 를 예약한다. 최초 시작(HandleReady)과 같은 상대와의
    // 재게임(ResolveReplay) 둘 다 여기를 쓴다 — 재게임은 READY 를 다시 받지 않는다.
    // 시트: "양쪽 유저에게 ready:Y 를 받으면 맵을 정해 준다. 양쪽 유저 모두 동일한 맵을 사용 한다. 1~3"
    private StartGame(): void {
        this.game_started = true;
        this.game_over = false;
        this.game_started_at = new Date();
        this.plays.length = 0;
        this.play_started = false;
        this.remain_sec = steppingConstants.STEPPING_GAME_TIME_SEC;
        this.map = steppingRules.PickRandomMap();
        this.state_by_session.clear();
        for (const sessionId of this.players.keys()) {
            this.state_by_session.set(sessionId, steppingRules.CreatePlayerState());
        }

        const payload: SteppingMapSelectPayload = { map: this.map };
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.MAP_SELECT, payload);
        }

        // 시트: "MAP_SEELCT 전송 후 2초 대기 한 뒤 게임 시작 알림"
        this.start_timeout = this.clock.setTimeout(() => this.StartPlay(), steppingConstants.STEPPING_MAP_SELECT_DELAY_SEC * 1000);
    }

    // GAME_START 를 보내고 제한 시간(STEPPING_GAME_TIME_SEC, 60초) 카운트다운을 시작한다. 이때부터 MOVE_INFO 를 받는다.
    private StartPlay(): void {
        this.start_timeout = null;
        if (this.game_over || this.players.size < constants.PLAYERS_PER_ROOM) return;

        this.play_started = true;
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.GAME_START, {});
        }

        // 시트: "GAME_START 이후 남은 초를 1초 단위로 클라에 전달. 총 게임 시간은 20초" → 사용자 결정으로 60초(2026-10-14)
        this.remain_sec = steppingConstants.STEPPING_GAME_TIME_SEC;
        this.remain_time_interval = this.clock.setInterval(() => {
            this.remain_sec -= 1;
            const remain_payload: SteppingRemainTimePayload = { count: this.remain_sec };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.GAME_REMAIN_TIME, remain_payload);
            }

            if (this.remain_sec <= 0) {
                console.log(`[SteppingGameRoom] 제한 시간 종료 roomId=${this.roomId}`);
                this.RequestFinish();
            }
        }, 1000);
    }

    // MOVE_INFO (C→S) — 점프 한 번의 결과. 검사를 통과하면 반영하고 **양쪽 모두에게** 중계한다.
    // 검사에 걸리면(순번/간격/형식/이미 끝남) 조용히 무시하고 로그만 남긴다 — 응답 코드가 시트에 없다.
    private HandleMoveInfo(client: Client, message: SteppingMoveInfoPayload): void {
        if (!this.play_started || this.game_over || this.map === null) return;

        const state = this.state_by_session.get(client.sessionId);
        const user = this.players.get(client.sessionId);
        if (!state || !user) return;

        const block_count = steppingRules.GetMapBlockCount(this.map);
        const now_ms = Date.now();
        const reject_reason = steppingRules.ValidateMove(state, message, block_count, now_ms);
        if (reject_reason !== null) {
            console.warn(
                `[SteppingGameRoom] MOVE_INFO 무시 roomId=${this.roomId} userid=${user.userid} reason=${reject_reason} ` +
                    `expected=${state.count + 1} got=${String((message as { count?: unknown } | null)?.count)}`
            );
            return;
        }

        steppingRules.ApplyMove(state, message, block_count, now_ms);
        this.plays.push({ userid: user.userid, count: message.count, x: message.location.x, y: message.location.y, save: message.save });

        const payload: SteppingMoveInfoResultPayload = {
            userid: user.userid,
            count: message.count,
            location: { x: message.location.x, y: message.location.y },
            save: message.save,
            life: state.life,
        };
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.MOVE_INFO, payload);
        }

        // 종료 조건: 라이프를 다 쓴 뒤 또 추락(탈락) / 양쪽 모두 모든 칸 이동 완료
        if (steppingRules.IsGameOverByState([...this.state_by_session.values()])) {
            console.log(`[SteppingGameRoom] 종료 조건 충족 roomId=${this.roomId} eliminated=${state.eliminated} completed=${state.completed}`);
            this.RequestFinish();
        }
    }

    // 종료 조건이 되면 MOVE_INFO 와 카운트다운을 멈추고, STEPPING_RESULT_DELAY_SEC(3초) 뒤에 GAME_RESULT 를
    // 보낸다 — 마지막 추락/착지 모션을 클라이언트가 보여 줄 시간이다 (사용자 요청 2026-10-14).
    // ⚠️ 기다리는 동안은 game_over=false(아직 진행 중)로 둔다. 그 사이 나간 유저도 게임 중 퇴장 규칙
    //    (좌석 유지 → GAME_RESULT 직후 OUT_USER, is_bot 기록)을 그대로 따르게 하기 위해서다.
    //    game_over 를 먼저 켜면 onLeave 가 "게임 후 퇴장"으로 보고 좌석을 비워 FinishGame 이 결과를 못 만든다.
    // 결과를 볼 클라이언트가 없으면 기다리지 않는다.
    private RequestFinish(): void {
        if (this.game_over || this.finish_timeout) return; // 종료 조건이 겹쳐도(마지막 MOVE_INFO 와 0초) 한 번만
        this.play_started = false; // 이 순간부터 MOVE_INFO 를 받지 않는다 (결과가 바뀌면 안 된다)
        this.ClearPlayTimers();

        if (this.clients.length === 0) {
            void this.FinishGame();
            return;
        }
        this.finish_timeout = this.clock.setTimeout(() => {
            this.finish_timeout = null;
            void this.FinishGame();
        }, steppingConstants.STEPPING_RESULT_DELAY_SEC * 1000);
    }

    // 게임 중 한 명이 최종 퇴장했을 때.
    private OnPlayerAbandonedMidGame(session_id: string): void {
        console.log(`[SteppingGameRoom] 게임 중 퇴장 → 기록 고정 roomId=${this.roomId} sessionId=${session_id}`);

        // 둘 다 나가 버렸으면 결과를 볼 사람이 아무도 없다 — 남은 시간을 기다리지 않고 지금 기록으로 끝낸다.
        // 결과 연출 대기(finish_timeout) 중이었어도 바로 끝낸다(FinishGame → ClearPlayTimers 가 그 타이머를 지운다).
        // ⚠️ 판정은 오델로와 같다: clients 가 0 이고 **재접속 대기 중인 세션도 없어야** 한다.
        if (this.clients.length === 0 && this.reconnection_by_session.size === 0) {
            console.log(`[SteppingGameRoom] 남은 유저 없음 → 현재 기록으로 종료 roomId=${this.roomId}`);
            void this.FinishGame();
        }
        // 한 명이 남아 있으면 아무것도 하지 않는다 — 남은 유저는 시간이 끝나거나 종료 조건이 될 때까지
        // 계속 뛴다. 나간 유저의 칸 수/라이프는 그대로 결과에 쓰인다.
    }

    private ClearPlayTimers(): void {
        this.start_timeout?.clear();
        this.start_timeout = null;
        this.remain_time_interval?.clear();
        this.remain_time_interval = null;
    }

    // 플레이 타이머 + 결과 연출 대기 타이머까지 모두 멈춘다 (FinishGame / ResetGameState 용).
    // ⚠️ RequestFinish 는 ClearPlayTimers 만 부른다 — 여기서 finish_timeout 까지 지우면 방금 건 대기가 사라진다.
    private ClearAllTimers(): void {
        this.ClearPlayTimers();
        this.finish_timeout?.clear();
        this.finish_timeout = null;
    }

    // --- 게임 종료 ---

    // 게임 점수(라이프×10 + 칸×5)가 높은 쪽 승리, 같으면 먼저 도착한 쪽 승리(steppingRules.DecideWinner).
    // 게임 중 나간 유저도 **그대로 참가자로 집계한다** — 결과는 그 유저의 승패/통계/랭킹에도 반영된다.
    private async FinishGame(): Promise<void> {
        if (this.game_over) return; // 종료 조건이 겹쳐도(마지막 MOVE_INFO 와 0초) 한 번만
        this.game_over = true;
        this.play_started = false;
        this.ClearAllTimers();

        const sessions = [...this.players.keys()];

        // 재접속 창을 닫는다 — 재접속은 "게임이 끝날 때까지"만 유효하다.
        // 안 닫으면 "manual" 모드라 그 좌석이 영원히 예약된 채로 남아 방이 정리되지 않는다.
        for (const sessionId of sessions) {
            this.reconnection_by_session.get(sessionId)?.reject();
        }

        const [session_a, session_b] = sessions;
        const state_a = session_a !== undefined ? this.state_by_session.get(session_a) : undefined;
        const state_b = session_b !== undefined ? this.state_by_session.get(session_b) : undefined;
        const user_a = session_a !== undefined ? this.players.get(session_a) : undefined;
        const user_b = session_b !== undefined ? this.players.get(session_b) : undefined;
        if (!state_a || !state_b || !user_a || !user_b || session_a === undefined || session_b === undefined) {
            // 좌석 정보가 비어 결과를 만들 수 없다 — 게임 중 퇴장은 좌석을 비우지 않으므로 정상 흐름에서는
            // 여기 오지 않는다. 재게임 선택만 받고 끝낸다.
            console.error(`[SteppingGameRoom] 게임 종료 시 플레이어 정보 없음 roomId=${this.roomId}`);
            this.FlushAbandonedPlayers();
            this.StartReplayWait();
            return;
        }

        const judge = steppingRules.DecideWinner(state_a, state_b);
        const is_draw = judge === 0;
        // 무승부면 winner/loser 자리에 입장 순서대로 담는다 (오델로와 같은 관례)
        const winner_session = judge === -1 ? session_b : session_a;
        const loser_session = winner_session === session_a ? session_b : session_a;
        const winner_user = winner_session === session_a ? user_a : user_b;
        const loser_user = winner_session === session_a ? user_b : user_a;
        const winner_state = winner_session === session_a ? state_a : state_b;
        const loser_state = winner_session === session_a ? state_b : state_a;
        const winner_game_score = steppingRules.ComputeScore(winner_state);
        const loser_game_score = steppingRules.ComputeScore(loser_state);

        const winner_is_bot = this.bot_sessions.has(winner_session);
        const loser_is_bot = this.bot_sessions.has(loser_session);

        // win_per 은 이번 게임 결과가 반영된 값이다 — DB 저장 완료를 기다리지 않고 메모리 값에 즉시 더한다.
        const winner_info: SteppingGameResultPlayerInfo = {
            userid: winner_user.userid,
            win_count: winner_state.count,
            win_per: ComputeWinPer(winner_user.total_win_count + (is_draw ? 0 : 1), winner_user.total_game_count + 1),
            score: winner_game_score,
            life: winner_state.life,
        };
        const loser_info: SteppingGameResultPlayerInfo = {
            userid: loser_user.userid,
            win_count: loser_state.count,
            win_per: ComputeWinPer(loser_user.total_win_count, loser_user.total_game_count + 1),
            score: loser_game_score,
            life: loser_state.life,
        };
        const payload: SteppingGameResultPayload = {
            winner: winner_info,
            loser: loser_info,
            ...(is_draw ? { draw: "Y" as const } : {}),
        };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.GAME_RESULT, payload);
        }

        // 게임 중 나간 유저가 있으면 **이제** 남은 유저에게 알린다. GAME_RESULT 를 먼저 보내야 한다.
        this.FlushAbandonedPlayers();

        this.StartReplayWait();

        const map = this.map ?? 0;
        try {
            const result = await steppingGameResultRepository.SaveSteppingGameResult({
                winner_userid: winner_user.userid,
                loser_userid: loser_user.userid,
                map,
                winner_game_score,
                loser_game_score,
                is_draw,
                start_time: this.game_started_at ?? new Date(),
                end_time: new Date(),
                // ⚠️ 스냅샷(복사본)을 넘긴다 — 저장이 끝나기 전에 재게임으로 StartGame() 이 다시 불리면
                // this.plays 가 즉시 비워진다(RpsGameRoom 에서 실제로 겪은 버그).
                plays: [...this.plays],
                win_is_bot: winner_is_bot,
                lose_is_bot: loser_is_bot,
            });
            // 게임방 메모리의 플레이어 정보도 최신 값으로 갱신 — 재게임할 때 win_per 에 반영되도록.
            if (this.players.has(winner_session)) this.players.set(winner_session, result.winner);
            if (this.players.has(loser_session)) this.players.set(loser_session, result.loser);
        } catch (error) {
            console.error(`[SteppingGameRoom] 게임 결과 저장 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        }
    }

    // 게임 중 나가서 재입장하지 않은 유저들을 좌석에서 치우고, 남은 유저에게 OUT_USER 로 알린다.
    // ⚠️ **GAME_RESULT 를 보낸 뒤에** 호출해야 한다 — 먼저 치우면 결과 payload 에 담을 정보가 없다.
    // ⚠️ bot_sessions 도 여기서 비우므로, DB 에 넘길 win_is_bot/lose_is_bot 은 이 호출 전에 읽어야 한다.
    private FlushAbandonedPlayers(): void {
        if (this.abandoned_sessions.size === 0) return;

        for (const sessionId of this.abandoned_sessions) {
            const user = this.players.get(sessionId);
            this.players.delete(sessionId);
            this.state_by_session.delete(sessionId);
            this.bot_sessions.delete(sessionId);
            if (!user) continue;

            const payload: OutUserPayload = { userid: user.userid };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.OUT_USER, payload);
            }
        }
        this.abandoned_sessions.clear();
    }

    // 재게임/나가기 선택을 기다린다 (DB 저장을 기다리지 않고 먼저 시작한다)
    private StartReplayWait(): void {
        this.replay_by_session.clear();
        this.replay_timeout = this.clock.setTimeout(
            () => this.ResolveReplay(),
            steppingConstants.STEPPING_REMATCH_CHOICE_TIMEOUT_SEC * 1000
        );
    }

    // GAME_RESULT (C→S) — 재게임 여부 응답. replay:"N" 은 상대 응답을 기다리지 않고 이 유저만 바로 내보낸다.
    private HandleReplay(client: Client, message: SteppingReplayPayload): void {
        if (!this.game_over) return;
        if (message?.replay !== "Y" && message?.replay !== "N") return;
        if (this.replay_by_session.has(client.sessionId)) return; // 이미 응답함

        this.replay_by_session.set(client.sessionId, message.replay === "Y");

        if (message.replay === "N") {
            this.KickToLobby(client);
        }

        const all_responded = [...this.players.keys()].every((sessionId) => this.replay_by_session.has(sessionId));
        if (all_responded) {
            this.ResolveReplay();
        }
    }

    // RETURN_TO_LOBBY 를 보내고 연결을 끊는다. 같은 세션에 두 번 호출돼도 안전하다.
    private KickToLobby(client: Client): void {
        if (this.kicked_to_lobby.has(client.sessionId)) return;
        this.kicked_to_lobby.add(client.sessionId);
        messages.SendMessage(this, client, types.MessageType.RETURN_TO_LOBBY, {});
        client.leave(CloseCode.CONSENTED);
    }

    private ResolveReplay(): void {
        if (!this.game_over) return; // 이미 처리됨 (타임아웃과 응답 완료가 겹친 경우)
        this.replay_timeout?.clear();
        this.replay_timeout = null;

        const sessions = [...this.players.keys()];
        const replaying_sessions = sessions.filter((sessionId) => this.replay_by_session.get(sessionId) === true);
        const leaving_sessions = sessions.filter((sessionId) => !replaying_sessions.includes(sessionId));

        for (const sessionId of leaving_sessions) {
            const client = this.clients.find((c) => c.sessionId === sessionId);
            if (client) this.KickToLobby(client);
        }

        if (replaying_sessions.length === constants.PLAYERS_PER_ROOM) {
            // 둘 다 재게임 — 같은 방, 같은 상대로 새 게임 시작 (MAP_SELECT 부터, READY 는 다시 안 받음)
            this.ResetGameState();
            this.StartGame();
        } else if (replaying_sessions.length === 1) {
            this.WaitForNewOpponent(replaying_sessions[0]);
        }
        // 0 이면 남은 유저도 위 루프로 이미 정리됐다 — 방은 비면서 자동 정리(dispose)됨
    }

    // 한 게임 상태를 초기화한다 (같은 상대와의 재게임, 새 상대와의 재매칭 둘 다에서 쓴다)
    private ResetGameState(): void {
        this.map = null;
        this.play_started = false;
        this.state_by_session.clear();
        this.ClearAllTimers();
        // 평소엔 FlushAbandonedPlayers() 가 게임 종료 때 이미 비웠다 — 안전장치다.
        this.abandoned_sessions.clear();
        this.game_over = false;
        this.replay_by_session.clear();
        this.replay_timeout?.clear();
        this.replay_timeout = null;
        this.kicked_to_lobby.clear();
    }

    // 재게임을 신청했는데 상대가 나가서 혼자 남았을 때 — "기다리는 방"으로 등록하고 새 상대를 기다린다.
    // 대기 시간에는 제한이 없다. 새 상대는 onJoin 에서 OPPONENT_JOINED 로 알린다.
    private WaitForNewOpponent(remaining_session: string): void {
        const remaining_user = this.players.get(remaining_session);
        if (!remaining_user) return; // 그 사이 이 유저도 나갔다면 더 할 게 없다

        // 새 상대와는 ENTER_ROOM 부터 다시 진행한다
        this.ResetGameState();
        this.entered_by_session.clear();
        this.enter_room_sent = false;
        this.ready_by_session.clear();
        this.game_started = false;

        const entry: WaitingRoomEntry = {
            channel_no: channelNames.ParseChannelNo(this.roomName),
            room_name: this.roomName,
            room_id: this.roomId,
            opponent: { name: remaining_user.name, avatar: remaining_user.avatar },
        };
        this.waiting_room_entry = entry;
        this.waiting_session = remaining_session;
        waitingRooms.PushWaitingRoom(GAME_TYPE, entry).catch((error) => {
            console.error(`[SteppingGameRoom] PushWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }
}
