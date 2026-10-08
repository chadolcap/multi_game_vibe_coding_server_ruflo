// 오델로 게임이 진행되는 모듈 (2인, 2026-10-07 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `othello` 시트가 기준이다.
//
// 구조는 RpsGameRoom 과 의도적으로 같다 — 플랫폼 공통 부분(좌석 채우기/ENTER_ROOM/READY/재접속·봇/
// 재게임·기다리는 방/activeGame/roomRegistry)은 거의 그대로 가져왔고, 게임 전용 부분만 다르다:
//   RPS: GAME_START → (5초) → ONE_START → 선택 → ONE_RESULT → … → 2선승이면 GAME_RESULT
//   오델로: GAME_START → (5초) → 돌 색 선택(DOLL_SELECT) → (5초) → TURN_START/SELECT_GAME 턴 루프
//           → 양쪽 모두 놓을 곳 없으면 GAME_RESULT (돌 개수로 승패, 동수면 draw)
//
// 턴 루프의 핵심은 AdvanceTurn() 이다 — "다음에 둘 사람"을 정하면서 패스와 종료를 함께 판정한다.

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
import * as othelloConstants from "./othelloConstants.js";
import * as othelloRules from "./othelloRules.js";
import type {
    OthelloBoard,
    OthelloColor,
    OthelloDollSelectPayload,
    OthelloDollSelectResultPayload,
    OthelloGameResultPayload,
    OthelloGameStatusPayload,
    OthelloPlayRecord,
    OthelloRemainTimePayload,
    OthelloReplayPayload,
    OthelloSelectGamePayload,
    OthelloSelectGameResultPayload,
    OthelloTurnStartPayload,
} from "./othelloTypes.js";
import { OTHELLO_BLACK, OTHELLO_WHITE } from "./othelloTypes.js";
import * as othelloGameResultRepository from "../../db/othelloGameResultRepository.js";
import * as userCache from "../../db/userCache.js";
import * as activeGame from "../room/activeGame.js";
import * as waitingRooms from "../room/waitingRooms.js";
import type { ActiveGameEntry, WaitingRoomEntry } from "../room/types.js";

const GAME_TYPE = "othello" as const;

// 승률(0~100 정수). 한 판도 안 한 유저는 0. rpsRules.ComputeWinPer 과 같은 계산이지만, 게임 전용
// 모듈끼리 서로 import 하지 않도록(게임별 분리 원칙) 각자 둔다.
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

export class OthelloGameRoom extends Room {
    maxClients = constants.PLAYERS_PER_ROOM;

    // --- 플랫폼 공통 상태 (RpsGameRoom 과 같은 의미) ---

    // sessionId → 좌석 예약에 담겨 온 유저 정보. Map 은 입력 순서를 유지하므로 player1/player2 순서
    // (먼저 입장한 쪽이 player1)를 그대로 이 순서에서 가져온다.
    private readonly players = new Map<string, UserInfo>();
    private readonly entered_by_session = new Set<string>();
    private enter_room_sent = false;
    private readonly ready_by_session = new Map<string, boolean>();
    private game_started = false;
    private game_over = false;
    private game_started_at: Date | null = null;

    private readonly replay_by_session = new Map<string, boolean>();
    private replay_timeout: Delayed | null = null;
    private readonly kicked_to_lobby = new Set<string>();
    private waiting_room_entry: WaitingRoomEntry | null = null;
    private waiting_session: string | null = null;

    private readonly bot_timeout_by_session = new Map<string, Delayed>();
    private readonly bot_sessions = new Set<string>();
    private readonly reconnection_by_session = new Map<string, Deferred<Client>>();

    // --- 오델로 전용 상태 ---

