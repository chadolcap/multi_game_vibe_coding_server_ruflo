// 관리자(Watcher) 룸 — 소켓 이벤트를 받아 WatcherManager 에 위임한다.
// 채널 전체가 이 룸 1개뿐이라(로비처럼 번호를 붙이지 않음), 서버 기동 시 미리 생성해 둔다 (index.ts).
// 접속 직후 ADMIN_LOGIN 으로 로그인해야 하고, 실패하거나 제한 시간 안에 보내지 않으면 연결을 끊는다.

import { Room, CloseCode, type AuthContext, type Client } from "@colyseus/core";
import type { Delayed } from "@colyseus/timer";
import * as constants from "../common/constants.js";
import * as log from "../common/log.js";
import * as messages from "../common/messages.js";
import * as types from "../common/types.js";
import type { AdminChannelCountQuery, AdminChannelUserQuery, AdminLoginPayload, SendNoticePayload } from "../common/types.js";
import { WatcherManager, type WatcherAuth } from "./WatcherManager.js";

// Colyseus 가 AuthContext.ip 를 채울 때 소켓 주소보다 먼저 보는 프록시 헤더들
// (@colyseus/core Transport.mjs 의 resolveClientIp — x-real-ip → x-forwarded-for → x-client-ip → 소켓 주소).
const PROXY_IP_HEADERS = ["x-real-ip", "x-forwarded-for", "x-client-ip"];

export class WatcherRoom extends Room {
    // 채널이 1개뿐이고, 관리자가 없어도 사라지지 않아야 한다 (서버 기동 시 미리 생성)
    autoDispose = false;

    private readonly manager = new WatcherManager(this);
    // sessionId → ADMIN_LOGIN 제한 시간 타이머. 로그인 성공하거나 연결이 끊기면 지운다.
    private readonly login_timeout_timers = new Map<string, Delayed>();

    public onCreate(): void {
        console.log(`[WatcherRoom] 생성됨 roomName=${this.roomName} roomId=${this.roomId}`);

        log.RegisterLoggedMessage<AdminLoginPayload>(this, types.MessageType.ADMIN_LOGIN, (client, message) => {
            const success = this.manager.HandleAdminLogin(client, message);
            if (success) this.ClearLoginTimeout(client.sessionId);
        });

        log.RegisterLoggedMessage<AdminChannelCountQuery>(this, types.MessageType.ADMIN_CHANNEL_COUNT, async (client, message) => {
            await this.manager.HandleChannelCount(client, message);
        });

        log.RegisterLoggedMessage<AdminChannelUserQuery>(this, types.MessageType.ADMIN_CHANNEL_USER, async (client, message) => {
            await this.manager.HandleChannelUser(client, message);
        });

        log.RegisterLoggedMessage<SendNoticePayload>(this, types.MessageType.SEND_NOTICE, async (client, message) => {
            await this.manager.HandleSendNotice(client, message);
        });
    }

    // 접속 단계 검사 — onJoin 보다 먼저 돌고, 여기서 거부(throw)하면 onJoin/onLeave 가 아예 호출되지
    // 않아 login_timeout_timers / logged_in_sessions 상태를 건드리지 않는다. 거부된 클라이언트는
    // Colyseus 레벨 에러(AUTH_FAILED=525)를 받는다 — 우리 ERROR 메시지나 ADMIN_LOGIN{result:"N"} 이 아니다.
    public onAuth(_client: Client, _options: unknown, context: AuthContext): WatcherAuth {
        // ⚠️ Colyseus 는 context.ip 를 프록시 헤더 → 소켓 주소 순으로 고른다. 지금 이 서버 앞에는 리버스
        // 프록시가 없으므로, 그 헤더가 들어왔다면 전부 클라이언트가 위조한 값이다. 그대로 믿으면
        // (1) 헤더만 바꿔 IP 잠금을 우회할 수 있고 (2) x-real-ip 에 관리자 IP 를 넣어 정상 관리자를
        // 잠그는 공격까지 가능해진다. 그래서 헤더가 오면 접속 자체를 거부해, context.ip 가 항상 실제
        // 소켓 주소가 되도록 보장한다.
        // ⚠️⚠️ 나중에 리버스 프록시(nginx 등)를 앞에 두면 이 검사를 반드시 지워야 한다 — 프록시가
        // 정상적으로 붙이는 헤더까지 막아 모든 접속이 실패한다.
        for (const header_name of PROXY_IP_HEADERS) {
            if (context.headers.get(header_name) !== null) {
                throw new Error(`신뢰할 수 없는 프록시 헤더(${header_name})가 포함된 Watcher 접속 요청`);
            }
        }

        if (this.manager.IsIpLocked(context.ip)) {
            throw new Error("ADMIN_LOGIN 연속 실패로 잠긴 IP");
        }

        // 반환값이 그대로 client.auth 가 된다 (WatcherManager.HandleAdminLogin 이 읽는다)
        return { admin_ip: context.ip ?? "" };
    }

    public onJoin(client: Client): void {
        log.LogConnect(this, client);

        // ⚠️ LobbyRoom 의 ENTER_LOBBY 타임아웃과 같은 이유로, 여기서 바로 client.leave() 하지 않고 타이머만
        // 건다 — onJoin 안에서는 클라이언트가 JOIN_ROOM 핸드셰이크를 마치기 전이라 서버가 보낸 메시지가
        // 실제로 전달되지 않는다 (CLAUDE.md 코딩 컨벤션 참고). 타임아웃 자체는 ADMIN_LOGIN 을 기다리는
        // 것이므로 이 타이머가 만료될 때 보내는 ERROR 는 핸드셰이크가 끝난 뒤라 문제없다.
        const timer = this.clock.setTimeout(() => {
            messages.SendError(this, client, types.ErrorCode.ENTER_TIMEOUT, "제한 시간 안에 ADMIN_LOGIN 을 보내지 않았습니다.");
            client.leave(CloseCode.WITH_ERROR);
        }, constants.ADMIN_LOGIN_TIMEOUT_SEC * 1000);
        this.login_timeout_timers.set(client.sessionId, timer);
    }

    public onLeave(client: Client, code?: number): void {
        log.LogDisconnect(this, client, code);
        this.ClearLoginTimeout(client.sessionId);
        this.manager.HandleLeave(client);
    }

    public onDispose(): void {
        console.log(`[WatcherRoom] 제거됨 roomId=${this.roomId}`);
    }

    private ClearLoginTimeout(sessionId: string): void {
        this.login_timeout_timers.get(sessionId)?.clear();
        this.login_timeout_timers.delete(sessionId);
    }
}
