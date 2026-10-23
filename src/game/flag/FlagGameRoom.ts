// 청기백기(flag) 게임이 진행되는 모듈 (1인, 2026-10-22 추가).
// 와이어 프로토콜은 `멀티게임_바이브.xlsx` 의 `flag` 시트가 기준이다.
//
// 흐름: ENTER_ROOM → READY → GAME_START → (ONE_START → QUEST_SHOW → 5초 안에 답 한 번 → ONE_RESULT) × 5 → GAME_RESULT
//       → 재게임(같은 방에서 GAME_START 부터) / 나가기(RETURN_TO_LOBBY)
//
// 2인 게임(SteppingGameRoom 등)과 다른 점 — 혼자 하는 게임이라 플랫폼 공통부 중 상대와 관련된 것이 모두 없다:
//   - 상대 기다리기(좌석 2개), OUT_USER, OPPONENT_JOINED, "기다리는 방"이 없다
//   - ⚠️ **재접속이 없다**(사용자 결정: "게임 중 퇴장시 현재 점수 저장, 방은 없앤다"). onDrop 을 두지 않아
//     끊김(탭 닫기·네트워크·F5)도 명시적 나가기와 똑같이 곧장 onLeave 로 온다. activeGame 기록도 남기지
//     않으므로 로비가 REJOIN_GAME 을 보내지 않는다. 마지막 클라이언트가 나가면 Colyseus autoDispose 로 방이 사라진다.
//   - 게임 중 나가면 그때까지 맞춘 점수로 결과를 저장한다(못 푼 문제는 틀린 것으로 센다)

import { Room, CloseCode, type Client, type Delayed } from "@colyseus/core";
import * as constants from "../../common/constants.js";
import * as log from "../../common/log.js";
import * as messages from "../../common/messages.js";
import * as types from "../../common/types.js";
import type { AdminChannelUserEntry, EnterRoomPayload, GameSeatAuth, ReadyPayload, RoomPlayerInfo, UserInfo } from "../../common/types.js";
import * as roomRegistry from "../../common/roomRegistry.js";
import * as flagConstants from "./flagConstants.js";
import * as flagRules from "./flagRules.js";
import type {
    FlagAnswer,
    FlagAnswerPayload,
    FlagGameResultPayload,
    FlagOneResultPayload,
    FlagOneStartPayload,
    FlagPlayRecord,
    FlagQuest,
    FlagQuestShowPayload,
    FlagReplayPayload,
    FlagSay,
} from "./flagTypes.js";
import * as flagGameResultRepository from "../../db/flagGameResultRepository.js";
import * as userCache from "../../db/userCache.js";

function ToRoomPlayerInfo(user: UserInfo): RoomPlayerInfo {
    return {
        userid: user.userid,
        name: user.name,
        avatar: user.avatar,
        win_per: flagRules.ComputeWinPer(user.total_win_count, user.total_game_count),
    };
}

export class FlagGameRoom extends Room {
    maxClients = 1;

    // --- 플랫폼 공통 상태 (혼자라 세션 하나만 든다) ---

    // 좌석 예약에 담겨 온 유저 정보와 그 세션. 게임 중 나가도 결과 저장이 끝날 때까지 user 는 남겨 둔다.
    private player_session: string | null = null;
    private player: UserInfo | null = null;
    private enter_room_sent = false;
    // READY 를 받아 첫 GAME_START 를 보낸 순간부터 true (재게임 때도 유지)
    private game_started = false;
    private game_over = false;
    private game_started_at: Date | null = null;
    private replay_timeout: Delayed | null = null;
    private kicked_to_lobby = false;

    // --- 청기백기 전용 상태 ---

