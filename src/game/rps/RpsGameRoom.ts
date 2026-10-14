// 가위바위보(RPS) 게임룰이 진행되는 모듈 (2인이 게임을 하는 로직).
// `game/room/GameRoom.ts` 에서 이름/위치를 바꿨다(2026-10-02, "게임별 분리 구조" — CLAUDE.md 참고).
// 다른 게임(예: 오델로)을 추가하면 이 파일과 같은 패턴으로 `game/othello/OthelloGameRoom.ts` 를
// 만들고 `index.ts` 에 등록하면 된다 — 매칭/로비/관리자(Watcher)/PM2/무중단 서비스 등 플랫폼 코드는
// 그대로 재사용된다.

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
import * as rpsConstants from "./rpsConstants.js";
import * as rpsRules from "./rpsRules.js";
import type {
    RpsChoice,
    RpsGameResultPayload,
    RpsOneRemainTimePayload,
    RpsOneResultPayload,
    RpsOneStartPayload,
    RpsReplayPayload,
    RpsSelectGamePayload,
} from "./rpsTypes.js";
import * as rpsGameResultRepository from "../../db/rpsGameResultRepository.js";
import type { RpsPlayRecord } from "../../db/rpsGameResultRepository.js";
import * as userCache from "../../db/userCache.js";
import * as activeGame from "../room/activeGame.js";
import * as waitingRooms from "../room/waitingRooms.js";
import type { ActiveGameEntry, WaitingRoomEntry } from "../room/types.js";

function ToRoomPlayerInfo(user: UserInfo): RoomPlayerInfo {
    return { userid: user.userid, name: user.name, avatar: user.avatar, win_per: rpsRules.ComputeWinPer(user.total_win_count, user.total_game_count) };
}

const ALL_CHOICES: RpsChoice[] = ["가위", "바위", "보"];

function PickRandomChoice(): RpsChoice {
    return ALL_CHOICES[Math.floor(Math.random() * ALL_CHOICES.length)];
}

export class RpsGameRoom extends Room {
    maxClients = constants.PLAYERS_PER_ROOM;

    // sessionId → 좌석 예약에 담겨 온 유저 정보 (Redis/DB 조회 없이 바로 사용).
    // Map 은 입력 순서를 유지하므로, ENTER_ROOM 의 player1/player2 순서(먼저 입장한 쪽이 player1)를
    // 그대로 이 순서에서 가져온다.
    private readonly players = new Map<string, UserInfo>();
    // ENTER_ROOM 을 보낸(로딩 등 준비가 끝난) sessionId 목록. 둘 다 모이면 그때 ENTER_ROOM 응답을 보낸다.
    private readonly entered_by_session = new Set<string>();
    private enter_room_sent = false;
    // sessionId → READY 로 보낸 마지막 값. 둘 다 true 가 되는 순간 GAME_START 를 보낸다.
    private readonly ready_by_session = new Map<string, boolean>();
    private game_started = false;

    // sessionId → 이긴 판 수 (무승부는 세지 않는다). 둘 중 하나가 RPS_WIN_COUNT_TO_FINISH 에 도달하면 게임 종료.
    private readonly win_count_by_session = new Map<string, number>();
    // sessionId → 이번 판에 낸 값. 다음 판 시작(SendOneStart)마다 비운다.
    private readonly choice_by_session = new Map<string, RpsChoice>();
    private round_active = false;
    // ONE_START 뒤 1초마다 ONE_REMAIN_TIME 을 보내는 타이머. count 가 0 이 되면 자동으로 ResolveRound() 를 부른다.
    private remain_time_interval: Delayed | null = null;
    private game_over = false;
    // 마지막 판 ONE_RESULT 뒤 RPS_LAST_RESULT_DELAY_SEC 를 기다렸다가 FinishGame 을 부르는 타이머.
    // 기다리는 동안은 game_over=false(아직 진행 중)로 둔다 — 그 사이 끊김/퇴장도 게임 중 규칙(자동 모드,
    // GAME_RESULT 직후 OUT_USER)을 그대로 따르게 하기 위해서다.
    private finish_timeout: Delayed | null = null;
    // 이번 게임(2선승제 한 판)이 시작된 시각과, 지금까지 낸 판 기록 — game_log 저장(Phase 5-3)에 쓴다.
    // StartGame() 마다(최초 시작이든 같은 상대와의 재게임이든) 새로 초기화한다.
    private game_started_at: Date | null = null;
    private readonly plays: RpsPlayRecord[] = [];

    // sessionId → GAME_RESULT{replay:"Y"|"N"} 응답. true=재게임, false=나가기. RPS_REMATCH_CHOICE_TIMEOUT_SEC
    // 안에 응답 없으면(이 맵에 없으면) 나가기로 처리.
    private readonly replay_by_session = new Map<string, boolean>();
    private replay_timeout: Delayed | null = null;
    // RETURN_TO_LOBBY 를 이미 보내고 내보낸 세션. replay:"N" 즉시 처리와 ResolveReplay 의 나가기 처리가
    // 같은 세션을 두 번 건드릴 수 있어서(아래 KickToLobby 참고) 중복 방지용으로 둔다.
    private readonly kicked_to_lobby = new Set<string>();
    // 재게임을 신청한 유저가 방에 혼자 남아 새 상대를 기다리는 중이면 채워진다 (RemoveWaitingRoom 호출용으로 들고 있음).
    // waiting_session 은 "기다리는 사람이 누구인지" — onLeave 에서 이 세션이 나갈 때만 대기 등록을 지워야 한다.
    // (상대를 내보내는 client.leave() 호출의 onLeave 콜백이 비동기로 늦게 들어올 수 있어서, 단순히
    //  "waiting_room_entry 가 있으면 지운다"로 하면 방금 등록한 걸 엉뚱한 onLeave 가 지워 버리는 경합이 생긴다)
    private waiting_room_entry: WaitingRoomEntry | null = null;
    private waiting_session: string | null = null;

