// 에어하키(airhockey) 게임이 진행되는 모듈 (2인, 2026-10-15 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `airhockey` 시트가 기준이다.
//
// 구조는 SteppingGameRoom 과 의도적으로 같다 — 플랫폼 공통 부분(좌석 채우기/ENTER_ROOM/READY/재접속/
// 재게임·기다리는 방/activeGame/roomRegistry)은 거의 그대로 가져왔고, 게임 전용 부분만 다르다:
//   점핑:     MAP_SELECT → GAME_START → 60초 동안 MOVE_INFO → GAME_RESULT
//   에어하키: SERVE_SELECT(동전 던지기) → (5초) → GAME_START → (3초) → ONE_START{serve}
//             → 실시간 물리(PUCK_MOVE / LEVER_MOVE) → 골이 나면 ONE_RESULT
//             → (3초) → ONE_START … → 누군가 3골 → (3초) → GAME_RESULT
//             퍽이 10초간 거의 제자리면(끼임·독점) 골 없이 ONE_START 부터 이번 판만 다시 (RestartStuckRound)
//             ONE_START 뒤 10초간 서브를 안 하면 점수 없이 서브권이 상대에게 넘어간다 (PassServe, 2026-10-29)
//
// ⚠️ 서버가 퍽 물리를 직접 계산한다(airhockeyRules.StepWorld, 60Hz). 클라이언트는 자기 레버 좌표만 보내고,
//    서버가 30Hz 로 퍽 위치(PUCK_MOVE)와 상대 레버 위치(LEVER_MOVE)를 보낸다. 좌표는 받는 유저 기준(내가 아래).
// ⚠️ 게임 중 끊김/퇴장은 오델로/RPS 와 같은 "자동 모드"다 — 좌석은 남기고, 그 유저의 레버는 서버의 간단한
//    봇이 대신 움직인다(사용자 결정). 재접속하면 GAME_STATUS 를 받고 다시 본인이 조종한다.

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
import * as airhockeyConstants from "./airhockeyConstants.js";
import * as airhockeyRules from "./airhockeyRules.js";
import type {
    AirhockeyGameResultPayload,
    AirhockeyGameResultPlayerInfo,
    AirhockeyGameStatusPayload,
    AirhockeyLeverMovePayload,
    AirhockeyLeverMoveResultPayload,
    AirhockeyLeverState,
    AirhockeyOneResultPayload,
    AirhockeyOneStartPayload,
    AirhockeyPlayRecord,
    AirhockeyPoint,
    AirhockeyPuckMovePayload,
    AirhockeyPuckState,
    AirhockeyReplayPayload,
    AirhockeyServeSelectPayload,
    AirhockeySide,
    AirhockeyStuckWatch,
} from "./airhockeyTypes.js";
import * as airhockeyGameResultRepository from "../../db/airhockeyGameResultRepository.js";
import * as userCache from "../../db/userCache.js";
import * as activeGame from "../room/activeGame.js";
import * as waitingRooms from "../room/waitingRooms.js";
import type { ActiveGameEntry, WaitingRoomEntry } from "../room/types.js";

const GAME_TYPE = "airhockey" as const;
const TICK_SEC = airhockeyConstants.AIRHOCKEY_TICK_MS / 1000;

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

function SamePoint(a: AirhockeyPoint | null, b: AirhockeyPoint): boolean {
    return a !== null && a.x === b.x && a.y === b.y;
}

export class AirhockeyGameRoom extends Room {
    maxClients = constants.PLAYERS_PER_ROOM;

    // --- 플랫폼 공통 상태 (SteppingGameRoom 과 같은 의미) ---

    // sessionId → 좌석 예약에 담겨 온 유저 정보. Map 은 입력 순서를 유지하므로 player1/player2 순서
    // (먼저 입장한 쪽이 player1)를 그대로 이 순서에서 가져온다. **player1 = side 0(아래), player2 = side 1(위)**.
    private readonly players = new Map<string, UserInfo>();
    private readonly entered_by_session = new Set<string>();
    private enter_room_sent = false;
    private readonly ready_by_session = new Map<string, boolean>();
    // SERVE_SELECT 를 보낸 순간부터 true. (GAME_START 전 동전 연출 5초, 첫 ONE_START 전 연출 3초도 "게임 중"으로 본다)
    private game_started = false;
    private game_over = false;
    private game_started_at: Date | null = null;

    private readonly replay_by_session = new Map<string, boolean>();
    private replay_timeout: Delayed | null = null;
    private readonly kicked_to_lobby = new Set<string>();
    private waiting_room_entry: WaitingRoomEntry | null = null;
    private waiting_session: string | null = null;

    // 끊긴 지 RECONNECT_WAIT_SEC(5초)가 지나면 bot_sessions 에 넣는 타이머. 봇 조종 자체는 끊기는 **즉시**
    // 시작하고(IsBotControlled), bot_sessions 는 DB 의 win_is_bot/lose_is_bot 판정에만 쓴다.
    private readonly bot_timeout_by_session = new Map<string, Delayed>();
    private readonly bot_sessions = new Set<string>();
    private readonly reconnection_by_session = new Map<string, Deferred<Client>>();

    // 게임 중 **최종 퇴장**해서 재입장하지 않는 세션. 좌석(players)은 그대로 남겨 봇이 이어 두고, 결과를
    // 그 유저의 승패에도 반영한다. 게임이 끝나면 FlushAbandonedPlayers() 가 OUT_USER 를 보낸다.
    private readonly abandoned_sessions = new Set<string>();