    // 지금 몇 번째 문제인지(1부터). GAME_START 직후엔 0.
    private quest_no = 0;
    // 지금 문제. QUEST_SHOW 를 보내기 전·판정 뒤에는 null — 이때 온 답은 무시한다.
    private quest: FlagQuest | null = null;
    // 바로 앞 문제 (같은 문제가 연달아 나오지 않게)
    private previous_quest: FlagQuest | null = null;
    // 지금 문제의 문구 코드 (2026-10-23 추가). quest 와 함께 ShowQuest 에서 정한다.
    // 정지 버튼 추가(2026-10-23) 뒤로는 **판정 기준**이다(flagRules.IsCorrect).
    private say: FlagSay = { b: "", w: "" };
    // 지금 문제에 대한 누적 답 (flagRules.MergeAnswer)
    // → 2026-10-23 누적 폐지: 처음 온 답 하나(없으면 시간 초과 = 둘 다 null)
    private answer: FlagAnswer = flagRules.EmptyAnswer();
    private correct_count = 0;
    // 이번 게임에서 판정한 문제 기록 — DB 로그(flag_game_log.plays)에 쓴다. StartGame 마다 비운다.
    private readonly plays: FlagPlayRecord[] = [];
    // 다음 단계 예약 타이머 하나만 쓴다 — ONE_START/QUEST_SHOW/답 제한 시간/다음 문제/결과 대기가 차례로 이어진다
    private step_timeout: Delayed | null = null;