    // 게임 중(game_started && !game_over) 연결이 예기치 않게 끊긴 세션 관련 상태 (Phase 6).
    // sessionId → RECONNECT_WAIT_SEC(5초) 뒤 봇을 투입하는 타이머. 그 전에 재접속하면(onReconnect) 취소한다.
    private readonly bot_timeout_by_session = new Map<string, Delayed>();
    // 봇이 대신 플레이 중인 세션 — 라운드 진행 자체는 (players 에서 지우지 않으므로) 기존 로직이 그대로
    // 처리한다(선택 안 하면 RPS_CHOICE_TIMEOUT_SEC 뒤 자동 선택 — 사람이 느려서 자동 선택되는 것과 같은 경로).
    // 이 Set 은 FinishGame 에서 win_is_bot/lose_is_bot 을 판정하는 용도로만 쓴다.
    private readonly bot_sessions = new Set<string>();
    // allowReconnection() 이 돌려준 재접속 대기 Deferred. 게임이 끝나면(FinishGame) 강제로 reject 해서
    // 재접속 창을 닫는다 — 재접속은 "게임이 끝날 때까지"만 유효하다(게임 규칙 9번). reject 하면 Colyseus 가
    // 곧바로 onLeave() 를 불러 최종 정리한다.
    private readonly reconnection_by_session = new Map<string, Deferred<Client>>();

    // 게임 중 **최종 퇴장**해서 재입장하지 않는 세션 (사용자 요청 2026-10-13, 오델로와 같은 규칙).
    // 좌석(players/win_count_by_session)을 그대로 남겨 두고 이 유저의 선택을 서버가 대신한다 —
    // 남은 유저가 게임을 끝까지 마칠 수 있게 하고, 결과는 나간 유저의 승패/DB 에도 반영한다.
    // 게임이 끝나면 FlushAbandonedPlayers() 가 좌석을 치우고 OUT_USER 를 보낸다.
    private readonly abandoned_sessions = new Set<string>();

