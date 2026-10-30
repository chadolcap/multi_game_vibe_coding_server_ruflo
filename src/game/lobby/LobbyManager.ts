// 로비 접속 유저 정보 처리 — 클라이언트-서버 통신 문서 기준
// https://docs.google.com/spreadsheets/d/1zmxIhBU8UsEiI4cFFBs94Y4gNfsl1QbINjZMGQwNzBQ
// LobbyRoom 은 소켓 이벤트만 받고, 실제 처리는 이 클래스에 맡긴다.
// 채널(로비 룸)당 1개씩 만들어진다 — waiting 목록은 "이 채널에서 로비 대기 중인 유저"만 추적한다.
// (CLAUDE.md 흐름 12번: 다른 채널과의 중복은 아직 막지 않는다 — Phase 4 이후 게임 중 여부까지 포함해 범위를 넓힐 수 있다)

import type { Client, Room } from "@colyseus/core";
import { CloseCode } from "@colyseus/core";
import * as channelNames from "../../common/channelNames.js";
import type { GameType } from "../../common/channelNames.js";
import * as constants from "../../common/constants.js";
import * as log from "../../common/log.js";
import * as messages from "../../common/messages.js";
import * as nameFilter from "../../common/nameFilter.js";
import * as types from "../../common/types.js";
import type {
    AdViewCompleteResultPayload,
    EnterLobbyPayload,
    EnterLobbyResultPayload,
    JoinMatchPayload,
    MatchFoundPayload,
    NamePayload,
    PlayInfoPayload,
    PlayInfoResultPayload,
    RankDailyResultPayload,
    RankListEntry,
    RankPayload,
    RankWeeklyResultPayload,
    RejoinGamePayload,
    UserInfo,
} from "../../common/types.js";
// ⚠️ 이 파일은 지역 변수로 "userid" 를 많이 쓰기 때문에, common/userid.js 모듈의 import alias 는
// 관례(파일명 그대로)를 따르지 않고 "useridUtils" 로 바꿔서 섀도잉(가려짐)을 피한다.
import * as useridUtils from "../../common/userid.js";
import * as userRepository from "../../db/userRepository.js";
import * as adRepository from "../../db/adRepository.js";
import * as userCache from "../../db/userCache.js";
import * as playInfoRepository from "../../db/playInfoRepository.js";
import * as rankingRepository from "../../db/rankingRepository.js";
import type { RankEntry } from "../../db/types.js";
import * as activeGame from "../room/activeGame.js";
import { GameRoomMatcher, TryReconnectToGame } from "../room/GameRoomMatcher.js";
import * as gameRoomMatcher from "../room/GameRoomMatcher.js";

// 실제 게임 종류 목록 — 오델로 등을 추가하면 common/channelNames.ts 의 ALL_GAME_TYPES 에 하나 더하고
// 아래 CreateMatchersByGame 에도 추가한다 (2026-10-02 "게임별 분리 구조").
// 2026-10-07: 목록 자체는 channelNames.ts 로 옮겼다 — WatcherManager 도 같은 화이트리스트가 필요해서다.
const ALL_GAME_TYPES: GameType[] = channelNames.ALL_GAME_TYPES;

// 게임 종류별로 GameRoomMatcher 인스턴스를 하나씩 만든다 — 각자 자기 게임의 채널 포트/채널수만 안다.
// 채널수는 channelNames.GetGameChannelCount() 가 게임별 상수를 골라 주므로, 게임을 추가할 때
// ALL_GAME_TYPES 에만 더하면 여기는 그대로 둬도 된다(2026-10-07 오델로 추가 때 일반화).
function CreateMatchersByGame(): Map<GameType, GameRoomMatcher> {
    return new Map<GameType, GameRoomMatcher>(
        ALL_GAME_TYPES.map((game) => [game, new GameRoomMatcher(game, channelNames.GetGameChannelCount(game))])
    );
}

// RankEntry(DB 조회 결과, { rank, userid, name, score }) → 문서 payload 형식인 [name, score] 튜플로 변환
function ToRankListEntries(entries: RankEntry[]): RankListEntry[] {
    return entries.map((entry): RankListEntry => [entry.name, entry.score]);
}