    public onCreate(): void {
        // 이름/roomId 로 직접 들어올 수 없게 잠근다 — 예약된 좌석으로만 입장 가능
        this.lock();
        console.log(`[FlagGameRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

        // SEND_NOTICE 브로드캐스트 + 채널 유저 리포터 + 무중단 재시작 드레인이 이 방을 찾을 수 있도록 등록
        roomRegistry.RegisterRoom(this, () => this.GetChannelUserEntries(), () => this.IsGameInProgress());

        // 좌석 예약 후 SEAT_RESERVATION_SEC 안에 안 들어오면 정리한다
        this.clock.setTimeout(() => this.CheckSeatFillTimeout(), constants.SEAT_RESERVATION_SEC * 1000);

        log.RegisterLoggedMessage(this, types.MessageType.ENTER_ROOM, (client) => {
            this.HandleEnterRoom(client);
        });
        log.RegisterLoggedMessage<ReadyPayload>(this, types.MessageType.READY, (client, message) => {
            this.HandleReady(client, message);
        });
        log.RegisterLoggedMessage<FlagAnswerPayload>(this, types.MessageType.QUEST_SHOW, (client, message) => {
            this.HandleAnswer(client, message);
        });
        log.RegisterLoggedMessage<FlagReplayPayload>(this, types.MessageType.GAME_RESULT, (client, message) => {
            this.HandleReplay(client, message);
        });
    }

    public onJoin(client: Client, _options: unknown, auth?: GameSeatAuth): void {
        if (!auth?.user) {
            // 정상 흐름이라면 항상 GameRoomMatcher 가 좌석 예약에 유저 정보를 담아 보낸다.
            console.error(`[FlagGameRoom] auth.user 없이 입장 시도 sessionId=${client.sessionId}`);
            client.leave(CloseCode.WITH_ERROR);
            return;
        }

        this.player_session = client.sessionId;
        this.player = auth.user;
        log.LogConnect(this, client, { userid: auth.user.userid });
    }

    // 재접속이 없으므로(onDrop 없음) 끊김·명시적 나가기 모두 여기로 바로 온다.
    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        if (client.sessionId !== this.player_session) return; // 좌석 주인이 아닌 연결 (정상 흐름에서는 없다)

        const user = this.player;
        if (user) {
            // 게임방을 떠날 때도 로비와 같은 규칙 — 값을 새로 쓰지 않고 TTL 만 갱신
            userCache.GetUserCache(user.userid)
                .then((cached) => (cached ? userCache.TouchUserCache(cached) : undefined))
                .catch((error) => {
                    console.error(`[FlagGameRoom] TouchUserCache 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
                });
        }

        if (this.IsGameInProgress()) {
            // 게임 중 퇴장 — 그때까지 맞춘 점수로 저장한다. 결과를 받을 사람이 없으니 GAME_RESULT 는 보내지 않는다.
            console.log(`[FlagGameRoom] 게임 중 퇴장 → 현재 점수로 저장 roomId=${this.roomId} correct=${this.correct_count}`);
            void this.FinishGame(true);
        }
        this.ClearAllTimers();
        // 방은 비면서 Colyseus autoDispose 로 사라진다 (FinishGame 의 DB 저장은 그와 상관없이 끝까지 돈다)
    }

    public onDispose(): void {
        roomRegistry.UnregisterRoom(this);
        console.log(`[FlagGameRoom] 제거됨 roomId=${this.roomId}`);
    }

    // ADMIN_CHANNEL_USER 용 — 지금 이 방에 있는 유저
    public GetChannelUserEntries(): AdminChannelUserEntry[] {
        if (!this.player || this.clients.length === 0) return [];
        return [{ userid: this.player.userid, room: this.roomId }];
    }

    // 무중단 재시작 드레인용 — 지금 실제로 게임이 진행 중인지
    public IsGameInProgress(): boolean {
        return this.game_started && !this.game_over;
    }

    private CheckSeatFillTimeout(): void {
        if (this.clients.length > 0) return; // 정상 — 들어옴
        this.disconnect(CloseCode.WITH_ERROR);
    }

    // ENTER_ROOM (C→S) — 로딩 등 준비를 마치면 보낸다. 혼자라 바로 응답한다(player2 생략).
    // 다시 보내도 같은 응답을 다시 준다 (2인 게임과 같은 규칙).
    private HandleEnterRoom(client: Client): void {
        if (!this.player || client.sessionId !== this.player_session) return;
        this.enter_room_sent = true;
        const payload: EnterRoomPayload = {
            result: "Y",
            room: this.roomId,
            player1: ToRoomPlayerInfo(this.player),
        };
        messages.SendMessage(this, client, types.MessageType.ENTER_ROOM, payload);
    }

    private HandleReady(client: Client, message: ReadyPayload): void {
        if (message?.ready !== "Y") return; // ready:"N" 은 혼자라 의미가 없다 — 무시
        if (client.sessionId !== this.player_session || !this.enter_room_sent) return;
        if (this.game_started) return;

        this.game_started = true;
        this.StartGame();
    }

    // GAME_START 를 보내고 첫 문제를 예약한다. 최초 시작(HandleReady)과 재게임(ResolveReplay) 둘 다 여기를 쓴다.
    private StartGame(): void {
        this.game_over = false;
        this.game_started_at = new Date();
        this.quest_no = 0;
        this.quest = null;
        this.previous_quest = null;
        this.answer = flagRules.EmptyAnswer();
        this.correct_count = 0;
        this.plays.length = 0;

        this.SendToPlayer(types.MessageType.GAME_START, {});
        this.ScheduleStep(() => this.StartQuest(), flagConstants.FLAG_GAME_START_DELAY_SEC);
    }

    // ONE_START — 한 문제 시작. FLAG_QUEST_SHOW_DELAY_SEC 뒤 QUEST_SHOW 로 문제를 낸다.
    private StartQuest(): void {
        this.quest_no += 1;
        const payload: FlagOneStartPayload = { no: this.quest_no, total: flagConstants.FLAG_QUEST_COUNT };
        this.SendToPlayer(types.MessageType.ONE_START, payload);
        this.ScheduleStep(() => this.ShowQuest(), flagConstants.FLAG_QUEST_SHOW_DELAY_SEC);
    }

    // QUEST_SHOW (S→C) — 문제를 내고 답 제한 시간(5초)을 건다. 시간이 끝나면 그때까지의 답으로 판정한다.
    private ShowQuest(): void {
        const quest = flagRules.CreateQuest(this.previous_quest);
        const say = flagRules.CreateSay(quest);
        this.quest = quest;
        this.say = say;
        this.answer = flagRules.EmptyAnswer();

        const payload: FlagQuestShowPayload = { quest, say, time: flagConstants.FLAG_ANSWER_TIME_SEC };
        this.SendToPlayer(types.MessageType.QUEST_SHOW, payload);
        this.ScheduleStep(() => this.JudgeQuest(), flagConstants.FLAG_ANSWER_TIME_SEC);
    }

    // QUEST_SHOW (C→S) — 답. 누적하고, 정답이 됐거나 이미 틀렸으면 제한 시간을 기다리지 않고 바로 판정한다.
    // 문제가 없을 때(판정 뒤·다음 문제 전) 온 답과 형식이 틀린 답은 조용히 무시한다 — 시트에 실패 응답이 없다.
    // 2026-10-23 사용자 변경(정지 버튼 추가): 누적하지 않고 **처음 온 답 하나로 즉시 판정**한다. 클라이언트가
    // 문제에 나온 깃발의 버튼을 모두 받아 한 번에 보낸다. 판정 뒤 온 답은 quest === null 이라 무시된다.
    private HandleAnswer(client: Client, message: FlagAnswerPayload): void {
        if (client.sessionId !== this.player_session || !this.IsGameInProgress() || this.quest === null) return;
        const answer = flagRules.ReadAnswer(message?.quest);
        if (!answer) {
            console.warn(`[FlagGameRoom] QUEST_SHOW 형식 오류 무시 roomId=${this.roomId}`);
            return;
        }

        this.answer = answer;
        this.JudgeQuest();
    }

    // ONE_RESULT — 지금 문제를 판정한다. 마지막 문제였으면 FLAG_RESULT_DELAY_SEC 뒤 GAME_RESULT, 아니면 다음 문제.
    private JudgeQuest(): void {
        const quest = this.quest;
        if (quest === null) return; // 제한 시간과 답이 겹쳐도 한 번만
        this.quest = null;
        this.previous_quest = quest;
        this.step_timeout?.clear();
        this.step_timeout = null;

        const correct = flagRules.IsCorrect(this.say, this.answer);
        if (correct) this.correct_count += 1;
        const result = correct ? "Y" : "N";
        this.plays.push({ quest, say: { ...this.say }, answer: { ...this.answer }, result });

        const payload: FlagOneResultPayload = {
            quest: result,
            score: flagRules.ComputeScore(this.correct_count),
            answer: { ...this.answer },
        };
        this.SendToPlayer(types.MessageType.ONE_RESULT, payload);

        if (this.quest_no >= flagConstants.FLAG_QUEST_COUNT) {
            // 시트: "마지막 문제 출제 후 3초 경과하고 전달". 이 3초 동안은 아직 게임 중이다 —
            // 그 사이 나가도 게임 중 퇴장 규칙(현재 점수 = 5문제 모두 판정된 점수로 저장)을 그대로 따른다.
            this.ScheduleStep(() => void this.FinishGame(false), flagConstants.FLAG_RESULT_DELAY_SEC);
            return;
        }
        this.ScheduleStep(() => this.StartQuest(), flagConstants.FLAG_ONE_RESULT_DELAY_SEC);
    }

    // 게임을 끝내고 결과를 저장한다. is_quit = 게임 중 나가서 끝났다(결과를 받을 사람이 없다).
    private async FinishGame(is_quit: boolean): Promise<void> {
        if (this.game_over) return;
        this.game_over = true;
        this.quest = null;
        this.step_timeout?.clear();
        this.step_timeout = null;

        const user = this.player;
        if (!user) {
            console.error(`[FlagGameRoom] 게임 종료 시 플레이어 정보 없음 roomId=${this.roomId}`);
            return;
        }

        const correct_count = this.correct_count;
        const score = flagRules.ComputeScore(correct_count);
        if (!is_quit) {
            // win_per 은 이번 게임 결과가 반영된 값이다 — DB 저장 완료를 기다리지 않고 메모리 값에 즉시 더한다.
            const payload: FlagGameResultPayload = {
                score,
                correct_count,
                win_per: flagRules.ComputeWinPer(user.total_win_count + correct_count, user.total_game_count + 1),
            };
            this.SendToPlayer(types.MessageType.GAME_RESULT, payload);
            this.StartReplayWait();
        }

        try {
            const updated_user = await flagGameResultRepository.SaveFlagGameResult({
                userid: user.userid,
                score,
                correct_count,
                quest_count: this.plays.length,
                start_time: this.game_started_at ?? new Date(),
                end_time: new Date(),
                // ⚠️ 스냅샷(복사본)을 넘긴다 — 저장이 끝나기 전에 재게임으로 StartGame() 이 다시 불리면
                // this.plays 가 즉시 비워진다(RpsGameRoom 에서 실제로 겪은 버그).
                plays: [...this.plays],
                is_quit,
            });
            // 재게임할 때 정답률에 반영되도록 메모리 값도 최신으로 바꾼다 (그 사이 나갔으면 상관없다)
            if (this.player?.userid === updated_user.userid) this.player = updated_user;
        } catch (error) {
            console.error(`[FlagGameRoom] 게임 결과 저장 실패 roomId=${this.roomId}:`, error instanceof Error ? error.message : error);
        }
    }

    // 재게임/나가기 선택을 기다린다 (DB 저장을 기다리지 않고 먼저 시작한다). 10초 무응답 = 나가기.
    private StartReplayWait(): void {
        this.replay_timeout = this.clock.setTimeout(() => this.ResolveReplay(false), flagConstants.FLAG_REMATCH_CHOICE_TIMEOUT_SEC * 1000);
    }

    // GAME_RESULT (C→S) — 재게임 여부 응답
    private HandleReplay(client: Client, message: FlagReplayPayload): void {
        if (client.sessionId !== this.player_session || !this.game_over || !this.replay_timeout) return;
        if (message?.replay !== "Y" && message?.replay !== "N") return;
        this.ResolveReplay(message.replay === "Y");
    }

    // 재게임이면 같은 방에서 GAME_START 부터 다시(READY 는 다시 안 받음), 아니면 로비로 보낸다.
    private ResolveReplay(replay: boolean): void {
        if (!this.replay_timeout) return; // 이미 처리됨 (타임아웃과 응답이 겹친 경우)
        this.replay_timeout.clear();
        this.replay_timeout = null;

        if (replay) {
            this.StartGame();
            return;
        }
        const client = this.clients.find((c) => c.sessionId === this.player_session);
        if (client) this.KickToLobby(client);
    }

    // RETURN_TO_LOBBY 를 보내고 연결을 끊는다. 두 번 호출돼도 안전하다.
    private KickToLobby(client: Client): void {
        if (this.kicked_to_lobby) return;
        this.kicked_to_lobby = true;
        messages.SendMessage(this, client, types.MessageType.RETURN_TO_LOBBY, {});
        client.leave(CloseCode.CONSENTED);
    }

    private SendToPlayer(type: types.MessageType, payload: unknown): void {
        const client = this.clients.find((c) => c.sessionId === this.player_session);
        if (client) messages.SendMessage(this, client, type, payload);
    }

    // 다음 단계를 sec 초 뒤에 예약한다 — 예약은 항상 하나뿐이다(이전 예약은 지운다).
    private ScheduleStep(callback: () => void, sec: number): void {
        this.step_timeout?.clear();
        this.step_timeout = this.clock.setTimeout(() => {
            this.step_timeout = null;
            callback();
        }, sec * 1000);
    }

    private ClearAllTimers(): void {
        this.step_timeout?.clear();
        this.step_timeout = null;
        this.replay_timeout?.clear();
        this.replay_timeout = null;
    }
}