    public onCreate(): void {
        // 이름/roomId 로 직접 들어올 수 없게 잠근다 — 예약된 좌석으로만 입장 가능
        this.lock();
        console.log(`[RpsGameRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

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
        log.RegisterLoggedMessage<RpsSelectGamePayload>(this, types.MessageType.SELECT_GAME, (client, message) => {
            this.HandleSelectGame(client, message);
        });
        log.RegisterLoggedMessage<RpsReplayPayload>(this, types.MessageType.GAME_RESULT, (client, message) => {
            this.HandleReplay(client, message);
        });
    }

    public onJoin(client: Client, _options: unknown, auth?: GameSeatAuth): void {
        if (!auth?.user) {
            // 정상 흐름이라면 항상 GameRoomMatcher 가 좌석 예약에 유저 정보를 담아 보낸다.
            // 여기 걸리면 좌석 예약 없이(버그 또는 부정 접근으로) 들어온 것이다.
            console.error(`[RpsGameRoom] auth.user 없이 입장 시도 sessionId=${client.sessionId}`);
            client.leave(CloseCode.WITH_ERROR);
            return;
        }

        this.players.set(client.sessionId, auth.user);
        log.LogConnect(this, client, { userid: auth.user.userid });
        this.SaveMyActiveGameRecord(client, auth.user.userid);
        // ENTER_ROOM 응답은 소켓 입장 시점이 아니라, 클라이언트가 로딩을 끝내고 ENTER_ROOM 을
        // 보내온 뒤(HandleEnterRoom)에 보낸다 — 클라이언트마다 로딩 시간이 다를 수 있기 때문.

        if (this.waiting_room_entry) {
            // 혼자 남아 새 상대를 기다리던 방에 방금 새 유저가 들어옴 — 기존 유저에게 알린다.
            // Redis "기다리는 방" 목록에서는 로비가 TryJoinWaitingRoom 에서 이미 Pop 해 갔으므로 여기서는
            // 우리 쪽 표시(waiting_room_entry)만 지운다 — onLeave 에서 더 이상 RemoveWaitingRoom 을 부르지 않게.
            const waiting_client = this.clients.find((c) => c.sessionId !== client.sessionId);
            if (waiting_client) {
                const opponent_payload: OpponentJoinedPayload = { player: ToRoomPlayerInfo(auth.user) };
                messages.SendMessage(this, waiting_client, types.MessageType.OPPONENT_JOINED, opponent_payload);
            }
            this.waiting_room_entry = null;
            this.waiting_session = null;
        }
    }

    // 게임 중(game_started && !game_over) 연결이 예기치 않게 끊기면 이쪽으로 온다(Colyseus 가 CONSENTED
    // 가 아닌 종료 코드일 때 onLeave 대신 호출). 재접속 대상이 아니면(게임 시작 전/후) 그냥 리턴한다 —
    // Colyseus 가 곧바로 onLeave() 를 불러 지금까지와 같은 방식으로 정리한다.
    public onDrop(client: Client, _code?: number): void {
        if (!this.game_started || this.game_over) {
            return;
        }

        const sessionId = client.sessionId;
        console.log(`[RpsGameRoom] 연결 끊김, 재접속 대기 roomId=${this.roomId} sessionId=${sessionId}`);

        this.bot_timeout_by_session.set(
            sessionId,
            this.clock.setTimeout(() => {
                this.bot_sessions.add(sessionId);
                console.log(`[RpsGameRoom] 봇 투입 roomId=${this.roomId} sessionId=${sessionId}`);
            }, constants.RECONNECT_WAIT_SEC * 1000)
        );

        // "manual" — 시간 제한은 우리가 직접 관리한다. RECONNECT_WAIT_SEC(5초)는 봇을 투입하는 시점일
        // 뿐이고, 재접속 자체는 게임이 끝날 때까지 받는다(FinishGame 에서 강제로 닫는다). 성공/실패 이후
        // 처리는 onReconnect()/onLeave() 에서 한다 — 여기서 await 로 이어 처리하면 Colyseus 내부에 이미
        // 걸려 있는 다른 .then() 콜백(예: allowReconnection 자체의 후처리)과 실행 순서가 보장되지 않는다.
        this.reconnection_by_session.set(sessionId, this.allowReconnection(client, "manual"));

        // 끊긴 유저는 지금부터 자동 모드다(IsAutoSession). 남은 유저가 이 판에서 이미 선택을 마쳤다면
        // 제한 시간을 기다리지 않고 바로 판정한다 (사용자 요청 2026-10-13: "B사용자가 가위,바위,보를
        // 선택하면 바로 A의 선택도 결정 / 상대방이 턴 제한 시간을 모두 기다리지 않도록").
        // ⚠️ 예전에는 이 판정을 봇 투입(5초 뒤) 시점에 했다 — 그래서 끊김 경로는 최대 5초를 기다렸다.
        this.TryResolveRoundIfOnlyAutoLeft();
    }

    // 재접속 성공. this.players 는 onDrop 이후에도 지우지 않았으므로(disconnected 상태에서도 좌석 유지)
    // 그대로 쓰면 된다 — 진행 중이던 라운드도 players.size 가 줄지 않아 기존 로직이 멈추지 않고 계속
    // 진행돼 있었다. Colyseus 는 재접속 시 onJoin 을 다시 부르지 않으므로 여기서 우리 쪽 상태만 되돌린다.
    public onReconnect(client: Client): void {
        const sessionId = client.sessionId;
        this.bot_timeout_by_session.get(sessionId)?.clear();
        this.bot_timeout_by_session.delete(sessionId);
        this.bot_sessions.delete(sessionId);
        this.reconnection_by_session.delete(sessionId);
        console.log(`[RpsGameRoom] 재접속 roomId=${this.roomId} sessionId=${sessionId}`);

        // reconnectionToken 은 (재)입장마다 새로 발급되므로, 다음에 또 끊겼을 때(F5 등으로 로비를 거쳐
        // 돌아올 경우 대비) 로비가 최신 토큰으로 재접속을 시도할 수 있도록 다시 저장해 둔다.
        const user = this.players.get(sessionId);
        if (user) this.SaveMyActiveGameRecord(client, user.userid);
    }

    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        const left_user = this.players.get(client.sessionId);

        // 게임이 진행 중인데 최종 퇴장했다 = 이 유저는 재입장하지 않는다는 뜻이다.
        // ⚠️ 클라이언트가 **명시적으로 나가기**(consented, `Protocol.LEAVE_ROOM`)를 하면 `onDrop` 을
        //    거치지 않고 곧장 여기로 온다(@colyseus/core Room.mjs: code 가 CONSENTED 면 onDrop 을
        //    건너뛴다). 재접속 유예 중 재접속이 실패한 경우도 여기로 온다.
        // 그 경우 좌석을 비우지 않고 **자동 모드**로 이 유저의 선택을 계속 대신한다
        // (사용자 요청 2026-10-13, 오델로와 같은 규칙 — CLAUDE.md "RPS/오델로 — 게임 중 퇴장" 참고):
        //   · players/win_count_by_session 을 유지해야 SendOneStart/ResolveRound 의 "2명" 가드와 라운드
        //     루프가 계속 돈다 (예전에는 여기서 좌석을 비워서 게임이 그대로 멈추고 GAME_RESULT 도,
        //     DB 기록도 남지 않았다 — 나간 유저는 물론 **남아 있던 유저의 전적까지** 사라졌다)
        //   · 진행 중인 판의 타이머도 **멈추지 않는다** — 남은 카운트다운이 끝나면 기존 자동 선택
        //     경로(ResolveRound)가 이 유저의 값을 랜덤으로 채워 판정한다
        //   · bot_sessions 에 넣어 DB 의 win_is_bot/lose_is_bot 에 "봇이 마무리했다"고 남긴다
        //   · OUT_USER 는 **지금 보내지 않는다** — 게임이 끝난 뒤에 보낸다(FlushAbandonedPlayers)
        const abandoned_mid_game = left_user !== undefined && this.IsGameInProgress();

        if (abandoned_mid_game) {
            this.abandoned_sessions.add(client.sessionId);
            this.bot_sessions.add(client.sessionId);
            // choice_by_session 은 지우지 않는다 — 나가기 전에 이미 낸 값이 있으면 그 값으로 판정한다.
        } else {
            this.players.delete(client.sessionId);
            this.choice_by_session.delete(client.sessionId);
            this.win_count_by_session.delete(client.sessionId);
            // 게임이 진행 중이 아니면(좌석 채우기/ENTER_ROOM·READY 대기/게임 종료 후) 더 돌릴 판이
            // 없으므로 진행 중인 타이머를 멈춘다.
            this.round_active = false;
            this.remain_time_interval?.clear();
            this.remain_time_interval = null;
            this.bot_sessions.delete(client.sessionId);
        }

        this.entered_by_session.delete(client.sessionId);
        this.ready_by_session.delete(client.sessionId);
        this.replay_by_session.delete(client.sessionId);
        this.bot_timeout_by_session.get(client.sessionId)?.clear();
        this.bot_timeout_by_session.delete(client.sessionId);
        this.reconnection_by_session.delete(client.sessionId);
        // 이 유저는 최종적으로 나갔다 — 로비가 더 이상 이 방으로 재접속을 안내하면 안 되므로 지운다.
        // (F5 로 로비에 다시 들어왔는데 이미 끝난/나간 방으로 안내되는 것을 막는다.)
        if (left_user) {
            activeGame.RemoveActiveGame(left_user.userid).catch((error) => {
                console.error(`[RpsGameRoom] RemoveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            // 게임방을 떠날 때도 로비와 같은 규칙(CLAUDE.md 흐름 13번)을 따른다 — 값을 새로 쓰지 않고
            // TTL 만 다시 설정한다. 게임 결과가 막 저장돼 캐시가 이미 최신(FinishGame → RefreshUserCache)
            // 이어도 TTL 을 다시 거는 건 안전하다(idempotent).
            userCache.GetUserCache(left_user.userid)
                .then((cached) => (cached ? userCache.TouchUserCache(cached) : undefined))
                .catch((error) => {
                    console.error(`[RpsGameRoom] TouchUserCache 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
                });
        }

        if (this.waiting_room_entry && client.sessionId === this.waiting_session) {
            // 새 상대를 기다리던 그 유저가 나갔다 — Redis "기다리는 방" 목록에서도 지운다.
            // (다른 클라이언트의 onLeave 가 비동기로 뒤늦게 들어온 경우는 여기 해당 안 됨 — sessionId 로 구분)
            waitingRooms.RemoveWaitingRoom("rps", this.waiting_room_entry).catch((error) => {
                console.error(`[RpsGameRoom] RemoveWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            this.waiting_room_entry = null;
            this.waiting_session = null;
        }

        // 남은 상대에게 알린다. (this.clients 는 이 시점에 이미 나간 client 가 제거된 상태 —
        // Colyseus Room._onLeave 가 clients.delete() 후에 onLeave 를 호출한다)
        // 재접속이 걸려 있던 세션(onDrop 경유)이었다면 이 시점은 이미 재접속에 실패해 최종적으로
        // 나간 것이므로, 여느 퇴장과 똑같이 OUT_USER 를 보낸다.
        // 단, 자동 모드로 게임을 이어 두는 경우는 여기서 보내지 않는다 — 게임이 끝난 뒤
        // FlushAbandonedPlayers() 가 보낸다(지금 보내면 클라이언트가 게임을 접어 버린다).
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

        // 재게임/나가기 응답을 기다리는 중(game_over && replay_timeout 이 아직 안 지워짐)에 상대가 나갔고
        // 남은 유저가 이미 응답(재게임/나가기 어느 쪽이든)을 마쳤다면, RPS_REMATCH_CHOICE_TIMEOUT_SEC 이 다
        // 지나기를 기다리지 않고 바로 마무리한다 — HandleReplay 에서 "상대가 이미 응답했으면 즉시 마무리"
        // 하는 것과 같은 이유다. 이게 없으면 재게임을 이미 신청한 유저가 상대의 갑작스런 퇴장 이후에도
        // 남은 시간만큼 그냥 기다리기만 하다가 뒤늦게 "새 상대 기다리는 방"으로 넘어갔다(사용자 요청으로 수정).
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
        console.log(`[RpsGameRoom] 제거됨 roomId=${this.roomId}`);
    }

    // ADMIN_CHANNEL_USER 용 — 지금 이 방에 있는 유저의 userid + roomId. room 필드는 지금은 Colyseus
    // roomId 문자열을 그대로 쓴다 (ENTER_ROOM 의 room 필드와 같은 미확정 사항 — types.ts 참고)
    // 자동 모드로 대신 두고 있는(이미 나간) 유저는 제외한다 — 좌석은 게임이 끝날 때까지 남아 있지만
    // 관리자 화면이 보는 건 "지금 붙어 있는 유저"다.
    public GetChannelUserEntries(): AdminChannelUserEntry[] {
        return [...this.players.entries()]
            .filter(([sessionId]) => !this.abandoned_sessions.has(sessionId))
            .map(([, user]) => ({ userid: user.userid, room: this.roomId }));
    }

    // 게임 중 한 명이 최종 퇴장했을 때 — 자동 모드로 이어 갈 수 있는지 판단한다 (사용자 요청 2026-10-13).
    private OnPlayerAbandonedMidGame(session_id: string): void {
        console.log(`[RpsGameRoom] 게임 중 퇴장 → 자동 모드 roomId=${this.roomId} sessionId=${session_id}`);

        // 둘 다 나가 버렸는지 먼저 확인한다 (아래 즉시 판정은 "남은 사람이 있다"는 전제다).
        // 결과를 볼 사람이 아무도 없는 경우다.
        // ⚠️ 오델로처럼 "지금 점수로 즉시 종료"를 할 수 없다: `rps_game_log.vs`/`score` 는 2선승
        //    (`"2:0"`/`"2:1"`) 기준이라 1:0 같은 중간 점수로 끝내면 거짓 기록이 된다(오델로는 중간
        //    돌 수도 그 자체로 올바른 점수라 가능했다). 그래서 남은 판을 **연출 지연과 카운트다운
        //    없이 즉시** 판정해서 정상적인 2선승 결과를 만든다 — 한 게임이 최대 3판이라 가능하다.
        if (this.clients.length === 0 && this.reconnection_by_session.size === 0) {
            this.ResolveRemainingRoundsNow();
            return;
        }

        // 남은 유저가 이미 선택을 마쳤다면 제한 시간을 다 기다리지 않고 지금 판정한다 (사용자 요청
        // 2026-10-13: "상대방이 턴 제한 시간을 모두 기다리지 않도록 하는 조취"). 아직 선택을 안 했다면
        // 여기서는 아무것도 하지 않고, 그 유저가 선택하는 순간 HandleSelectGame 이 같은 판단을 한다.
        // ⚠️ 자동 모드 전용 제한 시간(오델로의 2초 같은 것)은 RPS 에 두지 않았다 — 남은 유저의 선택과
        //    동시에 판이 끝나므로 기다릴 시간 자체가 없다. 아무도 선택하지 않고 방치하는 경우에만
        //    기존 RPS_CHOICE_TIMEOUT_SEC(10초) 타임아웃이 쓰인다.
        this.TryResolveRoundIfOnlyAutoLeft();
    }

    // 둘 다 나간 뒤 남은 판을 즉시(연출 지연/카운트다운 없이) 판정해 게임을 끝낸다.
    // ⚠️ **즉시 끝내야 하는 이유**: 클라이언트가 하나도 없는 방은 Colyseus 가 좌석 예약 시간이 지나면
    //    자동으로 dispose 한다. 평소 속도(판마다 10초 + 결과 연출 5초)로 두면 게임이 끝나기 전에 방이
    //    사라져 GAME_RESULT 도, DB 기록도 남지 않는다.
    private ResolveRemainingRoundsNow(): void {
        console.log(`[RpsGameRoom] 남은 유저 없음 → 남은 판 즉시 판정 roomId=${this.roomId}`);

        // 승부는 이미 났고 마지막 판 연출 대기(finish_timeout) 중에 둘 다 나간 경우 — 판을 더 돌리면 안 된다.
        // 볼 사람이 없으니 기다리지 않고 바로 종료한다.
        if (this.finish_timeout) {
            this.finish_timeout.clear();
            this.finish_timeout = null;
            const [session_a, session_b] = [...this.players.keys()];
            this.FinishGame(session_a, session_b);
            return;
        }

        // 무승부는 판 수에 들어가지 않아 반복될 수 있으므로 상한을 둔다(무승부 확률 1/3 — 20판까지
        // 무승부만 나올 확률은 사실상 0이지만, 무한 루프를 구조적으로 막아 둔다).
        for (let guard = 0; guard < 20 && !this.game_over; guard++) {
            this.remain_time_interval?.clear();
            this.remain_time_interval = null;
            this.choice_by_session.clear();
            this.round_active = true;
            // 아무 선택도 없으니 ResolveRound 가 양쪽 모두 랜덤으로 채워 판정한다(= 봇끼리 플레이).
            // 2선승에 도달하면 ResolveRound 가 FinishGame 을 부르고 game_over 가 되어 루프가 끝난다.
            this.ResolveRound();
        }
    }

    // 자동 모드로 대신 둔(게임 중 나가서 재입장하지 않은) 유저들을 좌석에서 치우고, 남은 유저에게
    // OUT_USER 로 "이 유저가 나갔다"를 알린다.
    // ⚠️ **GAME_RESULT 를 보낸 뒤에** 호출해야 한다 — 먼저 치우면 결과 payload 에 담을 정보가 없다.
    // ⚠️ bot_sessions 도 여기서 비우므로, DB 에 넘길 win_is_bot/lose_is_bot 은 이 호출 전에 읽어야 한다.
    // 치워야 하는 이유: 좌석이 남아 있으면 재게임 응답을 영원히 기다리는 유저가 생기고
    // (ResolveReplay 의 all_responded), 혼자 남은 유저가 "기다리는 방"으로도 못 넘어간다.
    private FlushAbandonedPlayers(): void {
        if (this.abandoned_sessions.size === 0) return;

        for (const sessionId of this.abandoned_sessions) {
            const user = this.players.get(sessionId);
            this.players.delete(sessionId);
            this.win_count_by_session.delete(sessionId);
            this.choice_by_session.delete(sessionId);
            this.bot_sessions.delete(sessionId);
            if (!user) continue;

            const payload: OutUserPayload = { userid: user.userid };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.OUT_USER, payload);
            }
        }
        this.abandoned_sessions.clear();
    }

    // 무중단 재시작 드레인용(index.ts, roomRegistry.CountRoomsInProgress) — 지금 실제로 게임이
    // 진행 중인지(좌석 채우기/재게임 상대 기다리는 중/게임 종료 후 선택 대기 중 등은 포함하지 않는다).
    public IsGameInProgress(): boolean {
        return this.game_started && !this.game_over;
    }

    // 로비가 F5 등으로 다시 들어온 유저를 이 방으로 재접속시킬 수 있도록, "이 userid 는 지금 이 방에
    // 있다"를 Redis 에 기록한다. onJoin(최초 입장)과 onReconnect(재접속 성공) 양쪽에서 부른다 —
    // reconnectionToken 이 매번 새로 발급되므로 매번 다시 저장해야 최신 토큰으로 안내할 수 있다.
    private SaveMyActiveGameRecord(client: Client, userid: string): void {
        const entry: ActiveGameEntry = {
            room_name: this.roomName,
            room_id: this.roomId,
            reconnection_token: client.reconnectionToken,
        };
        activeGame.SaveActiveGame(userid, entry).catch((error) => {
            console.error(`[RpsGameRoom] SaveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }

    private CheckSeatFillTimeout(): void {
        // 이 타이머는 "방 생성 후 SEAT_RESERVATION_SEC 안에 좌석 예약 2개가 다 소비됐는지"만 확인하는
        // 1회성 체크다. 게임이 이미 시작됐다면 두 좌석 모두 한 번은 채워졌던 것이 확실하므로(HandleReady
        // 가 players.size===PLAYERS_PER_ROOM 을 이미 확인했다) 더 이상 의미가 없다 — 그냥 둔다.
        // ⚠️ 실제로 겪은 버그: 이 가드 없이는, 게임 시작 후 우연히 이 타이머가 도는 시점(방 생성 10초 뒤)에
        // 누군가 재접속 유예 중이라 this.clients.length 가 잠깐 1이면(this.players 는 안 지웠지만
        // this.clients 는 지워짐), "처음부터 한 명만 온 방"으로 오인해서 game_started 여부와 상관없이
        // this.disconnect() 로 양쪽을 통째로 끊어버렸다 — 재접속 유예/봇 진행 중인 게임이 갑자기 끊기는 심각한 버그였다.
        if (this.game_started) {
            return;
        }
        if (this.clients.length === constants.PLAYERS_PER_ROOM) {
            return; // 정상 — 2명 다 들어옴
        }

        if (this.clients.length === 1) {
            // 새로 만든 방에서 한 명만 들어온 경우 — 로비로 돌려보낸다.
            // ("기다리는 방"에 들어오기로 한 유저가 안 온 경우의 재등록 처리는 Phase 5 에서 추가)
            messages.SendMessage(this, this.clients[0], types.MessageType.RETURN_TO_LOBBY, {});
        }

        this.disconnect(CloseCode.WITH_ERROR);
    }

    // ENTER_ROOM (C→S) — 클라이언트가 로딩 등 준비를 마치면 보낸다(payload 없음). 두 명 다 처음 보내면
    // 그제서야 ENTER_ROOM (S→C) 로 방/상대 정보를 응답한다.
    // ⚠️ 실제로 겪은 버그: 이미 한 번 응답을 보낸 뒤(enter_room_sent=true)에는 무조건 무시했었다 —
    // 재접속(F5→REJOIN_GAME→client.reconnect())한 클라이언트는 onJoin 을 다시 안 타서(Colyseus 특성,
    // "재접속/봇 대체" 참고) player1/player2 정보를 다시 받을 방법이 ENTER_ROOM 재요청뿐인데, 그 요청이
    // 조용히 버려져서 게임 참여자 정보를 표시할 수 없었다. **해결**: 이미 보낸 뒤에도 요청한 클라이언트
    // 에게만 같은 정보를 즉시 다시 보낸다(둘 다 다시 보내야 할 필요 없음 — "둘 다 보내야 응답"하는
    // 조건은 최초 한 번만 만족하면 된다).
    private HandleEnterRoom(client: Client): void {
        this.entered_by_session.add(client.sessionId);

        // 상대가 아직 안 들어왔거나(최초) 완전히 나가서(재접속 실패까지 끝남) 없으면 응답할 수 없다
        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        if (this.enter_room_sent) {
            this.SendEnterRoomTo(client);
            return;
        }

        const all_entered = [...this.players.keys()].every((sessionId) => this.entered_by_session.has(sessionId));
        if (!all_entered) return;

        this.enter_room_sent = true;
        this.SendEnterRoom();
    }

    // 두 명 다 처음 ENTER_ROOM 을 보내면 양쪽에 응답한다. player1 = 먼저 입장한 쪽 (players 는 입장 순서를 유지하는 Map)
    private SendEnterRoom(): void {
        for (const client of this.clients) {
            this.SendEnterRoomTo(client);
        }
    }

    // 한 클라이언트에게만 방/상대 정보를 보낸다 — 최초 응답과, 재접속 후 재요청 응답 둘 다 여기를 쓴다.
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

        if (this.game_started) return; // 이미 시작된 뒤에는 더 반응하지 않는다
        if (this.players.size < constants.PLAYERS_PER_ROOM) return; // 아직 상대가 안 들어옴

        const all_ready = [...this.players.keys()].every(
            (sessionId) => this.ready_by_session.get(sessionId) === true
        );
        if (!all_ready) return;

        this.StartGame();
    }

    // GAME_START 를 보내고 첫 판을 예약한다. 최초 시작(HandleReady)과 같은 상대와의 재게임(ResolveReplay)
    // 둘 다 여기를 쓴다 — 재게임은 "다시 GAME_START 부터" 시작하고 READY 를 다시 받지 않는다 (TASKS.md Phase 5-4)
    private StartGame(): void {
        this.game_started = true;
        this.game_over = false;
        this.game_started_at = new Date();
        this.plays.length = 0;
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.GAME_START, {});
        }

        // GAME_START 연출(모션)을 클라이언트가 처리할 시간을 준 뒤 첫 판 시작을 알린다
        this.clock.setTimeout(() => this.SendOneStart(), rpsConstants.RPS_GAME_START_DELAY_SEC * 1000);
    }

    // ONE_START (S→C) — 한 판을 시작한다. 이후 1초마다 ONE_REMAIN_TIME 으로 남은 초를 알리고,
    // count 가 0 이 되면(=RPS_CHOICE_TIMEOUT_SEC 안에 SELECT_GAME 이 안 오면) 자동 선택으로 판을 마무리한다
    private SendOneStart(): void {
        // 좌석이 비었으면 판을 더 진행하지 않는다. 재접속 대기 중이거나 봇이 대신하는 중인 세션,
        // 그리고 게임 중 최종 퇴장한 세션(abandoned_sessions, 2026-10-13)은 좌석을 그대로 두므로 이
        // 가드에 걸리지 않고 라운드가 계속 진행된다 — 선택을 안 내면 아래 RPS_CHOICE_TIMEOUT_SEC
        // 자동 선택이 봇 역할을 한다. 그래서 여기 걸리는 건 게임 시작 전이나 종료 후(좌석 정리 뒤)뿐이다.
        if (this.players.size < constants.PLAYERS_PER_ROOM || this.game_over) return;

        this.choice_by_session.clear();
        this.round_active = true;

        const start_payload: RpsOneStartPayload = { count: rpsConstants.RPS_CHOICE_TIMEOUT_SEC };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.ONE_START, start_payload);
        }

        let remaining = rpsConstants.RPS_CHOICE_TIMEOUT_SEC - 1;
        this.remain_time_interval = this.clock.setInterval(() => {
            const remain_payload: RpsOneRemainTimePayload = { count: remaining };
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.ONE_REMAIN_TIME, remain_payload);
            }

            if (remaining === 0) {
                this.remain_time_interval?.clear();
                this.remain_time_interval = null;
                this.ResolveRound();
            } else {
                remaining--;
            }
        }, 1000);
    }

    private HandleSelectGame(client: Client, message: RpsSelectGamePayload): void {
        if (!this.round_active || this.game_over) return;
        if (message?.select !== "가위" && message?.select !== "바위" && message?.select !== "보") {
            return; // 형식이 잘못된 요청은 무시한다 (문서에 실패 응답이 없음)
        }

        this.choice_by_session.set(client.sessionId, message.select);

        const all_selected = [...this.players.keys()].every((sessionId) => this.choice_by_session.has(sessionId));
        if (all_selected) {
            this.ResolveRound();
            return;
        }

        // 상대가 자동 모드(나가서 재입장하지 않음 또는 봇)라면 그쪽 선택은 영원히 오지 않는다 —
        // 제한 시간을 다 기다리지 말고 지금 판정한다 (사용자 요청 2026-10-13).
        this.TryResolveRoundIfOnlyAutoLeft();
    }

    // 자동 모드(서버가 대신 내는) 세션인지.
    //   · bot_sessions: 연결이 끊긴 뒤 RECONNECT_WAIT_SEC(5초)가 지나 봇이 투입된 세션.
    //     재접속하면 onReconnect 가 지우므로 그 뒤의 판은 다시 사람 차례로 돌아간다.
    //   · abandoned_sessions: 게임 중 최종 퇴장해 재입장하지 않는 세션 (onLeave 에서 추가).
    // onLeave 가 abandoned 를 bot_sessions 에도 넣으므로 지금은 전자만 봐도 되지만, 둘의 의미가
    // 다르므로(봇은 돌아올 수 있고, 퇴장은 돌아올 수 없다) 양쪽을 명시해 둔다 (오델로와 같은 구조).
    // ⚠️ 2026-10-13 **reconnection_by_session(지금 연결이 끊겨 있는 세션)** 조건을 추가했다 — 오델로와
    //    같은 실제 버그(사용자 신고 "A가 나가서 재입장하지 않았는데 다음 턴이 10 부터")의 RPS 쪽이다.
    //    끊김(drop)은 봇이 끊긴 지 5초 뒤에야 bot_sessions 에 들어가서, 그 5초 동안은 남은 유저가 선택해도
    //    판이 끝나지 않고 기다렸다. 지금은 끊긴 **즉시** 자동 모드로 보아 남은 유저의 선택과 동시에 판이
    //    끝난다. 재접속하면 onReconnect 가 지우므로 그 뒤 판부터 다시 본인이 고른다.
    //    bot_sessions 의 5초 타이머는 이제 DB 의 win_is_bot/lose_is_bot 판정에만 쓰인다.
    private IsAutoSession(session_id: string): boolean {
        return (
            this.reconnection_by_session.has(session_id) ||
            this.bot_sessions.has(session_id) ||
            this.abandoned_sessions.has(session_id)
        );
    }

    // 자동 모드 세션이 섞여 있을 때, **사람 쪽 선택이 모두 모였으면** 제한 시간을 기다리지 않고 즉시
    // 판정한다 (사용자 요청 2026-10-13: "B사용자가 가위,바위,보를 선택하면 바로 A의 선택도 결정을
    // 한다 / 상대방이 턴 제한 시간을 모두 기다리지 않도록 하는 조취").
    // 자동 모드 세션의 값은 ResolveRound 가 그 자리에서 랜덤으로 채운다 — 기존 "제한 시간 초과 시
    // 자동 선택" 과 **같은 경로**라 판정/로그/DB 처리가 전부 그대로 재사용된다.
    // ⚠️ 자동 모드 세션이 하나도 없으면 아무것도 하지 않는다 — 평소 규칙(둘 다 선택해야 판정)을
    //    바꾸지 않기 위한 가드다. 호출부 세 곳(선택 수신 / 게임 중 퇴장 / 연결 끊김)에서 모두 쓴다.
    private TryResolveRoundIfOnlyAutoLeft(): void {
        if (!this.round_active || this.game_over) return;
        if (this.players.size < constants.PLAYERS_PER_ROOM) return;

        const sessions = [...this.players.keys()];
        if (!sessions.some((sessionId) => this.IsAutoSession(sessionId))) return;
        // 양쪽 다 자동 모드면(둘 다 끊김 등) 기다리는 사람이 없으므로 앞당길 이유가 없다 — 평소 제한 시간을
        // 그대로 쓴다. 둘 다 "최종 퇴장"한 경우는 OnPlayerAbandonedMidGame 의 즉시 판정이 따로 처리한다.
        // (이 가드가 없으면 둘 다 잠깐 끊겼다 돌아오는 사이에 그 판이 서버 랜덤으로 끝나 버린다)
        if (sessions.every((sessionId) => this.IsAutoSession(sessionId))) return;

        const all_human_selected = sessions.every(
            (sessionId) => this.IsAutoSession(sessionId) || this.choice_by_session.has(sessionId)
        );
        if (all_human_selected) this.ResolveRound();
    }

    // 판을 마무리한다. RPS_CHOICE_TIMEOUT_SEC 안에 선택하지 못한 유저는 무작위로 자동 선택한다
    private ResolveRound(): void {
        if (!this.round_active) return; // 이미 처리됨 (자동 선택 타임아웃과 양쪽 선택 완료가 겹친 경우)
        this.round_active = false;
        this.remain_time_interval?.clear();
        this.remain_time_interval = null;

        if (this.players.size < constants.PLAYERS_PER_ROOM) return; // 좌석이 비어 판정할 수 없음(게임 시작 전/종료 후)

        for (const sessionId of this.players.keys()) {
            if (!this.choice_by_session.has(sessionId)) {
                this.choice_by_session.set(sessionId, PickRandomChoice());
            }
        }

        const [session_a, session_b] = [...this.players.keys()];
        const choice_a = this.choice_by_session.get(session_a)!;
        const choice_b = this.choice_by_session.get(session_b)!;
        const userid_a = this.players.get(session_a)!.userid;
        const userid_b = this.players.get(session_b)!.userid;
        const judge = rpsRules.JudgeChoice(choice_a, choice_b);
        const winner_session = judge === 1 ? session_a : judge === -1 ? session_b : null;

        const payload: RpsOneResultPayload = { player1: choice_a, player2: choice_b };
        if (winner_session) {
            payload.win = this.players.get(winner_session)!.userid;
        }
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.ONE_RESULT, payload);
        }

        if (!winner_session) {
            // 무승부 — 판 수에 넣지 않고 같은 판을 다시 진행. 결과를 보여줄 시간을 준 뒤 다음 ONE_START
            this.plays.push({ [userid_a]: choice_a, [userid_b]: choice_b });
            this.clock.setTimeout(() => this.SendOneStart(), rpsConstants.RPS_ONE_RESULT_DELAY_SEC * 1000);
            return;
        }

        this.plays.push({ [userid_a]: choice_a, [userid_b]: choice_b });

        const win_count = (this.win_count_by_session.get(winner_session) ?? 0) + 1;
        this.win_count_by_session.set(winner_session, win_count);

        if (win_count >= rpsConstants.RPS_WIN_COUNT_TO_FINISH) {
            // 마지막 판 결과 연출을 보여줄 시간을 준 뒤 GAME_RESULT 를 보낸다 (사용자 요청 2026-10-14).
            // 결과를 볼 클라이언트가 하나도 없으면(둘 다 나감 → ResolveRemainingRoundsNow) 기다리지 않는다.
            if (this.clients.length === 0) {
                this.FinishGame(session_a, session_b);
                return;
            }
            this.finish_timeout = this.clock.setTimeout(() => {
                this.finish_timeout = null;
                this.FinishGame(session_a, session_b);
            }, rpsConstants.RPS_LAST_RESULT_DELAY_SEC * 1000);
        } else {
            this.clock.setTimeout(() => this.SendOneStart(), rpsConstants.RPS_ONE_RESULT_DELAY_SEC * 1000);
        }
    }

    // 둘 중 하나가 RPS_WIN_COUNT_TO_FINISH 판을 먼저 이겨서 게임이 끝났을 때 최종 결과를 보낸다
    private async FinishGame(session_a: string, session_b: string): Promise<void> {
        this.game_over = true;

        // 재접속 창을 닫는다 — 재접속은 "게임이 끝날 때까지"만 유효하다(게임 규칙 9번). 아직 재접속하지
        // 못한 세션이 있으면 강제로 reject 해서 Colyseus 가 곧바로 onLeave() 로 최종 정리하게 한다
        // (안 닫으면 "manual" 모드라 그 좌석이 영원히 예약된 채로 남아 방이 정리되지 않는다).
        for (const sessionId of [session_a, session_b]) {
            this.reconnection_by_session.get(sessionId)?.reject();
        }

        const count_a = this.win_count_by_session.get(session_a) ?? 0;
        const count_b = this.win_count_by_session.get(session_b) ?? 0;
        const winner_session = count_a > count_b ? session_a : session_b;
        const loser_session = winner_session === session_a ? session_b : session_a;
        const winner_user = this.players.get(winner_session)!;
        const loser_user = this.players.get(loser_session)!;
        // "게임이 끝날 때" 그 세션이 봇으로 플레이 중이었는지 — 재접속했으면 이미 onReconnect 에서 지워졌다.
        const winner_is_bot = this.bot_sessions.has(winner_session);
        const loser_is_bot = this.bot_sessions.has(loser_session);

        // win_per 은 이번 판 결과가 반영된 값이다 — DB 저장(SaveRpsGameResult) 완료를 기다리지 않고, 메모리에
        // 있는 현재 값(this.players, 아직 DB 반영 전이므로 지난 게임까지의 값)에 "이번 판 결과"를 더해
        // 즉시 계산한다(결과 화면이 DB 왕복 시간만큼 늦어지지 않게 하는 기존 설계 원칙 유지).
        const winner_count = this.win_count_by_session.get(winner_session) ?? 0;
        const loser_count = this.win_count_by_session.get(loser_session) ?? 0;
        const payload: RpsGameResultPayload = {
            winner: {
                userid: winner_user.userid,
                win_count: winner_count,
                win_per: rpsRules.ComputeWinPer(winner_user.total_win_count + 1, winner_user.total_game_count + 1),
            },
            loser: {
                userid: loser_user.userid,
                win_count: loser_count,
                win_per: rpsRules.ComputeWinPer(loser_user.total_win_count, loser_user.total_game_count + 1),
            },
        };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.GAME_RESULT, payload);
        }

        // 자동 모드로 마무리한(게임 중 나가서 재입장하지 않은) 유저가 있으면 **이제** 남은 유저에게
        // 그 사실을 알리고 좌석을 치운다 (사용자 요청 2026-10-13). 순서가 중요하다 — GAME_RESULT 를
        // 먼저 보내야 결과 payload 에 그 유저 정보가 담기고, win_is_bot/lose_is_bot 도 위에서 이미 읽었다.
        this.FlushAbandonedPlayers();

        // 재게임/나가기 선택을 기다린다. RPS_REMATCH_CHOICE_TIMEOUT_SEC 안에 응답 없는 쪽은 나가기로 처리한다.
        // (아래 DB 저장을 기다리지 않고 먼저 시작한다 — 결과 화면/재게임 응답까지 DB 왕복 시간만큼 늦어지면 안 된다)
        this.replay_by_session.clear();
        this.replay_timeout = this.clock.setTimeout(() => this.ResolveReplay(), rpsConstants.RPS_REMATCH_CHOICE_TIMEOUT_SEC * 1000);

        try {
            const result = await rpsGameResultRepository.SaveRpsGameResult({
                winner_userid: winner_user.userid,
                loser_userid: loser_user.userid,
                loser_win_count: loser_count,
                start_time: this.game_started_at ?? new Date(),
                end_time: new Date(),
                // 스냅샷(복사본)을 넘긴다 — 이 DB 저장이 끝나기 전에 재게임으로 StartGame() 이 다시 불리면
                // this.plays 가 즉시 비워지는데(다음 게임 준비), 원본 배열 참조를 그대로 넘기면 그 시점에
                // 아직 비동기로 대기 중이던 이 요청까지 빈 배열을 저장하게 된다 — 실제로 겪은 버그.
                plays: [...this.plays],
                win_is_bot: winner_is_bot,
                lose_is_bot: loser_is_bot,
            });
            // 게임방 메모리의 플레이어 정보도 최신 값으로 갱신 — 재게임할 때(ENTER_ROOM 의 win_per) 반영되도록.
            // 그 사이 나간 세션이면 다시 만들어 넣지 않는다 (has 로 확인).
            if (this.players.has(winner_session)) this.players.set(winner_session, result.winner);
            if (this.players.has(loser_session)) this.players.set(loser_session, result.loser);
        } catch (error) {
            console.error(`[RpsGameRoom] 게임 결과 저장 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        }
    }

    // GAME_RESULT (C→S) — 게임이 끝난 뒤 재게임 여부 응답. replay:"N" 은 상대 응답을 기다리지 않고
    // 이 유저만 바로 내보낸다(문서에 없는 확장). 아무 응답도 없으면(문서 기준) 타임아웃으로 나가기 처리된다.
    private HandleReplay(client: Client, message: RpsReplayPayload): void {
        if (!this.game_over) return; // 게임이 끝나기 전에는 의미 없는 요청 — 무시
        if (message?.replay !== "Y" && message?.replay !== "N") return; // 형식이 잘못된 요청은 무시
        if (this.replay_by_session.has(client.sessionId)) return; // 이미 응답함

        this.replay_by_session.set(client.sessionId, message.replay === "Y");

        if (message.replay === "N") {
            // 상대가 아직 응답 안 했어도(또는 이미 재게임을 골랐어도) 상관없이 이 유저는 바로 나간다
            this.KickToLobby(client);
        }

        // 남은 유저 전원이 응답을 마쳤으면(재게임이든 나가기든) 타임아웃을 기다리지 않고 바로 마무리한다
        const all_responded = [...this.players.keys()].every((sessionId) => this.replay_by_session.has(sessionId));
        if (all_responded) {
            this.ResolveReplay();
        }
    }

    // RETURN_TO_LOBBY 를 보내고 연결을 끊는다. 같은 세션에 두 번 호출돼도 안전하다(HandleReplay 의 즉시
    // 나가기 처리와 ResolveReplay 의 나가기 처리가 겹칠 수 있어서 — kicked_to_lobby 로 막는다).
    private KickToLobby(client: Client): void {
        if (this.kicked_to_lobby.has(client.sessionId)) return;
        this.kicked_to_lobby.add(client.sessionId);
        messages.SendMessage(this, client, types.MessageType.RETURN_TO_LOBBY, {});
        client.leave(CloseCode.CONSENTED);
    }

    // 재게임 응답을 마무리한다 (둘 다 응답했거나, RPS_REMATCH_CHOICE_TIMEOUT_SEC 초과)
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
            // 둘 다 재게임 — 같은 방, 같은 상대로 새 게임 시작 (다시 GAME_START 부터, READY 는 다시 안 받음)
            // (leaving_sessions.length 만으로는 판단하지 않는다 — 상대가 이미 연결이 끊겨 sessions 자체가
            //  1명뿐인 경우에도 leaving_sessions 는 비어 있을 수 있어서, "정말 둘 다 있고 둘 다 재게임"인지
            //  replaying_sessions.length 로 직접 확인해야 한다)
            this.ResetRoundState();
            this.StartGame();
        } else if (replaying_sessions.length === 1) {
            // 한 명만 재게임 — 남은 유저는 새 상대를 기다린다. 상대가 있었다면 위 루프에서 이미 내보냈다.
            this.WaitForNewOpponent(replaying_sessions[0]);
        }
        // replaying_sessions.length === 0 이면 남은 유저도 위 루프로 이미 정리됐다 — 방은 비면서 자동 정리(dispose)됨
    }

    // 한 판/한 게임 상태를 초기화한다 (같은 상대와의 재게임, 새 상대와의 재매칭 둘 다에서 쓴다)
    private ResetRoundState(): void {
        this.win_count_by_session.clear();
        this.choice_by_session.clear();
        // 평소엔 FlushAbandonedPlayers() 가 게임 종료 때 이미 비웠다 — 새 게임이 이전 게임의
        // 자동 모드 표시를 물려받지 않도록 하는 안전장치다.
        this.abandoned_sessions.clear();
        this.round_active = false;
        this.remain_time_interval?.clear();
        this.remain_time_interval = null;
        this.game_over = false;
        this.replay_by_session.clear();
        this.replay_timeout?.clear();
        this.replay_timeout = null;
        this.kicked_to_lobby.clear();
    }

    // 재게임을 신청했는데 상대가 나가서 혼자 남았을 때 — "기다리는 방"으로 등록하고 새 상대를 기다린다.
    // 대기 시간에는 제한이 없다 (CLAUDE.md 게임 규칙 12번). 새 상대는 onJoin 에서 OPPONENT_JOINED 로 알린다.
    private WaitForNewOpponent(remaining_session: string): void {
        const remaining_user = this.players.get(remaining_session);
        if (!remaining_user) return; // 그 사이 이 유저도 나갔다면 더 할 게 없다

        // 새 상대와는 ENTER_ROOM 부터 다시 진행한다 ("처음 게임과 같은 흐름" — TASKS.md Phase 5-4)
        this.ResetRoundState();
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
        waitingRooms.PushWaitingRoom("rps", entry).catch((error) => {
            console.error(`[RpsGameRoom] PushWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }
}