function IsEnterLobbyShape(payload: unknown): payload is EnterLobbyPayload {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as Record<string, unknown>;
    return (
        typeof p.partner === "string" &&
        typeof p.mid === "string" &&
        typeof p.gender === "string" &&
        typeof p.phone === "string"
    );
}

function IsValidEnterLobbyFields(payload: EnterLobbyPayload): boolean {
    return (
        useridUtils.IsValidPartner(payload.partner) &&
        useridUtils.IsValidMid(payload.mid) &&
        useridUtils.IsValidGender(payload.gender) &&
        useridUtils.IsValidPhone(payload.phone)
    );
}

// 1차 구현은 파트너사 토큰 검증이 없다. 나중에 토큰 검증을 추가할 때 이 함수 안만 채우면 된다.
// (반환값이 false 면 인증 실패로 처리 — 지금은 항상 통과)
async function VerifyAuth(_payload: EnterLobbyPayload): Promise<boolean> {
    return true;
}

export class LobbyManager {
    constructor(private readonly room: Room) {}

    // userid → 대기 중인 클라이언트 + 유저 정보 (같은 유저가 이 채널에 중복 접속하는 것을 막고,
    // 매칭할 때 DB/Redis 조회 없이 바로 쓸 수 있게 유저 정보도 함께 들고 있는다)
    private readonly waiting_by_userid = new Map<string, { client: Client; user: UserInfo }>();
    // sessionId → userid (연결이 끊겼을 때 waiting_by_userid 에서 지우기 위한 역방향 조회)
    private readonly userid_by_session = new Map<string, string>();
    // "게임 참여"를 누르고 매칭을 기다리는 userid 목록 (도착한 순서대로) — 게임마다 큐가 따로다
    // (2026-10-02 "게임별 분리 구조" — 가위바위보 대기자가 오델로 매칭에 섞이면 안 되므로).
    private readonly match_queue_by_game = new Map<GameType, string[]>(ALL_GAME_TYPES.map((g) => [g, []]));
    private readonly matchers_by_game = CreateMatchersByGame();