    // --- 에어하키 전용 상태 (좌표는 모두 절대 좌표: side 0 이 아래) ---

    private puck: AirhockeyPuckState = airhockeyRules.CreatePuck();
    private levers: [AirhockeyLeverState, AirhockeyLeverState] = [airhockeyRules.CreateLever(0), airhockeyRules.CreateLever(1)];
    // side 별로 "이번 판(ONE_START 이후) LEVER_MOVE 를 아직 못 받았나". true 면 다음 LEVER_MOVE 를 SnapLever 로 바로 놓는다.
    private readonly lever_awaiting_first_input: [boolean, boolean] = [false, false];
    // side 별 넣은 골 수
    private readonly goals: [number, number] = [0, 0];
    // 이번 게임의 첫 서브 쪽(동전 던지기 결과)과 지금 판의 서브 쪽 — airhockeyRules.GetServeSide 참고
    private first_serve_side: AirhockeySide = 0;
    private serve_side: AirhockeySide = 0;
    // 다음 게임의 첫 서브 쪽을 미리 정해 둔 값. 같은 상대와 재게임하면 직전 게임의 리시브 쪽(탁구 교대),
    // null 이면 StartGame 에서 동전 던지기를 한다(최초 게임, 새 상대).
    private next_first_serve_side: AirhockeySide | null = null;
    // ONE_START ~ 골 사이에만 true — 이때만 퍽 물리를 계산한다(골 연출 중에는 퍽이 골대 안에 멈춰 있다).
    private round_active = false;
    // 퍽이 한자리에 오래 머무는지 감시한다 — AIRHOCKEY_STUCK_RESET_SEC 이 지나면 이번 판을 다시 시작(RestartStuckRound)
    private stuck_watch: AirhockeyStuckWatch = airhockeyRules.CreateStuckWatch(airhockeyRules.CreatePuck());
    // 이번 판 서브를 아직 안 했나 (ONE_START 때 true, 퍽이 서브 자리를 벗어나면 false). true 인 동안은 정체 대신
    // 서브 제한 시간(AIRHOCKEY_SERVE_TIMEOUT_SEC)을 본다 — 그동안 stuck_watch.still_sec 가 서브를 기다린 시간이다.
    private serve_pending = false;
    // 골 없이 연달아 한 정체 재시작 횟수. 골이 나거나 새 게임이면 0. AIRHOCKEY_STUCK_MAX_RESTARTS 를 넘으면 무효(InvalidateGame)
    private stuck_restart_count = 0;
    // 물리 루프(setSimulationInterval)가 돌고 있는지. GAME_START 부터 게임 종료까지 돈다.
    private simulation_running = false;
    // setSimulationInterval 을 이미 걸었는지. 한 번 걸면 방이 없어질 때까지 끄지 않는다(StopSimulation 참고).
    private simulation_loop_created = false;
    // 아직 Tick 으로 소화하지 못한 실제 경과 시간(ms). RunSimulationSteps 참고
    private simulation_accumulator_ms = 0;
    private tick_count = 0;
    // 마지막으로 보낸 좌표(절대, 반올림). 바뀌었을 때만 다시 보낸다 — 멈춘 퍽/레버로 대역폭을 쓰지 않게.
    private last_sent_puck: AirhockeyPoint | null = null;
    private last_sent_puck_vel: AirhockeyPoint | null = null;
    private readonly last_sent_lever: [AirhockeyPoint | null, AirhockeyPoint | null] = [null, null];
    // SERVE_SELECT → GAME_START 지연, GAME_START → 첫 ONE_START 지연, ONE_RESULT → 다음 ONE_START 지연 타이머
    private round_timeout: Delayed | null = null;
    // 마지막 골 뒤 AIRHOCKEY_RESULT_DELAY_SEC 를 기다렸다가 FinishGame 을 부르는 타이머 (RequestFinish 참고).
    private finish_timeout: Delayed | null = null;
    // 이번 게임의 골 기록 — DB 로그(airhockey_game_log.plays)에 쓴다. StartGame 마다 비운다.
    private readonly plays: AirhockeyPlayRecord[] = [];

