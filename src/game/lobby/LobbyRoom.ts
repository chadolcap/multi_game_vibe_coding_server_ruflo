// 로비 룸 — 소켓 이벤트를 받아 LobbyManager 에 위임한다.
// 실제 로비 콘텐츠(구매 등)는 나중에 이 파일에 추가한다. 광고 보기 보상은 AD_VIEW_COMPLETE 로 처리한다.

import { Room, CloseCode, type Client } from "@colyseus/core";
import type { Delayed } from "@colyseus/timer";
import * as constants from "../../common/constants.js";
import * as log from "../../common/log.js";
import * as messages from "../../common/messages.js";
import * as types from "../../common/types.js";
import type { JoinMatchPayload, PlayInfoPayload, RankPayload } from "../../common/types.js";
import * as roomRegistry from "../../common/roomRegistry.js";
import { LobbyManager } from "./LobbyManager.js";

export class LobbyRoom extends Room {
    // 채널당 1개만 만들어지고, 사람이 0명이어도 사라지지 않는다 (서버 기동 시 미리 생성)
    autoDispose = false;

    private readonly manager = new LobbyManager(this);
    // sessionId → ENTER_LOBBY 제한 시간 타이머. 입장 성공하거나 연결이 끊기면 지운다.
    private readonly enter_timeout_timers = new Map<string, Delayed>();

    public onCreate(): void {
        console.log(`[LobbyRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

        // SEND_NOTICE 브로드캐스트 + 채널 유저 리포터(Watcher 의 ADMIN_CHANNEL_USER 용)가 이 방을 찾을 수 있도록 등록
        roomRegistry.RegisterRoom(this, () => this.manager.GetWaitingUserids().map((userid) => ({ userid })));

        // RegisterLoggedMessage 로 등록하면 메시지가 도착할 때마다 [C→S] 로그가 자동으로 남는다.
        log.RegisterLoggedMessage(this, types.MessageType.ENTER_LOBBY, async (client, message) => {
            // ⚠️ 채널 인원 제한은 onJoin 이 아니라 여기(ENTER_LOBBY 처리 시점)에서 검사한다.
            // Colyseus 클라이언트는 JOIN_ROOM 핸드셰이크를 마치기 전(onJoin 실행 시점)에는
            // 서버가 보낸 메시지를 큐에만 쌓아 두고 실제로 전송하지 않는다. onJoin 안에서 바로
            // client.leave() 를 호출하면 그 큐가 플러시될 기회가 없어 ERROR 메시지가 끝내 전달되지
            // 않는다. ENTER_LOBBY 는 클라이언트가 핸드셰이크를 마친 뒤에만 도착하므로 여기는 안전하다.
            if (this.clients.length > constants.MAX_CLIENTS_PER_CHANNEL) {
                // 문서의 ENTER_LOBBY 결과 응답 형식(같은 type 으로 result/error)을 그대로 따른다.
                // 채널 인원 초과는 문서 taxonomy 에 없어 "기타(3)" 로 응답한다.
                messages.SendResult(this, client, types.MessageType.ENTER_LOBBY, "N", types.EnterLobbyErrorCode.OTHER);
                client.leave(CloseCode.WITH_ERROR);
                return;
            }

            const entered = await this.manager.HandleEnterLobby(client, message);
            if (entered) {
                this.ClearEnterTimeout(client.sessionId);
            }
        });

        log.RegisterLoggedMessage(this, types.MessageType.NAME, async (client, message) => {
            await this.manager.HandleName(client, message);
        });

        log.RegisterLoggedMessage<PlayInfoPayload>(this, types.MessageType.PLAY_INFO, (client, message) => {
            // 오델로 통계는 Redis/DB 를 읽어야 해서 async 가 됐다(2026-10-07) — 다른 핸들러처럼
            // 결과를 기다리지 않고 보낸다(응답은 핸들러가 직접 전송한다).
            void this.manager.HandlePlayInfo(client, message);
        });

        log.RegisterLoggedMessage<RankPayload>(this, types.MessageType.RANK_DAILY, async (client, message) => {
            await this.manager.HandleRankDaily(client, message);
        });

        log.RegisterLoggedMessage<RankPayload>(this, types.MessageType.RANK_WEEKLY, async (client, message) => {
            await this.manager.HandleRankWeekly(client, message);
        });

        log.RegisterLoggedMessage(this, types.MessageType.AD_VIEW_COMPLETE, async (client) => {
            await this.manager.HandleAdViewComplete(client);
        });

        log.RegisterLoggedMessage<JoinMatchPayload>(this, types.MessageType.JOIN_MATCH, async (client, message) => {
            await this.manager.HandleJoinMatch(client, message);
        });
    }

    public onJoin(client: Client): void {
        log.LogConnect(this, client);

        const timer = this.clock.setTimeout(() => {
            messages.SendError(this, client, types.ErrorCode.ENTER_TIMEOUT, "제한 시간 안에 ENTER_LOBBY 를 보내지 않았습니다.");
            client.leave(CloseCode.WITH_ERROR);
        }, constants.ENTER_LOBBY_TIMEOUT_SEC * 1000);
        this.enter_timeout_timers.set(client.sessionId, timer);
    }

    public async onLeave(client: Client, code?: number): Promise<void> {
        log.LogDisconnect(this, client, code);
        this.ClearEnterTimeout(client.sessionId);
        await this.manager.HandleLeave(client);
    }

    public onDispose(): void {
        roomRegistry.UnregisterRoom(this);
        console.log(`[LobbyRoom] 제거됨 roomId=${this.roomId}`);
    }

    private ClearEnterTimeout(sessionId: string): void {
        this.enter_timeout_timers.get(sessionId)?.clear();
        this.enter_timeout_timers.delete(sessionId);
    }
}