    // ENTER_LOBBY 처리. 문서 기준(2026-09-30 갱신): 결과는 같은 type(ENTER_LOBBY)으로 응답하되,
    // 성공하면 { result:"Y", userid, new, name, avatar } 를 한 번에 보낸다(예전 LOBBY_ENTERED 는 폐지 —
    // 그 필드들이 이 응답에 합쳐졌다). 이 세션이 "새로 입장 성공"했으면 true 를 반환한다
    // (Room 이 10초 타임아웃 타이머를 지워야 함).
    public async HandleEnterLobby(client: Client, raw_message: unknown): Promise<boolean> {
        if (this.userid_by_session.has(client.sessionId)) {
            // 이미 입장한 연결이 또 보낸 경우 — 다른 중복 접속 경로(아래)와 똑같이 연결을 끊는다
            // (2026-10-01 정정: 예전엔 연결을 유지했는데, 사용자 지시로 일관되게 바꿨다)
            messages.SendResult(this.room, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.DUPLICATE_CONNECTION);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        const payload = raw_message;
        if (!IsEnterLobbyShape(payload) || !IsValidEnterLobbyFields(payload)) {
            if (IsEnterLobbyShape(payload)) {
                console.warn(
                    `[LobbyManager] 형식 오류 partner=${payload.partner} gender=${payload.gender} phone=${log.MaskPhone(payload.phone)}`
                );
            }
            messages.SendResult(this.room, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.INVALID_FORMAT);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        if (!(await VerifyAuth(payload))) {
            // 1차 구현에서는 항상 통과한다 (VerifyAuth 주석 참고) — 토큰 검증 추가 시를 대비해 남겨 둔다
            messages.SendResult(this.room, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.OTHER);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        const userid = useridUtils.ConvertMidToUserid(payload.partner, payload.mid);

        if (this.waiting_by_userid.has(userid)) {
            // 같은 계정이 이미 이 채널 로비에 대기 중 — 중복 접속
            messages.SendResult(this.room, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.DUPLICATE_CONNECTION);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        let result: { user: UserInfo; is_new_user: boolean };
        try {
            result = await userRepository.GetOrCreateUser(payload);
        } catch (error) {
            console.error("[LobbyManager] GetOrCreateUser 실패:", error instanceof Error ? error.message : error);
            messages.SendResult(this.room, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.DB_ERROR);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        this.waiting_by_userid.set(userid, { client, user: result.user });
        this.userid_by_session.set(client.sessionId, userid);

        const entered_payload: EnterLobbyResultPayload = {
            result: "Y",
            userid: result.user.userid,
            new: result.is_new_user ? "Y" : "N",
            name: result.user.name,
            avatar: result.user.avatar,
            star: result.user.star,
        };
        messages.SendMessage(this.room, client, types.MessageType.ENTER_LOBBY, entered_payload);

        // 게임 중이던 유저가 F5 새로고침 등으로 소켓이 완전히 새로 열려 로비로 다시 들어온 경우 —
        // 평범한 로비 대기 대신 원래 게임방으로 돌아가라고 안내한다 (Phase 6-1, CLAUDE.md "F5 재접속" 참고).
        const rejoin_payload = await this.TryBuildRejoinPayload(userid);
        if (rejoin_payload) {
            this.SendRejoinGameAndLeave(client, userid, rejoin_payload);
        }
        return true;
    }

    // activeGame.ts 에 기록이 있으면 재접속을 시도해 REJOIN_GAME payload 를 만든다. room_id 만 있으면
    // 되는 게임 무관 로직(TryReconnectToGame, GameRoomMatcher.ts 참고)이라 어느 게임이었는지 몰라도 된다.
    // 기록이 없거나(게임 중이 아님) 재접속이 실패하면(게임이 이미 끝났거나 방이 사라짐) null.
    private async TryBuildRejoinPayload(userid: string): Promise<RejoinGamePayload | null> {
        const active_game = await activeGame.GetActiveGame(userid);
        if (!active_game) return null;

        const rejoin = await TryReconnectToGame(active_game);
        if (!rejoin) {
            // 낡은 기록(게임이 이미 끝났거나 방/프로세스가 사라짐) — 지워서 다음 ENTER_LOBBY 부터는
            // 평범하게 로비 입장이 되게 한다
            await activeGame.RemoveActiveGame(userid);
            return null;
        }
        // Colyseus 클라이언트 SDK 의 client.reconnect() 는 "roomId:reconnectionToken" 형식의 합성 문자열을
        // 받는다(SDK 가 room.reconnectionToken 을 저장할 때도 이 형식으로 만든다) — 그래서 여기서 미리
        // 합쳐서 보낸다. GameRoomMatcher 가 들고 있는 reconnection_token 은 순수 토큰 값이다(matchMaker.reconnect()
        // 검증 호출에는 순수 토큰이 필요하다).
        // game 은 room_name("othello_1" 등)에서 뽑는다 — activeGame 기록에는 게임 종류가 따로 없고
        // room_name 으로 구분한다(2026-10-07 통신규약 lobby 시트 C13 에 game 필드가 추가됨).
        const game = channelNames.ParseGameTypeFromRoomName(rejoin.room_name);
        if (!game) {
            console.error(`[LobbyManager] REJOIN_GAME 의 room_name 에서 게임 종류를 알 수 없습니다: ${rejoin.room_name}`);
            return null;
        }
        return {
            game,
            room_name: rejoin.room_name,
            room_id: rejoin.room_id,
            reconnection_token: `${rejoin.room_id}:${rejoin.reconnection_token}`,
        };
    }

    // REJOIN_GAME 전송 후 로비 연결을 끊는다 (CONSENTED) — SendMatchFoundAndLeave 와 같은 이유/방식.
    private SendRejoinGameAndLeave(client: Client, userid: string, payload: RejoinGamePayload): void {
        this.waiting_by_userid.delete(userid);
        this.userid_by_session.delete(client.sessionId);

        messages.SendMessage(this.room, client, types.MessageType.REJOIN_GAME, payload);
        client.leave(CloseCode.CONSENTED);
    }

    // NAME 처리 (별명 등록/변경). 문서 기준 흐름은 ENTER_LOBBY 성공 응답에서 new=Y 이고 name 이 빈 문자열일 때
    // 클라이언트가 처음 등록하는 것이지만, 이미 별명이 있는 유저가 다시 보내면 그 값으로 갱신한다
    // (문서에는 없는 확장 — CLAUDE.md 참고). 검증/중복 처리는 최초 등록과 동일하다.
    public async HandleName(client: Client, raw_message: unknown): Promise<void> {
        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return; // ENTER_LOBBY 를 아직 안 한 연결 — 무시

        const entry = this.waiting_by_userid.get(userid);
        if (!entry) return; // 매칭 등으로 이미 대기열에서 빠진 연결 — 무시

        const payload = raw_message as Partial<NamePayload> | null;
        const raw_name = typeof payload === "object" && payload !== null ? payload.name : undefined;

        if (!nameFilter.IsValidNameFormat(raw_name)) {
            messages.SendResult(this.room, client, types.MessageType.NAME, "N", types.NameErrorCode.INAPPROPRIATE);
            return;
        }
        const trimmed_name = raw_name.trim();
        if (nameFilter.ContainsBannedWord(trimmed_name)) {
            messages.SendResult(this.room, client, types.MessageType.NAME, "N", types.NameErrorCode.INAPPROPRIATE);
            return;
        }

        let db_result: "ok" | "duplicate";
        try {
            db_result = await userRepository.SetUserName(userid, trimmed_name);
        } catch (error) {
            console.error("[LobbyManager] SetUserName 실패:", error instanceof Error ? error.message : error);
            messages.SendResult(this.room, client, types.MessageType.NAME, "N", types.NameErrorCode.SERVER_ERROR);
            return;
        }

        if (db_result === "duplicate") {
            messages.SendResult(this.room, client, types.MessageType.NAME, "N", types.NameErrorCode.DUPLICATE);
            return;
        }

        entry.user = { ...entry.user, name: trimmed_name };
        messages.SendResult(this.room, client, types.MessageType.NAME, "Y");
    }

    // AD_VIEW_COMPLETE 처리 — 로비에서 광고를 끝까지 본 클라이언트가 보낸다. star 를 지급하고(간격 제한
    // AD_VIEW_COOLDOWN_SEC, 하루 횟수 제한 없음) 결과와 보유 star 를 같은 type 으로 응답한다.
    // ENTER_LOBBY 전이거나 이미 매칭돼 대기열에서 빠진 연결이면 조용히 무시한다(로그도 남기지 않음).
    public async HandleAdViewComplete(client: Client): Promise<void> {
        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return;

        const entry = this.waiting_by_userid.get(userid);
        if (!entry) return;

        const reward = await adRepository.RewardAdView(userid, this.room.roomName, entry.user.star);
        const payload: AdViewCompleteResultPayload = reward.ok
            ? { result: "Y", star_add: reward.star_add, star: reward.star }
            : {
                  result: "N",
                  error: reward.reason === "too_frequent" ? types.AdViewErrorCode.TOO_FREQUENT : types.AdViewErrorCode.SERVER_ERROR,
                  star: reward.star,
              };
        if (reward.ok) {
            entry.user = { ...entry.user, star: reward.star };
        }
        // await 사이에 연결이 끊겼으면 보내지 않는다 (star 는 이미 DB 에 반영됨 — 다음 ENTER_LOBBY 에서 보임)
        if (this.userid_by_session.get(client.sessionId) !== userid) return;
        messages.SendMessage(this.room, client, types.MessageType.AD_VIEW_COMPLETE, payload);
    }

    // PLAY_INFO 처리 (게임 정보 통신). 이 세션이 ENTER_LOBBY 때 이미 들고 있는 UserInfo 를 그대로
    // 응답한다 (DB 재조회 없음). message.game(2026-10-02 통신규약 시트에 추가)이 없으면 "rps" 로
    // 처리한다 — 지금은 게임이 rps 하나뿐이라 그 외의 값이 오면(형식 오류와 동일하게) 조용히
    // 무시한다. 문서에 실패 케이스가 없어, ENTER_LOBBY 를 아직 안 했거나 이미 매칭돼 대기열에서
    // 빠진 연결이 보내도 마찬가지로 조용히 무시한다 (다른 out-of-order 메시지와 같은 처리).
    public async HandlePlayInfo(client: Client, message: PlayInfoPayload): Promise<void> {
        const game = message?.game ?? "rps";
        if (!ALL_GAME_TYPES.includes(game)) return; // 지원하지 않는 게임 — 무시

        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return;

        const entry = this.waiting_by_userid.get(userid);
        if (!entry) return;

        // ⚠️ 세션에 들고 있는 entry.user 의 통계는 **가위바위보** 것이다 — ENTER_LOBBY 때
        // queries/userInfo.ts 가 `JOIN rps_user_play_info` 로 가져오기 때문. 그래서 rps 가 아니면
        // 그 게임의 통계를 따로 읽는다(playInfoRepository, Redis → DB). 2026-10-07 오델로 추가.
        let play = {
            total_game_count: entry.user.total_game_count,
            total_win_count: entry.user.total_win_count,
            today_game_count: entry.user.today_game_count,
            today_win_count: entry.user.today_win_count,
        };
        if (game !== "rps") {
            const fetched = await playInfoRepository.GetPlayInfo(userid, game);
            if (!fetched) return; // 통계 행이 없다 — 조용히 무시 (가입 시 함께 만들므로 정상적으로는 없을 수 없다)
            play = fetched;
        }

        const payload: PlayInfoResultPayload = {
            result: "Y",
            game, // 2026-10-07 통신규약(lobby 시트 B10) — 어느 게임의 통계인지 응답에 담는다
            ...play,
        };
        messages.SendMessage(this.room, client, types.MessageType.PLAY_INFO, payload);
    }

    // RANK_DAILY/RANK_WEEKLY 처리 (Phase 8, 2026-10-01 통신규약 시트 기준). PLAY_INFO 와 같은 패턴으로
    // 실패 케이스가 없다 — ENTER_LOBBY 를 아직 안 했으면 조용히 무시한다. DB 조회 결과(RankEntry[])를
    // 문서 payload 형식인 [name, score] 튜플 배열로 변환해서 보낸다. message.game(2026-10-06 추가)이
    // 없으면 "rps", 아직 지원하지 않는 게임이면 PLAY_INFO 처럼 조용히 무시한다.
    public async HandleRankDaily(client: Client, message: RankPayload): Promise<void> {
        const game = message?.game ?? "rps";
        if (!ALL_GAME_TYPES.includes(game)) return;

        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return;

        const { date, rank_list, my_rank, my_score } = await rankingRepository.FetchRankDaily(game, userid);
        const payload: RankDailyResultPayload = {
            game, // 2026-10-07 통신규약(lobby 시트 C15)
            date,
            list: ToRankListEntries(rank_list),
            my: { rank: my_rank, score: my_score },
        };
        messages.SendMessage(this.room, client, types.MessageType.RANK_DAILY, payload);
    }

    public async HandleRankWeekly(client: Client, message: RankPayload): Promise<void> {
        const game = message?.game ?? "rps";
        if (!ALL_GAME_TYPES.includes(game)) return;

        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return;

        const { term, rank_list, my_rank, my_score } = await rankingRepository.FetchRankWeekly(game, userid);
        const payload: RankWeeklyResultPayload = {
            game, // 2026-10-07 통신규약(lobby 시트 C17)
            term,
            list: ToRankListEntries(rank_list),
            my: { rank: my_rank, score: my_score },
        };
        messages.SendMessage(this.room, client, types.MessageType.RANK_WEEKLY, payload);
    }

    // 연결이 끊겼을 때 (ENTER_LOBBY 이전에 끊겼으면 등록된 게 없어 아무 일도 하지 않는다)
    public async HandleLeave(client: Client): Promise<void> {
        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return; // 매칭돼서 게임방으로 옮겨간 경우도 여기로 온다 (SendMatchFoundAndLeave 에서 이미 지워 둠)

        this.waiting_by_userid.delete(userid);
        this.userid_by_session.delete(client.sessionId);
        this.RemoveFromAllMatchQueues(userid);

        // 떠날 때는 값을 다시 쓰지 않고 TTL 만 다시 설정한다 (CLAUDE.md 흐름 13번)
        const cached = await userCache.GetUserCache(userid);
        if (cached) {
            await userCache.TouchUserCache(cached);
        }
        // cached 가 없다면(드물게 대기 중 TTL 이 이미 지난 경우) 그냥 둔다 — 다음 ENTER_LOBBY 때 DB 에서 다시 채워진다
    }

    // JOIN_MATCH { select: "Y"|"N", game? } — Y: "게임 참여"(그 게임의 대기열에 넣고 매칭 시도),
    // N: 매칭 대기 취소. (예전엔 별도 CANCEL_MATCH 메시지였지만, JOIN_MATCH 하나로 합쳤다 — 문서 반영)
    // game 이 없으면 "rps" 로 처리한다(2026-10-02 "게임별 분리 구조" 로 추가된 필드 — 기존 클라이언트
    // 호환용 기본값).
    public async HandleJoinMatch(client: Client, message: JoinMatchPayload): Promise<void> {
        const userid = this.userid_by_session.get(client.sessionId);
        if (!userid) return; // ENTER_LOBBY 를 아직 안 한 연결 — 무시

        if (message?.select === "N") {
            // 어느 게임 큐에 있었는지 클라이언트가 안 알려줘도 되게, 모든 게임 큐에서 지운다
            // (한 유저가 동시에 두 게임에 큐잉될 일은 없으므로 안전하다)
            this.RemoveFromAllMatchQueues(userid);
            return;
        }
        if (message?.select !== "Y") return; // 형식이 잘못된 요청은 무시한다 (문서에 실패 응답이 없음)

        const game = message.game ?? "rps";
        const queue = this.match_queue_by_game.get(game);
        if (!queue) return; // 모르는 게임 종류 — 무시 (문서에 실패 응답이 없음)

        if (!queue.includes(userid)) {
            queue.push(userid);
        }
        await this.TryMatch(game);
    }

    public GetWaitingCount(): number {
        return this.waiting_by_userid.size;
    }

    // ADMIN_CHANNEL_USER 용 — 이 채널 로비에서 대기 중인 userid 목록 (roomRegistry 를 통해 채널 유저
    // 리포터가 주기적으로 가져간다). 로비는 "방" 개념이 없어 room 필드는 채우지 않는다.
    public GetWaitingUserids(): string[] {
        return [...this.waiting_by_userid.keys()];
    }

    private RemoveFromAllMatchQueues(userid: string): void {
        for (const queue of this.match_queue_by_game.values()) {
            const index = queue.indexOf(userid);
            if (index !== -1) queue.splice(index, 1);
        }
    }

    // 대기열에 있는 만큼 계속 매칭을 시도한다. "기다리는 방"이 있으면 1명씩 채워 넣고,
    // 없으면 2명이 모일 때 새 방을 만든다 (CLAUDE.md 게임 규칙 12번 / TASKS Phase 4-3).
    private async TryMatch(game: GameType): Promise<void> {
        if (channelNames.IsSoloGame(game)) {
            await this.TryMatchSolo(game);
            return;
        }

        const match_queue = this.match_queue_by_game.get(game)!;
        const matcher = this.matchers_by_game.get(game)!;

        while (match_queue.length > 0) {
            const first_userid = match_queue[0];
            const first_entry = this.waiting_by_userid.get(first_userid);
            if (!first_entry) {
                // 대기열에 있는 사이 연결이 끊긴 유저 — 자리만 비우고 계속
                match_queue.shift();
                continue;
            }

            // 1) 상대를 기다리는 방이 있으면 그 방에 먼저 넣는다 (Phase 5 전까지는 항상 없음 — 정상)
            const waiting_match = await matcher.TryJoinWaitingRoom(first_entry.user);
            if (waiting_match) {
                match_queue.shift();
                this.SendMatchFoundAndLeave(first_entry.client, first_entry.user.userid, {
                    game, // 2026-10-07 통신규약(lobby 시트 C12) — 어느 게임으로 매칭됐는지
                    room_name: waiting_match.room_name,
                    room_id: waiting_match.room_id,
                    seat_reservation: waiting_match.reservation,
                    opponent: waiting_match.opponent,
                });
                continue; // 다음 대기자도 이어서 매칭 시도
            }

            // 2) 없으면 2명이 모여야 새 방을 만든다 — 아직 한 명뿐이면 다음 JOIN_MATCH 를 기다린다
            if (match_queue.length < 2) break;

            const second_userid = match_queue[1];
            const second_entry = this.waiting_by_userid.get(second_userid);
            if (!second_entry) {
                match_queue.splice(1, 1); // 두 번째 자리만 비우고 다시 시도
                continue;
            }

            match_queue.splice(0, 2);

            const new_match = await matcher.CreateRoomForTwo(first_entry.user, second_entry.user);
            if (!new_match) {
                // 그 게임 채널이 모두 꽉 참 — 둘 다 로비에 남는다(연결 유지). 다시 매칭하려면 JOIN_MATCH 를 또 보내야 한다.
                messages.SendError(this.room, first_entry.client, types.ErrorCode.NO_GAME_ROOM, "접속 가능한 게임방이 없습니다. 잠시 후 다시 참여 해 주세요.");
                messages.SendError(this.room, second_entry.client, types.ErrorCode.NO_GAME_ROOM, "접속 가능한 게임방이 없습니다. 잠시 후 다시 참여 해 주세요.");
                continue;
            }

            this.SendMatchFoundAndLeave(first_entry.client, first_entry.user.userid, {
                game,
                room_name: new_match.room_name,
                room_id: new_match.room_id,
                seat_reservation: new_match.reservation_a,
                opponent: gameRoomMatcher.ToPublicOpponentInfo(second_entry.user),
            });
            this.SendMatchFoundAndLeave(second_entry.client, second_entry.user.userid, {
                game,
                room_name: new_match.room_name,
                room_id: new_match.room_id,
                seat_reservation: new_match.reservation_b,
                opponent: gameRoomMatcher.ToPublicOpponentInfo(first_entry.user),
            });
        }
    }

    // 혼자 하는 게임(청기백기 등) — 상대를 기다리지 않고 대기열의 유저마다 바로 1인 방을 만든다 (2026-10-22).
    // "기다리는 방"도 없다(재게임 상대가 없으므로). opponent 는 MATCH_FOUND 에서 생략한다.
    private async TryMatchSolo(game: GameType): Promise<void> {
        const match_queue = this.match_queue_by_game.get(game)!;
        const matcher = this.matchers_by_game.get(game)!;

        while (match_queue.length > 0) {
            const userid = match_queue.shift()!;
            const entry = this.waiting_by_userid.get(userid);
            if (!entry) continue; // 대기열에 있는 사이 연결이 끊긴 유저

            const solo_match = await matcher.CreateRoomForOne(entry.user);
            if (!solo_match) {
                // 그 게임 채널이 모두 꽉 참 — 로비에 남는다(연결 유지). 2인 게임과 같은 응답이다.
                messages.SendError(this.room, entry.client, types.ErrorCode.NO_GAME_ROOM, "접속 가능한 게임방이 없습니다. 잠시 후 다시 참여 해 주세요.");
                continue;
            }

            this.SendMatchFoundAndLeave(entry.client, userid, {
                game,
                room_name: solo_match.room_name,
                room_id: solo_match.room_id,
                seat_reservation: solo_match.reservation,
            });
        }
    }

    // 매칭 성사 — MATCH_FOUND 전송 후 로비 연결을 끊는다 (CONSENTED). 로비 쪽 상태도 함께 정리한다.
    private SendMatchFoundAndLeave(client: Client, userid: string, payload: MatchFoundPayload): void {
        this.waiting_by_userid.delete(userid);
        this.userid_by_session.delete(client.sessionId);

        messages.SendMessage(this.room, client, types.MessageType.MATCH_FOUND, payload);
        client.leave(CloseCode.CONSENTED);
    }
}