    private board: OthelloBoard = othelloRules.CreateInitialBoard();
    // sessionId → 그 유저가 고른 돌 색. 돌 선택 단계가 끝나면 두 세션 모두 채워진다.
    private readonly color_by_session = new Map<string, OthelloColor>();
    private doll_select_done = false;
    // 돌 선택 / 턴 제한 시간을 1초 단위로 알리는 인터벌. 둘 중 하나만 동시에 돈다.
    private remain_time_interval: Delayed | null = null;
    // 지금 둘 차례인 세션. 턴 루프가 돌지 않을 때는 null.
    private turn_session: string | null = null;
    private turn_active = false;
    // 이번 게임의 수순 — DB 로그(othello_game_log.plays)에 쓴다. StartGame 마다 비운다.
    private readonly plays: OthelloPlayRecord[] = [];

    public onCreate(): void {
        // 이름/roomId 로 직접 들어올 수 없게 잠근다 — 예약된 좌석으로만 입장 가능
        this.lock();
        console.log(`[OthelloGameRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

        // SEND_NOTICE 브로드캐스트 + 채널 유저 리포터(Watcher 의 ADMIN_CHANNEL_USER 용) + 무중단 재시작
        // 드레인(index.ts, 이 채널에 진행 중인 게임이 남아 있는지 확인)이 이 방을 찾을 수 있도록 등록
        roomRegistry.RegisterRoom(this, () => this.GetChannelUserEntries(), () => this.IsGameInProgress());

        // 좌석 예약 후 SEAT_RESERVATION_SEC 안에 2명이 다 안 모이면 정리한다
        this.clock.setTimeout(() => this.CheckSeatFillTimeout(), constants.SEAT_RESERVATION_SEC * 1000);

        log.RegisterLoggedMessage(this, types.MessageType.ENTER_ROOM, (client) => {
            this.HandleEnterRoom(client);
        });
        log.RegisterLoggedMessage<ReadyPayload>(this, types.MessageType.READY, (client, message) => {
            this.HandleReady(client, message);
        });
        log.RegisterLoggedMessage<OthelloDollSelectPayload>(this, types.MessageType.DOLL_SELECT, (client, message) => {
            this.HandleDollSelect(client, message);
        });
        log.RegisterLoggedMessage<OthelloSelectGamePayload>(this, types.MessageType.SELECT_GAME, (client, message) => {
            this.HandleSelectGame(client, message);
        });
        log.RegisterLoggedMessage<OthelloReplayPayload>(this, types.MessageType.GAME_RESULT, (client, message) => {
            this.HandleReplay(client, message);
        });
    }

    public onJoin(client: Client, _options: unknown, auth?: GameSeatAuth): void {
        if (!auth?.user) {
            // 정상 흐름이라면 항상 GameRoomMatcher 가 좌석 예약에 유저 정보를 담아 보낸다.
            console.error(`[OthelloGameRoom] auth.user 없이 입장 시도 sessionId=${client.sessionId}`);
            client.leave(CloseCode.WITH_ERROR);
            return;
        }

        this.players.set(client.sessionId, auth.user);
        log.LogConnect(this, client, { userid: auth.user.userid });
        this.SaveMyActiveGameRecord(client, auth.user.userid);

        if (this.waiting_room_entry) {
            // 혼자 남아 새 상대를 기다리던 방에 방금 새 유저가 들어옴 — 기존 유저에게 알린다.
            // Redis "기다리는 방" 목록에서는 로비가 TryJoinWaitingRoom 에서 이미 Pop 해 갔으므로
            // 여기서는 우리 쪽 표시만 지운다.
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
    // Colyseus 가 곧바로 onLeave() 를 불러 지금까지와 같은 방식으로 정리한다.
    public onDrop(client: Client, _code?: number): void {
        if (!this.game_started || this.game_over) {
            return;
        }

        const sessionId = client.sessionId;
        console.log(`[OthelloGameRoom] 연결 끊김, 재접속 대기 roomId=${this.roomId} sessionId=${sessionId}`);

        this.bot_timeout_by_session.set(
            sessionId,
            this.clock.setTimeout(() => {
                this.bot_sessions.add(sessionId);
                console.log(`[OthelloGameRoom] 봇 투입 roomId=${this.roomId} sessionId=${sessionId}`);
            }, constants.RECONNECT_WAIT_SEC * 1000)
        );

        // "manual" — 시간 제한은 우리가 직접 관리한다. 재접속 자체는 게임이 끝날 때까지 받는다
        // (FinishGame 에서 강제로 닫는다).
        this.reconnection_by_session.set(sessionId, this.allowReconnection(client, "manual"));
    }

    public onReconnect(client: Client): void {
        const sessionId = client.sessionId;
        this.bot_timeout_by_session.get(sessionId)?.clear();
        this.bot_timeout_by_session.delete(sessionId);
        this.bot_sessions.delete(sessionId);
        this.reconnection_by_session.delete(sessionId);
        console.log(`[OthelloGameRoom] 재접속 roomId=${this.roomId} sessionId=${sessionId}`);

        // reconnectionToken 은 (재)입장마다 새로 발급되므로 다시 저장해 둔다 (F5 재접속 대비)
        const user = this.players.get(sessionId);
        if (user) this.SaveMyActiveGameRecord(client, user.userid);
    }

    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        const left_user = this.players.get(client.sessionId);
        this.players.delete(client.sessionId);
        this.entered_by_session.delete(client.sessionId);
        this.ready_by_session.delete(client.sessionId);
        this.color_by_session.delete(client.sessionId);
        // 클라이언트가 명시적으로 나가기를 요청하면 onDrop 을 거치지 않고 곧장 여기로 온다 —
        // 그 경우를 위해 진행 중인 타이머를 멈춘다.
        this.turn_active = false;
        this.remain_time_interval?.clear();
        this.remain_time_interval = null;
        this.replay_by_session.delete(client.sessionId);
        this.bot_timeout_by_session.get(client.sessionId)?.clear();
        this.bot_timeout_by_session.delete(client.sessionId);
        this.bot_sessions.delete(client.sessionId);
        this.reconnection_by_session.delete(client.sessionId);

        if (left_user) {
            // 로비가 더 이상 이 방으로 재접속을 안내하면 안 되므로 지운다
            activeGame.RemoveActiveGame(left_user.userid).catch((error) => {
                console.error(`[OthelloGameRoom] RemoveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            // 게임방을 떠날 때도 로비와 같은 규칙(CLAUDE.md 흐름 13번) — 값을 새로 쓰지 않고 TTL 만 갱신
            userCache.GetUserCache(left_user.userid)
                .then((cached) => (cached ? userCache.TouchUserCache(cached) : undefined))
                .catch((error) => {
                    console.error(`[OthelloGameRoom] TouchUserCache 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
                });
        }

        if (this.waiting_room_entry && client.sessionId === this.waiting_session) {
            // 새 상대를 기다리던 그 유저가 나갔다 — Redis "기다리는 방" 목록에서도 지운다.
            // (sessionId 로 구분해야 한다 — 다른 클라이언트의 onLeave 가 비동기로 뒤늦게 들어와
            //  방금 등록한 대기열 항목을 지워 버리는 경합을 막는다)
            waitingRooms.RemoveWaitingRoom(GAME_TYPE, this.waiting_room_entry).catch((error) => {
                console.error(`[OthelloGameRoom] RemoveWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            this.waiting_room_entry = null;
            this.waiting_session = null;
        }

        // 남은 상대에게 알린다 (this.clients 에서는 이미 제거된 상태)
        if (left_user) {
            const payload: OutUserPayload = { userid: left_user.userid };
            for (const remaining_client of this.clients) {
                messages.SendMessage(this, remaining_client, types.MessageType.OUT_USER, payload);
            }
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
        console.log(`[OthelloGameRoom] 제거됨 roomId=${this.roomId}`);
    }

    // ADMIN_CHANNEL_USER 용 — 지금 이 방에 있는 유저의 userid + roomId
    public GetChannelUserEntries(): AdminChannelUserEntry[] {
        return [...this.players.values()].map((user) => ({ userid: user.userid, room: this.roomId }));
    }

    // 무중단 재시작 드레인용 — 지금 실제로 게임이 진행 중인지
    // (좌석 채우기/재게임 상대 기다리는 중/게임 종료 후 선택 대기 중은 포함하지 않는다)
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
            console.error(`[OthelloGameRoom] SaveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }

    private CheckSeatFillTimeout(): void {
        // ⚠️ 이 가드를 빼면 안 된다. 게임이 시작된 뒤 우연히 이 타이머가 도는 시점(방 생성 10초 뒤)에
        // 누군가 재접속 유예 중이면 this.clients.length 가 잠깐 1이라, "처음부터 한 명만 온 방"으로
        // 오인해 양쪽을 통째로 끊어버린다 — RpsGameRoom 에서 실제로 겪은 버그다.
        // 게임이 시작됐다는 건 두 좌석이 한 번은 다 찼었다는 뜻이라 이 타이머는 그 뒤로 의미가 없다.
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
    // ⚠️ 이미 응답을 보낸 뒤에도 요청한 클라이언트에게만 다시 보낸다 — 재접속(REJOIN_GAME →
    // client.reconnect())한 클라이언트는 onJoin 을 다시 안 타서 상대 정보를 되찾을 방법이 이것뿐이다.
    private HandleEnterRoom(client: Client): void {
        this.entered_by_session.add(client.sessionId);

        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        if (this.enter_room_sent) {
            this.SendEnterRoomTo(client);
            // 게임이 진행 중인데 ENTER_ROOM 을 다시 보냈다는 건 **재접속**이라는 뜻이다 — 그동안의
            // DOLL_SELECT/SELECT_GAME 을 놓쳤으므로 보드 상태를 한 번에 복원해 준다(시트 othello 19행,
            // "재접속 당사자에게만 전달"). 새 게임의 최초 ENTER_ROOM 흐름에서는 이 시점에 아직
            // game_started 가 false 라 여기 걸리지 않는다.
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

    // GAME_STATUS (S→C) — 지금 보드 상태를 **이 클라이언트에게만** 보낸다 (시트 othello 19행).
    // 게임이 실제로 진행 중이고 돌 색이 배정된 뒤에만 의미가 있다:
    //   · 게임 전/후(game_started=false 또는 game_over)는 복원할 보드가 없다
    //   · 돌 선택 단계 중(doll_select_done=false)에는 select 를 채울 수 없다
    // 그 경우는 조용히 넘어간다 — 클라이언트는 평소 흐름(DOLL_SELECT/TURN_START)으로 따라잡는다.
    private SendGameStatusTo(client: Client): void {
        if (!this.IsGameInProgress() || !this.doll_select_done) return;

        // select 는 DOLL_SELECT 결과와 같은 모양(색 → userid)으로 맞춘다 — 클라이언트가 두 메시지를
        // 같은 코드로 처리할 수 있게.
        const select: Record<string, string> = {};
        for (const [sessionId, color] of this.color_by_session) {
            const user = this.players.get(sessionId);
            if (user) select[String(color)] = user.userid;
        }

        // 지금 둘 차례인 유저와 놓을 수 있는 자리도 함께 담는다(시트에 없는 확장, 2026-10-08 사용자 결정) —
        // 이게 없으면 재접속 유저가 "내 차례인지" 몰라서, 자기 차례였다면 제한 시간이 그냥 흐르다
        // 서버가 랜덤으로 놓아 버린다.
        // ⚠️ SELECT_GAME 결과 후 다음 TURN_START 까지의 2초 공백에는 활성 턴이 없어 채울 수 없다 —
        //    그 경우 두 필드를 생략한다(클라이언트는 곧 오는 TURN_START 로 따라잡는다).
        const turn_user = this.turn_active && this.turn_session !== null ? this.players.get(this.turn_session) : undefined;
        const turn_color = this.turn_session !== null ? this.color_by_session.get(this.turn_session) : undefined;

        const payload: OthelloGameStatusPayload = {
            select,
            status0: othelloRules.GetStonePositions(this.board, OTHELLO_WHITE),
            status1: othelloRules.GetStonePositions(this.board, OTHELLO_BLACK),
            ...(turn_user && turn_color !== undefined
                ? { turn: turn_user.userid, can: othelloRules.GetLegalMoves(this.board, turn_color) }
                : {}),
        };
        messages.SendMessage(this, client, types.MessageType.GAME_STATUS, payload);
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

    // GAME_START 를 보내고 돌 색 선택 단계를 예약한다. 최초 시작(HandleReady)과 같은 상대와의
    // 재게임(ResolveReplay) 둘 다 여기를 쓴다 — 재게임은 READY 를 다시 받지 않는다.
    private StartGame(): void {
        this.game_started = true;
        this.game_over = false;
        this.game_started_at = new Date();
        this.plays.length = 0;
        this.board = othelloRules.CreateInitialBoard();
        this.color_by_session.clear();
        this.doll_select_done = false;
        this.turn_session = null;

        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.GAME_START, {});
        }

        // GAME_START 연출을 클라이언트가 처리할 시간을 준 뒤 돌 색 선택을 시작한다
        this.clock.setTimeout(() => this.StartDollSelect(), othelloConstants.OTHELLO_GAME_START_DELAY_SEC * 1000);
    }

    // --- 돌 색 선택 단계 ---

    // DOLL_SELECT_REMAIN_TIME 을 1초마다 보내고, 제한 시간이 끝나면 남은 색을 랜덤 배정한다.
    private StartDollSelect(): void {
        if (this.players.size < constants.PLAYERS_PER_ROOM || this.game_over) return;

        let remaining = othelloConstants.OTHELLO_DOLL_SELECT_TIMEOUT_SEC - 1;
        this.remain_time_interval = this.clock.setInterval(() => {
            const payload: OthelloRemainTimePayload = { count: remaining };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.DOLL_SELECT_REMAIN_TIME, payload);
            }

            if (remaining === 0) {
                this.ClearRemainTimeInterval();
                this.ResolveDollSelect();
            } else {
                remaining--;
            }
        }, 1000);
    }

    // DOLL_SELECT (C→S) — 돌 색 선택. 한쪽이 고르면 상대는 자동으로 반대 색이 되고 단계가 끝난다(시트).
    private HandleDollSelect(client: Client, message: OthelloDollSelectPayload): void {
        if (!this.game_started || this.game_over || this.doll_select_done) return;
        if (message?.color !== OTHELLO_WHITE && message?.color !== OTHELLO_BLACK) return; // 형식 오류 — 무시
        if (this.color_by_session.has(client.sessionId)) return; // 이미 골랐다

        this.color_by_session.set(client.sessionId, message.color);

        // 상대에게 반대 색을 자동 배정하고 바로 마무리한다 — 시트: "한쪽이 먼저 돌을 선택하면 다른
        // 사람은 자동으로 반대 돌 선택으로 정리 한다"
        const opponent_session = [...this.players.keys()].find((sessionId) => sessionId !== client.sessionId);
        if (opponent_session !== undefined) {
            this.color_by_session.set(opponent_session, othelloRules.GetOpponentColor(message.color));
        }

        this.ClearRemainTimeInterval();
        this.ResolveDollSelect();
    }

    // 돌 색을 확정하고 DOLL_SELECT 결과를 보낸 뒤, 5초 후 첫 턴을 시작한다.
    private ResolveDollSelect(): void {
        if (this.doll_select_done || this.game_over) return;
        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        const sessions = [...this.players.keys()];

        // 제한 시간이 끝났는데 아무도 안 골랐으면 랜덤 배정한다 (시트에 규정이 없어 사용자 결정)
        if (this.color_by_session.size === 0) {
            const first_color: OthelloColor = Math.random() < 0.5 ? OTHELLO_BLACK : OTHELLO_WHITE;
            this.color_by_session.set(sessions[0], first_color);
            this.color_by_session.set(sessions[1], othelloRules.GetOpponentColor(first_color));
        }

        this.doll_select_done = true;

        // select: { 색: userid } — 시트 예시 select:{0:userid1, 1:userid2}
        const select: Record<string, string> = {};
        for (const sessionId of sessions) {
            const color = this.color_by_session.get(sessionId);
            const user = this.players.get(sessionId);
            if (color !== undefined && user) select[String(color)] = user.userid;
        }

        const payload: OthelloDollSelectResultPayload = { select };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.DOLL_SELECT, payload);
        }

        // 시트: "돌선택이 종료 되면 5초후에 TURN_START 로 돌 놓기 시작"
        // 첫 턴은 검정(선공)이다 — 오델로 표준 규칙.
        this.clock.setTimeout(() => {
            this.AdvanceTurn(OTHELLO_BLACK);
        }, othelloConstants.OTHELLO_DOLL_SELECT_DELAY_SEC * 1000);
    }

    // --- 턴 루프 ---

    private GetSessionByColor(color: OthelloColor): string | undefined {
        for (const [sessionId, session_color] of this.color_by_session) {
            if (session_color === color) return sessionId;
        }
        return undefined;
    }

    // next_color 차례로 넘어간다. 여기서 **패스와 종료를 함께 판정**한다:
    //   - next_color 가 둘 곳이 있으면 그 차례로 TURN_START
    //   - 없고 상대는 있으면 패스 → 상대 차례로 TURN_START (별도 PASS 메시지는 보내지 않는다.
    //     클라이언트는 turn 이 연속으로 같은 사람이면 상대가 패스한 것으로 알 수 있다 — 사용자 결정)
    //   - 둘 다 없으면 게임 종료
    private AdvanceTurn(next_color: OthelloColor): void {
        if (this.game_over) return;
        if (this.players.size < constants.PLAYERS_PER_ROOM) return; // 상대가 완전히 나갔으면 진행하지 않는다

        const next_moves = othelloRules.GetLegalMoves(this.board, next_color);
        if (next_moves.length > 0) {
            this.SendTurnStart(next_color, next_moves);
            return;
        }

        const opponent_color = othelloRules.GetOpponentColor(next_color);
        const opponent_moves = othelloRules.GetLegalMoves(this.board, opponent_color);
        if (opponent_moves.length > 0) {
            console.log(`[OthelloGameRoom] 패스 roomId=${this.roomId} color=${next_color}`);
            this.SendTurnStart(opponent_color, opponent_moves);
            return;
        }

        // 양쪽 모두 놓을 곳이 없다 — 게임 종료
        void this.FinishGame();
    }

    // TURN_START (S→C) + 1초마다 TURN_REMAIN_TIME. 제한 시간이 끝나면 합법수 중 하나를 랜덤으로 놓는다.
    private SendTurnStart(color: OthelloColor, legal_moves: { x: number; y: number }[]): void {
        const turn_session = this.GetSessionByColor(color);
        const turn_user = turn_session !== undefined ? this.players.get(turn_session) : undefined;
        if (!turn_session || !turn_user) return; // 그 색의 유저가 없다 — 진행 불가

        this.turn_session = turn_session;
        this.turn_active = true;

        const payload: OthelloTurnStartPayload = { turn: turn_user.userid, can: legal_moves };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.TURN_START, payload);
        }

        let remaining = othelloConstants.OTHELLO_TURN_TIMEOUT_SEC - 1;
        this.remain_time_interval = this.clock.setInterval(() => {
            const remain_payload: OthelloRemainTimePayload = { count: remaining };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.TURN_REMAIN_TIME, remain_payload);
            }

            if (remaining === 0) {
                this.ClearRemainTimeInterval();
                // 시트: "10초 동안 선택을 안 한 경우 랜덤으로 배치를 해 준다"
                // 연결이 끊겨 봇이 대신하는 경우도 이 경로를 그대로 쓴다 — 봇 전용 코드는 따로 없다.
                const random_move = legal_moves[Math.floor(Math.random() * legal_moves.length)];
                this.PlaceStone(turn_session, random_move.x, random_move.y);
            } else {
                remaining--;
            }
        }, 1000);
    }

    // SELECT_GAME (C→S) — 돌을 놓을 자리
    private HandleSelectGame(client: Client, message: OthelloSelectGamePayload): void {
        if (!this.turn_active || this.game_over) return;
        if (client.sessionId !== this.turn_session) return; // 자기 차례가 아니다 — 무시

        const x = message?.select?.x;
        const y = message?.select?.y;
        if (!Number.isInteger(x) || !Number.isInteger(y)) return; // 형식 오류 — 무시

        const color = this.color_by_session.get(client.sessionId);
        if (color === undefined) return;
        if (!othelloRules.IsLegalMove(this.board, x, y, color)) return; // 못 놓는 자리 — 무시

        this.ClearRemainTimeInterval();
        this.PlaceStone(client.sessionId, x, y);
    }

    // 돌을 실제로 놓고 SELECT_GAME 결과를 보낸 뒤, 2초 후 다음 턴으로 넘어간다.
    private PlaceStone(session_id: string, x: number, y: number): void {
        if (this.game_over) return;

        const color = this.color_by_session.get(session_id);
        const user = this.players.get(session_id);
        if (color === undefined || !user) return;

        const flips = othelloRules.ApplyMove(this.board, x, y, color);
        if (!flips) return; // 합법수가 아니다 (여기 오면 호출부 버그)

        this.turn_active = false;
        this.turn_session = null;
        this.plays.push({ userid: user.userid, x, y });

        const payload: OthelloSelectGameResultPayload = {
            select: { userid: user.userid, x, y },
            change: flips,
        };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.SELECT_GAME, payload);
        }

        // 시트: "돌 한번 놓는 SELECT_GAME 결과 전달 후 2초후에 다시 TURN_START 으로 넘거 간다"
        this.clock.setTimeout(() => {
            this.AdvanceTurn(othelloRules.GetOpponentColor(color));
        }, othelloConstants.OTHELLO_SELECT_RESULT_DELAY_SEC * 1000);
    }

    private ClearRemainTimeInterval(): void {
        this.remain_time_interval?.clear();
        this.remain_time_interval = null;
    }

    // --- 게임 종료 ---

    // 양쪽 모두 놓을 곳이 없을 때 최종 결과를 보낸다. 돌이 많은 쪽이 승리, 같으면 무승부.
    private async FinishGame(): Promise<void> {
        this.game_over = true;
        this.turn_active = false;
        this.turn_session = null;
        this.ClearRemainTimeInterval();

        const sessions = [...this.players.keys()];

        // 재접속 창을 닫는다 — 재접속은 "게임이 끝날 때까지"만 유효하다(게임 규칙 9번).
        // 안 닫으면 "manual" 모드라 그 좌석이 영원히 예약된 채로 남아 방이 정리되지 않는다.
        for (const sessionId of sessions) {
            this.reconnection_by_session.get(sessionId)?.reject();
        }

        const counts = othelloRules.CountStones(this.board);
        const black_session = this.GetSessionByColor(OTHELLO_BLACK);
        const white_session = this.GetSessionByColor(OTHELLO_WHITE);

        // 돌 개수로 승패를 가린다. 동수면 무승부 — 이때 winner/loser 자리에는 입장 순서대로 담는다
        // (othelloGameLogSchema.ts 주석 참고).
        const is_draw = counts.black === counts.white;
        let winner_session: string | undefined;
        let loser_session: string | undefined;
        let winner_stones: number;
        let loser_stones: number;

        if (is_draw) {
            [winner_session, loser_session] = sessions;
            winner_stones = counts.black;
            loser_stones = counts.white;
        } else if (counts.black > counts.white) {
            winner_session = black_session;
            loser_session = white_session;
            winner_stones = counts.black;
            loser_stones = counts.white;
        } else {
            winner_session = white_session;
            loser_session = black_session;
            winner_stones = counts.white;
            loser_stones = counts.black;
        }

        const winner_user = winner_session !== undefined ? this.players.get(winner_session) : undefined;
        const loser_user = loser_session !== undefined ? this.players.get(loser_session) : undefined;
        if (!winner_user || !loser_user) {
            // 한쪽이 이미 완전히 나간 상태 — 결과를 보낼 상대가 없다. 재게임 선택만 받고 끝낸다.
            console.error(`[OthelloGameRoom] 게임 종료 시 플레이어 정보 없음 roomId=${this.roomId}`);
            this.StartReplayWait();
            return;
        }

        const winner_is_bot = winner_session !== undefined && this.bot_sessions.has(winner_session);
        const loser_is_bot = loser_session !== undefined && this.bot_sessions.has(loser_session);

        // win_per 은 이번 게임 결과가 반영된 값이다 — DB 저장 완료를 기다리지 않고 메모리 값에 즉시
        // 더해서 계산한다(결과 화면이 DB 왕복 시간만큼 늦어지지 않게 하는 기존 설계 원칙).
        // 무승부면 양쪽 다 승수가 안 늘어난다.
        const payload: OthelloGameResultPayload = {
            winner: {
                userid: winner_user.userid,
                win_count: winner_stones, // 최종 돌 개수 (사용자 결정 2026-10-07)
                win_per: ComputeWinPer(
                    winner_user.total_win_count + (is_draw ? 0 : 1),
                    winner_user.total_game_count + 1
                ),
            },
            loser: {
                userid: loser_user.userid,
                win_count: loser_stones,
                win_per: ComputeWinPer(loser_user.total_win_count, loser_user.total_game_count + 1),
            },
            ...(is_draw ? { draw: "Y" as const } : {}),
        };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.GAME_RESULT, payload);
        }

        this.StartReplayWait();

        try {
            const result = await othelloGameResultRepository.SaveOthelloGameResult({
                winner_userid: winner_user.userid,
                loser_userid: loser_user.userid,
                winner_stones,
                loser_stones,
                is_draw,
                start_time: this.game_started_at ?? new Date(),
                end_time: new Date(),
                // ⚠️ 스냅샷(복사본)을 넘긴다 — 이 DB 저장이 끝나기 전에 재게임으로 StartGame() 이 다시
                // 불리면 this.plays 가 즉시 비워지는데, 원본 참조를 넘기면 빈 배열이 저장된다
                // (RpsGameRoom 에서 실제로 겪은 버그).
                plays: [...this.plays],
                win_is_bot: winner_is_bot,
                lose_is_bot: loser_is_bot,
            });
            // 게임방 메모리의 플레이어 정보도 최신 값으로 갱신 — 재게임할 때 win_per 에 반영되도록.
            if (winner_session !== undefined && this.players.has(winner_session)) {
                this.players.set(winner_session, result.winner);
            }
            if (loser_session !== undefined && this.players.has(loser_session)) {
                this.players.set(loser_session, result.loser);
            }
        } catch (error) {
            console.error(`[OthelloGameRoom] 게임 결과 저장 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        }
    }

    // 재게임/나가기 선택을 기다린다 (DB 저장을 기다리지 않고 먼저 시작한다)
    private StartReplayWait(): void {
        this.replay_by_session.clear();
        this.replay_timeout = this.clock.setTimeout(
            () => this.ResolveReplay(),
            othelloConstants.OTHELLO_REMATCH_CHOICE_TIMEOUT_SEC * 1000
        );
    }

    // GAME_RESULT (C→S) — 재게임 여부 응답. replay:"N" 은 상대 응답을 기다리지 않고 이 유저만 바로 내보낸다.
    private HandleReplay(client: Client, message: OthelloReplayPayload): void {
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
            // 둘 다 재게임 — 같은 방, 같은 상대로 새 게임 시작 (GAME_START 부터, READY 는 다시 안 받음)
            this.ResetGameState();
            this.StartGame();
        } else if (replaying_sessions.length === 1) {
            this.WaitForNewOpponent(replaying_sessions[0]);
        }
        // 0 이면 남은 유저도 위 루프로 이미 정리됐다 — 방은 비면서 자동 정리(dispose)됨
    }

    // 한 게임 상태를 초기화한다 (같은 상대와의 재게임, 새 상대와의 재매칭 둘 다에서 쓴다)
    private ResetGameState(): void {
        this.board = othelloRules.CreateInitialBoard();
        this.color_by_session.clear();
        this.doll_select_done = false;
        this.turn_session = null;
        this.turn_active = false;
        this.ClearRemainTimeInterval();
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
            console.error(`[OthelloGameRoom] PushWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }
}