    public onCreate(): void {
        // 이름/roomId 로 직접 들어올 수 없게 잠근다 — 예약된 좌석으로만 입장 가능
        this.lock();
        console.log(`[AirhockeyGameRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

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
        log.RegisterLoggedMessage<AirhockeyLeverMovePayload>(this, types.MessageType.LEVER_MOVE, (client, message) => {
            this.HandleLeverMove(client, message);
        });
        log.RegisterLoggedMessage<AirhockeyReplayPayload>(this, types.MessageType.GAME_RESULT, (client, message) => {
            this.HandleReplay(client, message);
        });
    }

    public onJoin(client: Client, _options: unknown, auth?: GameSeatAuth): void {
        if (!auth?.user) {
            // 정상 흐름이라면 항상 GameRoomMatcher 가 좌석 예약에 유저 정보를 담아 보낸다.
            console.error(`[AirhockeyGameRoom] auth.user 없이 입장 시도 sessionId=${client.sessionId}`);
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
    // 끊긴 **즉시** 그 유저의 레버를 봇이 조종한다(reconnection_by_session 에 들어가는 순간부터).
    public onDrop(client: Client, _code?: number): void {
        if (!this.game_started || this.game_over) {
            return;
        }

        const sessionId = client.sessionId;
        console.log(`[AirhockeyGameRoom] 연결 끊김, 재접속 대기 + 봇 조종 roomId=${this.roomId} sessionId=${sessionId}`);

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
        console.log(`[AirhockeyGameRoom] 재접속 → 다시 본인 조종 roomId=${this.roomId} sessionId=${sessionId}`);

        // reconnectionToken 은 (재)입장마다 새로 발급되므로 다시 저장해 둔다 (F5 재접속 대비)
        const user = this.players.get(sessionId);
        if (user) this.SaveMyActiveGameRecord(client, user.userid);
    }

    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        const left_user = this.players.get(client.sessionId);

        // 게임이 진행 중인데 최종 퇴장했다 = 이 유저는 재입장하지 않는다는 뜻이다.
        // ⚠️ 명시적 나가기(CONSENTED)는 onDrop 을 거치지 않고 곧장 여기로 온다. 재접속 실패도 여기로 온다.
        // 좌석은 비우지 않는다 — 봇이 레버를 이어 받고, 결과를 그 유저의 승패에도 반영한다.
        // OUT_USER 는 게임이 끝난 뒤에 보낸다(FlushAbandonedPlayers) — 오델로/RPS/점핑과 같은 규칙.
        const abandoned_mid_game = left_user !== undefined && this.IsGameInProgress();

        if (abandoned_mid_game) {
            this.abandoned_sessions.add(client.sessionId);
            this.bot_sessions.add(client.sessionId);
        } else {
            this.players.delete(client.sessionId);
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
                console.error(`[AirhockeyGameRoom] RemoveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
            });
            // 게임방을 떠날 때도 로비와 같은 규칙 — 값을 새로 쓰지 않고 TTL 만 갱신
            userCache.GetUserCache(left_user.userid)
                .then((cached) => (cached ? userCache.TouchUserCache(cached) : undefined))
                .catch((error) => {
                    console.error(`[AirhockeyGameRoom] TouchUserCache 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
                });
        }

        if (this.waiting_room_entry && client.sessionId === this.waiting_session) {
            // 새 상대를 기다리던 그 유저가 나갔다 — Redis "기다리는 방" 목록에서도 지운다.
            // (sessionId 로 구분해야 한다 — 다른 클라이언트의 onLeave 가 뒤늦게 들어오는 경합 방지)
            waitingRooms.RemoveWaitingRoom(GAME_TYPE, this.waiting_room_entry).catch((error) => {
                console.error(`[AirhockeyGameRoom] RemoveWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
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
        this.StopSimulation();
        roomRegistry.UnregisterRoom(this);
        console.log(`[AirhockeyGameRoom] 제거됨 roomId=${this.roomId}`);
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
            console.error(`[AirhockeyGameRoom] SaveActiveGame 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
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

    // sessionId → side(0 = player1 = 아래, 1 = player2 = 위). 이 방의 좌석이 아니면 null.
    private GetSide(session_id: string): AirhockeySide | null {
        const index = [...this.players.keys()].indexOf(session_id);
        return index === 0 || index === 1 ? index : null;
    }

    // 이 세션의 레버를 봇이 조종해야 하는지 — 끊겨서 재접속을 기다리는 중이거나, 게임 중 최종 퇴장했다.
    private IsBotControlled(session_id: string): boolean {
        return this.reconnection_by_session.has(session_id) || this.abandoned_sessions.has(session_id);
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

    // GAME_STATUS (S→C) — 지금 상태를 **이 클라이언트에게만** 보낸다(재접속 복원용). 좌표는 이 유저 기준.
    // 게임 전/후에는 복원할 상태가 없으므로 보내지 않는다.
    private SendGameStatusTo(client: Client): void {
        if (!this.IsGameInProgress()) return;
        const side = this.GetSide(client.sessionId);
        if (side === null) return;

        const ToClient = (point: AirhockeyPoint): AirhockeyPoint =>
            airhockeyRules.RoundPoint(airhockeyRules.ToSideFrame(point, side));
        const payload: AirhockeyGameStatusPayload = {
            puck: { loc: ToClient(this.puck), vel: ToClient({ x: this.puck.vx, y: this.puck.vy }) },
            LEVER0: ToClient(this.levers[0]),
            LEVER1: ToClient(this.levers[1]),
            win_count0: this.goals[0],
            win_count1: this.goals[1],
            server: this.GetUserid(this.serve_side),
        };
        messages.SendMessage(this, client, types.MessageType.GAME_STATUS, payload);
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

    // sessionId 순서(player1/player2) 기준 side 의 userid. 좌석은 게임 중 비지 않으므로 정상 흐름에서는 항상 있다.
    private GetUserid(side: AirhockeySide): string {
        return [...this.players.values()][side]?.userid ?? "";
    }

    // 첫 서브를 정해 SERVE_SELECT 를 보내고, 5초 뒤 GAME_START(StartPlay)를 예약한다. 최초 시작(HandleReady)과 같은
    // 상대와의 재게임(ResolveReplay) 둘 다 여기를 쓴다 — 재게임은 READY 를 다시 받지 않는다.
    private StartGame(): void {
        this.game_started = true;
        this.game_over = false;
        this.game_started_at = new Date();
        this.plays.length = 0;
        this.goals[0] = 0;
        this.goals[1] = 0;
        this.stuck_restart_count = 0;
        this.round_active = false;
        // 첫 서브 — 재게임이면 미리 정해 둔 교대 순서, 아니면 동전 던지기 (2026-10-29 사용자 결정)
        this.first_serve_side = this.next_first_serve_side ?? airhockeyRules.PickCoinTossSide();
        this.next_first_serve_side = null;
        this.serve_side = this.first_serve_side;
        this.puck = airhockeyRules.CreateServePuck(this.serve_side);
        this.levers = [airhockeyRules.CreateLever(0), airhockeyRules.CreateLever(1)];
        this.ForceResendPositions();

        const payload: AirhockeyServeSelectPayload = { userid: this.GetUserid(this.first_serve_side) };
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.SERVE_SELECT, payload);
        }

        this.round_timeout = this.clock.setTimeout(
            () => this.StartPlay(),
            airhockeyConstants.AIRHOCKEY_SERVE_SELECT_DELAY_SEC * 1000
        );
    }

    // GAME_START 를 보내고 물리 루프를 켠 뒤, 3초 뒤 첫 ONE_START 를 예약한다.
    // (시트의 GAME_START 비고 "MAP_SEELCT 전송 후 2초"는 점핑 시트에서 복사된 흔적이다 — 에어하키에는 맵이 없다)
    private StartPlay(): void {
        this.round_timeout = null;
        if (this.game_over) return;

        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.GAME_START, {});
        }

        this.StartSimulation();
        this.round_timeout = this.clock.setTimeout(
            () => this.StartRound(),
            airhockeyConstants.AIRHOCKEY_GAME_START_DELAY_SEC * 1000
        );
    }

    // ONE_START — 한 판(한 골) 시작. 탁구 규칙으로 이번 판의 서브 쪽을 정하고, 퍽을 그 쪽(중앙에서 200)에 멈춘 채로
    // 놓는다(2026-10-29 사용자 결정 — 예전엔 중앙에서 시작해 먼저 친 유저가 선공). 정체 재시작(같은 서버)과 서브 넘김
    // (상대)은 serve_side 로 서버를 직접 정한다 — 그 판에만 적용되고, 다음 골부터는 다시 골 수 기준 탁구 순서다.
    private StartRound(serve_side?: AirhockeySide): void {
        this.round_timeout = null;
        if (this.game_over) return;

        this.serve_side = serve_side ?? airhockeyRules.GetServeSide(this.first_serve_side, this.goals[0], this.goals[1]);
        this.puck = airhockeyRules.CreateServePuck(this.serve_side);
        this.stuck_watch = airhockeyRules.CreateStuckWatch(this.puck);
        this.serve_pending = true;
        // 레버의 이전 궤적은 무시한다 — 지금 자리에 멈춰 세우고, 이 판의 첫 LEVER_MOVE 를 시작 위치로 삼는다(사용자 결정 2026-10-15).
        // 안 하면 골 연출 중 움직이던 속도·목표가 이어져, 판이 시작되자마자 옛 자리에서 끌려온 레버가 퍽을 친다.
        for (const side of [0, 1] as const) {
            airhockeyRules.ResetLeverMotion(this.levers[side]);
            this.lever_awaiting_first_input[side] = true;
        }
        this.round_active = true;
        const payload: AirhockeyOneStartPayload = { serve: this.GetUserid(this.serve_side) };
        for (const room_client of this.clients) {
            messages.SendMessage(this, room_client, types.MessageType.ONE_START, payload);
        }
        // 퍽이 서브 자리에 멈춰 있으면 PUCK_MOVE 가 안 나가므로(바뀐 것만 보냄) 시작 위치를 한 번 바로 보낸다
        this.ForceResendPositions();
        this.SendPuck();
    }

    // LEVER_MOVE (C→S) — 내 레버 위치(내 기준 좌표). 절대 좌표로 바꿔 목표로 정하고, 다음 틱부터 따라간다.
    // 형식이 틀리거나 게임 중이 아니면 조용히 무시한다(로그도 남기지 않는다 — 초당 수십 건이라).
    private HandleLeverMove(client: Client, message: AirhockeyLeverMovePayload): void {
        if (!this.IsGameInProgress()) return;
        if (!airhockeyRules.IsValidPoint(message?.loc)) return;
        const side = this.GetSide(client.sessionId);
        if (side === null) return;

        const point = airhockeyRules.ToSideFrame(message.loc, side);
        if (this.round_active && this.lever_awaiting_first_input[side]) {
            // 이 판의 첫 입력 — 이전 자리에서 끌고 오지 않고 그 좌표에 바로 놓는다(속도 0, StartRound 참고)
            this.lever_awaiting_first_input[side] = false;
            airhockeyRules.SnapLever(this.levers[side], point, Date.now());
            return;
        }
        // 도착 시각을 넘겨 입력 간격을 재게 한다 — 서버 레버가 손 속도 그대로 움직이도록 (SetLeverTarget 주석)
        airhockeyRules.SetLeverTarget(this.levers[side], point, Date.now());
    }

    // --- 물리 루프 ---

    private StartSimulation(): void {
        this.tick_count = 0;
        this.simulation_running = true;
        this.simulation_accumulator_ms = 0;
        // ⚠️ this.clock.setInterval 을 쓰면 안 된다 — 룸 clock 은 patch 주기로만 tick 돼서 16ms 간격이 보장되지 않는다.
        //    setSimulationInterval 은 실제 setInterval 로 돌면서 clock 도 함께 tick 한다.
        if (!this.simulation_loop_created) {
            this.simulation_loop_created = true;
            this.setSimulationInterval((delta_ms) => this.RunSimulationSteps(delta_ms), airhockeyConstants.AIRHOCKEY_TICK_MS);
        }
    }

    // 고정 스텝 누적: 루프가 불릴 때마다 실제로 흐른 시간을 쌓고, AIRHOCKEY_TICK_MS 마다 Tick() 을 한 번씩 돌린다.
    // ⚠️ 루프 한 번 = Tick 한 번으로 두면 안 된다(2026-10-15 버그). Windows 는 타이머 해상도(15.6ms) 때문에 16.7ms
    //    간격이 31ms 로 늘어 실제로는 초당 약 34번만 불린다 — Tick 은 매번 1/60초로 계산하므로 게임 전체가 약 57%
    //    속도의 슬로모션이 됐다(퍽·레버가 느리고, 정체 10초가 실제 17초). Linux 에서도 GC 등으로 밀리면 같은 일이 생긴다.
    private RunSimulationSteps(delta_ms: number): void {
        if (!this.simulation_running) {
            this.simulation_accumulator_ms = 0;
            return;
        }
        this.simulation_accumulator_ms += delta_ms;
        let steps = 0;
        while (
            this.simulation_accumulator_ms >= airhockeyConstants.AIRHOCKEY_TICK_MS &&
            steps < airhockeyConstants.AIRHOCKEY_MAX_CATCHUP_TICKS
        ) {
            this.simulation_accumulator_ms -= airhockeyConstants.AIRHOCKEY_TICK_MS;
            this.Tick();
            steps += 1;
        }
        if (steps === airhockeyConstants.AIRHOCKEY_MAX_CATCHUP_TICKS) {
            this.simulation_accumulator_ms = 0;
        }
    }

    // 물리 계산만 멈춘다. 루프(setSimulationInterval) 자체는 끄지 않는다.
    // ⚠️ setSimulationInterval() 을 콜백 없이 불러 끄면 안 된다(2026-10-15 버그). Colyseus 는 clearInterval 만 하고
    //    내부 핸들(_simulationInterval)을 비우지 않아서, patch 주기의 clock.tick() 도 "시뮬레이션이 돌리겠지" 하고
    //    건너뛴다 → 룸 clock 이 영원히 멈춰 재게임 10초 타이머(clock.setTimeout)가 안 울리고 유저가 방에 계속 머물렀다.
    //    루프는 onDispose 때 Colyseus 가 직접 정리한다.
    private StopSimulation(): void {
        this.simulation_running = false;
    }

    private Tick(): void {
        if (!this.simulation_running) return; // 루프는 계속 돌며 clock 만 tick 한다 (StopSimulation 참고)
        if (this.game_over) return;

        // 봇이 조종하는 레버의 목표를 먼저 정한다 (퍽이 움직이는 판 중에만 — 골 연출 중에는 제자리)
        if (this.round_active) {
            for (const [index, session_id] of [...this.players.keys()].entries()) {
                if (index > 1 || !this.IsBotControlled(session_id)) continue;
                const lever = this.levers[index];
                airhockeyRules.SetLeverTarget(lever, airhockeyRules.ComputeBotTarget(lever, this.puck, TICK_SEC));
            }
        }

        if (this.round_active) {
            const result = airhockeyRules.StepWorld(this.puck, this.levers, TICK_SEC);
            if (result.goal !== null) {
                this.OnGoal(result.goal);
            } else if (this.serve_pending && airhockeyRules.HasPuckLeftServe(this.puck, this.serve_side)) {
                // 서브했다 — 지금부터 퍽 정체를 잰다
                this.serve_pending = false;
                this.stuck_watch = airhockeyRules.CreateStuckWatch(this.puck);
            } else {
                // 서브 전에는 퍽이 서브 자리 반경 안에 있으므로 anchor 가 안 옮겨지고 still_sec = 서브를 기다린 시간이다
                const stuck = airhockeyRules.UpdateStuckWatch(this.stuck_watch, this.puck, TICK_SEC);
                if (this.serve_pending) {
                    if (this.stuck_watch.still_sec >= airhockeyConstants.AIRHOCKEY_SERVE_TIMEOUT_SEC) this.PassServe();
                } else if (stuck) {
                    this.RestartStuckRound();
                }
            }
        } else {
            // 판 사이(골 연출 중)에는 퍽은 멈춰 두고 레버만 따라가게 한다 — 상대 화면에서도 레버는 계속 움직인다
            airhockeyRules.MoveLeversOnly(this.levers, TICK_SEC);
        }

        this.tick_count += 1;
        if (this.tick_count % airhockeyConstants.AIRHOCKEY_SEND_EVERY_TICKS === 0) {
            this.SendPuck();
            this.SendLevers();
        }
    }

    // 퍽이 AIRHOCKEY_STUCK_RESET_SEC 동안 거의 제자리였다 — 레버 사이/구석에 끼었거나 아무도 안 친다.
    // 골 없이 이번 판만 다시 시작한다: 점수는 그대로, 퍽은 중앙에 멈춘 채 ONE_START 부터(사용자 결정 2026-10-15).
    private RestartStuckRound(): void {
        if (this.stuck_restart_count >= airhockeyConstants.AIRHOCKEY_STUCK_MAX_RESTARTS) {
            // 재시작을 다 했는데 또 정체 — 양쪽 다 방치한 것으로 보고 무효 처리한다(사용자 결정 2026-10-15)
            this.InvalidateGame();
            return;
        }
        this.stuck_restart_count += 1;
        console.log(
            `[AirhockeyGameRoom] 퍽이 ${airhockeyConstants.AIRHOCKEY_STUCK_RESET_SEC}초간 제자리 → 이번 판 다시 시작 roomId=${this.roomId} ` +
                `puck=(${Math.round(this.puck.x)},${Math.round(this.puck.y)}) 점수=${this.goals[0]}:${this.goals[1]}`
        );
        this.StartRound(this.serve_side); // 서브는 했으니 같은 유저가 다시 서브한다(서브 넘김으로 바뀐 서버여도 그대로)
    }

    // ONE_START 뒤 AIRHOCKEY_SERVE_TIMEOUT_SEC 동안 서브를 안 했다 — 점수 없이 서브권을 상대에게 넘기고 이번 판을
    // ONE_START 부터 다시 한다. 정체 재시작 횟수에는 넣지 않는다(사용자 결정 2026-10-29 — 양쪽이 계속 안 치면 서브가
    // 끝없이 오간다. 무효는 서브한 뒤의 정체로만 난다).
    private PassServe(): void {
        const next_serve_side: AirhockeySide = this.serve_side === 0 ? 1 : 0;
        console.log(
            `[AirhockeyGameRoom] ${airhockeyConstants.AIRHOCKEY_SERVE_TIMEOUT_SEC}초간 서브 안 함 → 서브권 넘김 roomId=${this.roomId} ` +
                `${this.GetUserid(this.serve_side)} → ${this.GetUserid(next_serve_side)} 점수=${this.goals[0]}:${this.goals[1]}`
        );
        this.StartRound(next_serve_side);
    }

    // 게임 무효 — 즉시 무승부 결과 GAME_RESULT{draw:"Y"} 를 보내고, 일반 결과와 같게 재게임/나가기 선택을 받는다
    // (사용자 결정 2026-10-15 — 별도 알림 메시지 없이 클라이언트는 draw 값으로 결과 화면을 고른다).
    // DB 로그·통계·랭킹은 남기지 않는다(FinishGame 을 거치지 않는다).
    private InvalidateGame(): void {
        if (this.game_over) return;
        this.game_over = true;
        this.round_active = false;
        this.ClearAllTimers();
        console.log(
            `[AirhockeyGameRoom] 퍽 정체 재시작 ${this.stuck_restart_count}회 뒤 또 정체 → 게임 무효 roomId=${this.roomId} ` +
                `점수=${this.goals[0]}:${this.goals[1]}`
        );

        // 재접속 창을 닫는다 — 끊겨 있던 유저는 돌아올 게임이 없다(FinishGame 과 같은 이유)
        for (const sessionId of this.players.keys()) {
            this.reconnection_by_session.get(sessionId)?.reject();
        }

        const result = this.BuildInvalidResult();
        if (result) {
            for (const client of this.clients) {
                messages.SendMessage(this, client, types.MessageType.GAME_RESULT, result);
            }
        }
        // 게임 중 나간 유저가 있으면 일반 결과와 같이 GAME_RESULT 직후 OUT_USER 로 알린다
        this.FlushAbandonedPlayers();
        this.StartReplayWait();
    }

    // 무효 게임의 GAME_RESULT — 승패 없음(draw), winner/loser = player1/player2, 점수 0, win_per 은 이번 게임 미반영.
    private BuildInvalidResult(): AirhockeyGameResultPayload | null {
        const entries = [...this.players.values()];
        const [user_a, user_b] = entries;
        if (!user_a || !user_b) return null;
        const ToInfo = (user: typeof user_a, side: AirhockeySide): AirhockeyGameResultPlayerInfo => ({
            userid: user.userid,
            win_count: this.goals[side],
            score: 0,
            win_per: ComputeWinPer(user.total_win_count, user.total_game_count),
        });
        return { winner: ToInfo(user_a, 0), loser: ToInfo(user_b, 1), draw: "Y" };
    }

    // 퍽 위치나 속도가 바뀌었으면 양쪽에 각자 기준 좌표로 보낸다.
    // ⚠️ 위치가 그대로여도 "멈춤"(vel 0)은 꼭 보내야 한다 — 안 보내면 클라이언트가 마지막 vel 로 계속 예측해 간다.
    private SendPuck(): void {
        const rounded = airhockeyRules.RoundPoint(this.puck);
        const rounded_vel = airhockeyRules.RoundPoint({ x: this.puck.vx, y: this.puck.vy });
        if (SamePoint(this.last_sent_puck, rounded) && SamePoint(this.last_sent_puck_vel, rounded_vel)) return;
        this.last_sent_puck = rounded;
        this.last_sent_puck_vel = rounded_vel;

        for (const client of this.clients) {
            const side = this.GetSide(client.sessionId);
            if (side === null) continue;
            const payload: AirhockeyPuckMovePayload = {
                loc: airhockeyRules.ToSideFrame(rounded, side),
                vel: airhockeyRules.ToSideFrame(rounded_vel, side),
            };
            messages.SendMessage(this, client, types.MessageType.PUCK_MOVE, payload);
        }
    }

    // 레버 위치가 바뀌었으면 **주인이 아닌 쪽**에 보낸다(주인은 자기 손가락 위치를 이미 안다).
    // 봇이 조종하는 레버도 같은 경로로 남은 유저에게 간다.
    private SendLevers(): void {
        const entries = [...this.players.entries()];
        for (const side of [0, 1] as const) {
            const owner = entries[side];
            if (!owner) continue;
            const [owner_session, owner_user] = owner;

            const rounded = airhockeyRules.RoundPoint(this.levers[side]);
            if (SamePoint(this.last_sent_lever[side], rounded)) continue;
            this.last_sent_lever[side] = rounded;

            for (const client of this.clients) {
                if (client.sessionId === owner_session) continue;
                const client_side = this.GetSide(client.sessionId);
                if (client_side === null) continue;
                const payload: AirhockeyLeverMoveResultPayload = {
                    user: owner_user.userid,
                    loc: airhockeyRules.ToSideFrame(rounded, client_side),
                };
                messages.SendMessage(this, client, types.MessageType.LEVER_MOVE, payload);
            }
        }
    }

    private ForceResendPositions(): void {
        this.last_sent_puck = null;
        this.last_sent_puck_vel = null;
        this.last_sent_lever[0] = null;
        this.last_sent_lever[1] = null;
    }

    // 골! side = 골을 넣은 쪽. ONE_RESULT 를 보내고, 3골이면 게임을 끝내고 아니면 다음 판을 예약한다.
    private OnGoal(side: AirhockeySide): void {
        this.round_active = false;
        this.goals[side] += 1;
        this.stuck_restart_count = 0; // 게임이 진행됐다 — 정체 재시작 횟수는 "연달아" 기준이다

        const scorer_entry = [...this.players.entries()][side];
        if (!scorer_entry) return; // 좌석은 게임 중 비지 않으므로 정상 흐름에서는 없다
        const [, scorer] = scorer_entry;
        const elapsed_sec = this.game_started_at ? Math.round((Date.now() - this.game_started_at.getTime()) / 1000) : 0;
        this.plays.push({ userid: scorer.userid, sec: elapsed_sec });
        console.log(`[AirhockeyGameRoom] 골 roomId=${this.roomId} userid=${scorer.userid} 점수=${this.goals[0]}:${this.goals[1]}`);

        // 퍽이 골대 안으로 들어간 마지막 위치를 먼저 보내고 결과를 알린다
        this.SendPuck();
        const payload: AirhockeyOneResultPayload = { win: scorer.userid, win_count: this.goals[side] };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.ONE_RESULT, payload);
        }

        if (airhockeyRules.IsWinningGoals(this.goals[side])) {
            this.RequestFinish();
            return;
        }
        this.round_timeout = this.clock.setTimeout(
            () => this.StartRound(),
            airhockeyConstants.AIRHOCKEY_ONE_RESULT_DELAY_SEC * 1000
        );
    }

    // 마지막 골 뒤 AIRHOCKEY_RESULT_DELAY_SEC(3초) 를 기다렸다가 GAME_RESULT 를 보낸다 — 마지막 골 연출 시간.
    // ⚠️ 기다리는 동안은 game_over=false(아직 진행 중)로 둔다. 그 사이 나간 유저도 게임 중 퇴장 규칙
    //    (좌석 유지 → GAME_RESULT 직후 OUT_USER, is_bot 기록)을 그대로 따르게 하기 위해서다 (점핑과 같은 이유).
    // 결과를 볼 클라이언트가 없으면 기다리지 않는다.
    private RequestFinish(): void {
        if (this.game_over || this.finish_timeout) return;
        this.round_active = false;
        this.ClearRoundTimer();

        if (this.clients.length === 0) {
            void this.FinishGame();
            return;
        }
        this.finish_timeout = this.clock.setTimeout(() => {
            this.finish_timeout = null;
            void this.FinishGame();
        }, airhockeyConstants.AIRHOCKEY_RESULT_DELAY_SEC * 1000);
    }

    // 게임 중 한 명이 최종 퇴장했을 때.
    private OnPlayerAbandonedMidGame(session_id: string): void {
        console.log(`[AirhockeyGameRoom] 게임 중 퇴장 → 봇 조종 roomId=${this.roomId} sessionId=${session_id}`);

        // 둘 다 나가 버렸으면 결과를 볼 사람이 아무도 없다 — 봇끼리 끝까지 두지 않고 지금 골 수로 끝낸다
        // (골 수가 같으면 무승부). 마지막 골 연출 대기(finish_timeout) 중이었어도 바로 끝낸다.
        // ⚠️ 판정은 오델로/점핑과 같다: clients 가 0 이고 **재접속 대기 중인 세션도 없어야** 한다.
        if (this.clients.length === 0 && this.reconnection_by_session.size === 0) {
            console.log(`[AirhockeyGameRoom] 남은 유저 없음 → 현재 점수로 종료 roomId=${this.roomId}`);
            void this.FinishGame();
        }
        // 한 명이 남아 있으면 봇과 계속 겨룬다. 나간 유저의 골과 결과는 그대로 그 유저에게 반영된다.
    }

    private ClearRoundTimer(): void {
        this.round_timeout?.clear();
        this.round_timeout = null;
    }

    // 물리 루프 + 판 타이머 + 결과 연출 대기 타이머까지 모두 멈춘다 (FinishGame / ResetGameState 용).
    private ClearAllTimers(): void {
        this.StopSimulation();
        this.ClearRoundTimer();
        this.finish_timeout?.clear();
        this.finish_timeout = null;
    }

    // --- 게임 종료 ---

    // 골이 많은 쪽 승리, 같으면 무승부(둘 다 나가서 중간에 끝났을 때만 생긴다).
    // 게임 중 나간 유저도 **그대로 참가자로 집계한다** — 결과는 그 유저의 승패/통계/랭킹에도 반영된다.
    private async FinishGame(): Promise<void> {
        if (this.game_over) return;
        this.game_over = true;
        this.round_active = false;
        this.ClearAllTimers();

        const sessions = [...this.players.keys()];

        // 재접속 창을 닫는다 — 재접속은 "게임이 끝날 때까지"만 유효하다.
        // 안 닫으면 "manual" 모드라 그 좌석이 영원히 예약된 채로 남아 방이 정리되지 않는다.
        for (const sessionId of sessions) {
            this.reconnection_by_session.get(sessionId)?.reject();
        }

        const [session_a, session_b] = sessions;
        const user_a = session_a !== undefined ? this.players.get(session_a) : undefined;
        const user_b = session_b !== undefined ? this.players.get(session_b) : undefined;
        if (!user_a || !user_b || session_a === undefined || session_b === undefined) {
            // 좌석 정보가 비어 결과를 만들 수 없다 — 게임 중 퇴장은 좌석을 비우지 않으므로 정상 흐름에서는
            // 여기 오지 않는다. 재게임 선택만 받고 끝낸다.
            console.error(`[AirhockeyGameRoom] 게임 종료 시 플레이어 정보 없음 roomId=${this.roomId}`);
            this.FlushAbandonedPlayers();
            this.StartReplayWait();
            return;
        }

        const winner_side = airhockeyRules.DecideWinner(this.goals[0], this.goals[1]);
        const is_draw = winner_side === null;
        // 무승부면 winner/loser 자리에 입장 순서대로 담는다 (오델로와 같은 관례)
        const w: AirhockeySide = winner_side ?? 0;
        const l: AirhockeySide = w === 0 ? 1 : 0;
        const winner_session = w === 0 ? session_a : session_b;
        const loser_session = w === 0 ? session_b : session_a;
        const winner_user = w === 0 ? user_a : user_b;
        const loser_user = w === 0 ? user_b : user_a;
        const winner_goals = this.goals[w];
        const loser_goals = this.goals[l];

        const winner_is_bot = this.bot_sessions.has(winner_session);
        const loser_is_bot = this.bot_sessions.has(loser_session);

        // win_per 은 이번 게임 결과가 반영된 값이다 — DB 저장 완료를 기다리지 않고 메모리 값에 즉시 더한다.
        const winner_info: AirhockeyGameResultPlayerInfo = {
            userid: winner_user.userid,
            win_count: winner_goals,
            score: airhockeyRules.ComputeRankScore(winner_goals),
            win_per: ComputeWinPer(winner_user.total_win_count + (is_draw ? 0 : 1), winner_user.total_game_count + 1),
        };
        const loser_info: AirhockeyGameResultPlayerInfo = {
            userid: loser_user.userid,
            win_count: loser_goals,
            score: airhockeyRules.ComputeRankScore(loser_goals),
            win_per: ComputeWinPer(loser_user.total_win_count, loser_user.total_game_count + 1),
        };
        const payload: AirhockeyGameResultPayload = {
            winner: winner_info,
            loser: loser_info,
            draw: is_draw ? "Y" : "N",
        };
        for (const client of this.clients) {
            messages.SendMessage(this, client, types.MessageType.GAME_RESULT, payload);
        }

        // 게임 중 나간 유저가 있으면 **이제** 남은 유저에게 알린다. GAME_RESULT 를 먼저 보내야 한다.
        this.FlushAbandonedPlayers();

        this.StartReplayWait();

        try {
            const result = await airhockeyGameResultRepository.SaveAirhockeyGameResult({
                winner_userid: winner_user.userid,
                loser_userid: loser_user.userid,
                winner_goals,
                loser_goals,
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
            console.error(`[AirhockeyGameRoom] 게임 결과 저장 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
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
            airhockeyConstants.AIRHOCKEY_REMATCH_CHOICE_TIMEOUT_SEC * 1000
        );
    }

    // GAME_RESULT (C→S) — 재게임 여부 응답. replay:"N" 은 상대 응답을 기다리지 않고 이 유저만 바로 내보낸다.
    private HandleReplay(client: Client, message: AirhockeyReplayPayload): void {
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
            // 둘 다 재게임 — 같은 방, 같은 상대로 새 게임 시작 (SERVE_SELECT 부터, READY 는 다시 안 받음).
            // 첫 서브는 탁구처럼 교대한다 — 직전 게임에서 리시브로 시작한 쪽 (좌석 순서는 그대로라 side 도 같다)
            const next_first_serve_side: AirhockeySide = this.first_serve_side === 0 ? 1 : 0;
            this.ResetGameState();
            this.next_first_serve_side = next_first_serve_side;
            this.StartGame();
        } else if (replaying_sessions.length === 1) {
            this.WaitForNewOpponent(replaying_sessions[0]);
        }
        // 0 이면 남은 유저도 위 루프로 이미 정리됐다 — 방은 비면서 자동 정리(dispose)됨
    }

    // 한 게임 상태를 초기화한다 (같은 상대와의 재게임, 새 상대와의 재매칭 둘 다에서 쓴다)
    private ResetGameState(): void {
        this.round_active = false;
        this.goals[0] = 0;
        this.goals[1] = 0;
        // 새 상대와의 게임은 동전 던지기부터 — 같은 상대 재게임은 ResolveReplay 가 이 뒤에 다시 정한다
        this.next_first_serve_side = null;
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
    // ⚠️ 남은 유저는 Map 의 첫 번째가 되므로 새 게임에서는 player1(아래쪽 side 0)이 된다.
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
            console.error(`[AirhockeyGameRoom] PushWaitingRoom 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        });
    }
}
