// 관리자(Watcher) 채널 로직 — ADMIN_LOGIN 인증, ADMIN_CHANNEL_COUNT/ADMIN_CHANNEL_USER 조회, SEND_NOTICE 전파.
// WatcherRoom 은 소켓 이벤트만 받고, 실제 처리는 이 클래스에 맡긴다 (LobbyManager 와 같은 구조).
// 로컬 엑셀본 "관리자" 시트 기준. ADMIN_LOGIN/SEND_NOTICE 는 그 시트에 아직 없어 CLAUDE.md 가 기준이다.

import { createHash, timingSafeEqual } from "node:crypto";
import { CloseCode, matchMaker, type Client, type Room } from "@colyseus/core";
import * as channelNames from "../common/channelNames.js";
import { config } from "../common/config.js";
import * as constants from "../common/constants.js";
import * as messages from "../common/messages.js";
import * as types from "../common/types.js";
import type {
    AdminChannelCountPayload,
    AdminChannelCountQuery,
    AdminChannelUserQuery,
    AdminChannelUserResultPayload,
    AdminLoginPayload,
    AdminLoginResultPayload,
    NoticeTimeRange,
    SendNoticePayload,
} from "../common/types.js";
import * as channelUsers from "../db/channelUsers.js";
import * as noticePubSub from "../db/noticePubSub.js";

// "HH:MM" 을 that time.mon/time.day(연도는 지금 연도)의 Date 로 만든다. 형식이 틀리면 null.
function ParseNoticeTime(time: NoticeTimeRange, hhmm: string): Date | null {
    const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(hhmm);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    if (!Number.isInteger(time.mon) || time.mon < 1 || time.mon > 12) return null;
    if (!Number.isInteger(time.day) || time.day < 1 || time.day > 31) return null;

    const now = new Date();
    return new Date(now.getFullYear(), time.mon - 1, time.day, hour, minute, 0, 0);
}

// WatcherRoom.onAuth 가 client.auth 에 담아 주는 값. 와이어 프로토콜이 아니라 서버 내부 전달용이라
// common/types.ts(클라이언트와 주고받는 메시지 타입) 대신 여기에 둔다.
export interface WatcherAuth {
    admin_ip: string;
}

// IP 별 ADMIN_LOGIN 연속 실패 기록
interface LoginFailureRecord {
    fail_count: number; // 연속 실패 횟수 (잠금으로 전환하면 0 으로 비운다)
    locked_until: number; // 잠금 해제 시각(ms). 0 이면 잠금 아님
    last_fail_at: number; // 마지막 실패 시각(ms) — 여기서 ADMIN_LOGIN_LOCK_SEC 이 지나면 기록을 버린다
}

// 자격증명 비교를 상수 시간으로 한다. timingSafeEqual 은 길이가 다르면 예외를 던지므로, 두 값을 먼저
// SHA-256 으로 고정 길이(32바이트)로 만든 뒤 비교한다 — 그래야 길이 차이로도 정보가 새지 않는다.
// ⚠️ SafeEqual("", "") 는 true 다. 설정 누락(빈 문자열) 검사는 호출부에서 따로 해야 한다.
function SafeEqual(a: string, b: string): boolean {
    const digest_a = createHash("sha256").update(a, "utf8").digest();
    const digest_b = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(digest_a, digest_b);
}

// 지금 설정상 존재하는 채널 이름인지 검사한다. ADMIN_CHANNEL_USER 의 channel 이 room_name 문자열로
// 바뀌면서(2026-10-07) 관리자가 보낸 값이 그대로 Redis 키 조회에 쓰이므로, 임의 문자열을 그대로
// 받지 않도록 화이트리스트로 막는다. 로비는 게임과 무관하게 허용하고, 게임 채널은 요청한 게임의 것만 허용한다.
function IsKnownChannelRoomName(channel: string, game: channelNames.GameType): boolean {
    for (let channel_no = 1; channel_no <= config.lobby_ports.length; channel_no++) {
        if (channel === channelNames.GetChannelRoomName("lobby", channel_no)) return true;
    }
    for (let channel_no = 1; channel_no <= channelNames.GetGameChannelCount(game); channel_no++) {
        if (channel === channelNames.GetChannelRoomName(game, channel_no)) return true;
    }
    return false;
}

// 로비 채널 전부 + 지정한 게임의 게임 채널들의 현재 접속자 수를 matchMaker.query() 로 실시간 집계한다.
// (Colyseus 의 RedisDriver 가 room 생성/삭제마다 방 목록을 이미 관리해 주므로, 별도 스냅샷 없이 그때그때
// 물어보면 된다)
// 키는 **실제 room_name**(lobby_1, rps_1 …)이다 — 엑셀본 예시는 game_1 로 적혀 있지만 2026-10-02
// 게임별 분리로 룸 이름이 rps_N 이 됐고, 2026-10-07 사용자 확인으로 실제 이름을 보내기로 했다.
async function ComputeChannelCounts(game: channelNames.GameType): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    const CountFor = async (room_name: string): Promise<void> => {
        const rooms = await matchMaker.query({ name: room_name });
        counts[room_name] = rooms.reduce((sum, room) => sum + room.clients, 0);
    };

    // 로비는 게임과 무관하게 항상 집계한다 (로비 채널 수는 .env 의 LOBBY_PORTS 목록 길이로 정해진다)
    for (let channel_no = 1; channel_no <= config.lobby_ports.length; channel_no++) {
        await CountFor(channelNames.GetChannelRoomName("lobby", channel_no));
    }
    // 게임 채널은 요청받은 게임만 — 오델로가 추가되면 channelNames.ALL_GAME_TYPES/GetGameChannelCount 가
    // 알아서 커버하므로 여기 코드는 그대로 둬도 된다.
    for (let channel_no = 1; channel_no <= channelNames.GetGameChannelCount(game); channel_no++) {
        await CountFor(channelNames.GetChannelRoomName(game, channel_no));
    }
    return counts;
}

export class WatcherManager {
    constructor(private readonly room: Room) {}

    // ADMIN_LOGIN 을 통과한 sessionId. 로그인 전에는 다른 어떤 관리자 메시지도 처리하지 않는다.
    private readonly logged_in_sessions = new Set<string>();

    // IP → ADMIN_LOGIN 연속 실패 기록. 실패할 때만 생기고, 만료된 항목은 SweepExpiredLoginFailures() 가
    // 치운다. Watcher 는 단일 프로세스 + autoDispose=false 로 상시 떠 있어 이 Map 이 프로세스 수명만큼
    // 살아 있으므로, 무한히 커지지 않도록 시도마다 한 번씩 훑는다.
    private readonly login_failures = new Map<string, LoginFailureRecord>();

    // ADMIN_LOGIN 처리. 계정 정보는 .env(config.admin_id/admin_password)로만 관리한다 — 코드/문서에 적지 않는다.
    // 성공하면 true 를 반환한다 (Room 이 로그인 제한 시간 타이머를 지워야 함).
    public HandleAdminLogin(client: Client, message: AdminLoginPayload): boolean {
        // 접속은 통과했지만 그 뒤에 (다른 연결의 실패로) 이 IP 가 잠겼을 수 있어 여기서 한 번 더 본다.
        // onAuth 는 접속 시점만 검사한다.
        const admin_ip = (client.auth as WatcherAuth | undefined)?.admin_ip ?? "";
        if (this.IsIpLocked(admin_ip)) {
            messages.SendMessage(this.room, client, types.MessageType.ADMIN_LOGIN, {
                result: "N",
            } satisfies AdminLoginResultPayload);
            client.leave(CloseCode.WITH_ERROR);
            return false;
        }

        const is_valid_shape = typeof message?.id === "string" && typeof message?.password === "string";
        // ⚠️ id 와 password 비교를 && 로 묶어 단축 평가하면, id 가 틀렸을 때 비밀번호 비교를 건너뛰어
        // "id 는 맞았는지"가 응답 시간 차이로 새어 나간다. 두 비교를 항상 모두 수행한 뒤 합친다.
        const id_ok = is_valid_shape && SafeEqual(message.id, config.admin_id);
        const password_ok = is_valid_shape && SafeEqual(message.password, config.admin_password);
        // admin_id/admin_password 가 비어 있으면(설정 누락) 어떤 값으로도 로그인시키지 않는다 — config.ts 참고
        // (SafeEqual("", "") 는 true 라서 이 빈 문자열 검사가 반드시 필요하다)
        const ok = is_valid_shape && config.admin_id !== "" && config.admin_password !== "" && id_ok && password_ok;

        const payload: AdminLoginResultPayload = { result: ok ? "Y" : "N" };
        messages.SendMessage(this.room, client, types.MessageType.ADMIN_LOGIN, payload);

        if (ok) {
            this.logged_in_sessions.add(client.sessionId);
            this.login_failures.delete(admin_ip); // 성공했으니 연속 실패 기록을 지운다
        } else {
            this.RecordLoginFailure(admin_ip);
            client.leave(CloseCode.WITH_ERROR); // 로그인 실패 시 연결 종료 (CLAUDE.md: "실패 시 연결 종료")
        }
        return ok;
    }

    // 이 IP 가 연속 실패로 잠겨 있는지. WatcherRoom.onAuth 가 접속 단계에서 호출한다.
    // ip 를 모르면(빈 문자열) 잠글 근거가 없으므로 통과시킨다.
    public IsIpLocked(ip: string | undefined): boolean {
        if (!ip) return false;
        this.SweepExpiredLoginFailures();
        return (this.login_failures.get(ip)?.locked_until ?? 0) > Date.now();
    }

    private RecordLoginFailure(ip: string): void {
        if (ip === "") return;

        const now = Date.now();
        const record = this.login_failures.get(ip) ?? { fail_count: 0, locked_until: 0, last_fail_at: 0 };
        record.fail_count++;
        record.last_fail_at = now;
        if (record.fail_count >= constants.ADMIN_LOGIN_MAX_FAIL_COUNT) {
            record.locked_until = now + constants.ADMIN_LOGIN_LOCK_SEC * 1000;
            record.fail_count = 0; // 잠금으로 전환했으니 카운터는 비운다
            console.warn(`[WatcherManager] ADMIN_LOGIN 연속 실패로 IP 잠금: ${ip} (${constants.ADMIN_LOGIN_LOCK_SEC}초)`);
        }
        this.login_failures.set(ip, record);
        this.SweepExpiredLoginFailures();
    }

    // 잠금이 풀렸고 마지막 실패로부터 ADMIN_LOGIN_LOCK_SEC 이 지난 항목을 버린다.
    // 남는 항목은 "최근 잠금 시간 안에 실패한 IP" 수만큼이라 room.clock 타이머까지 둘 필요는 없다.
    private SweepExpiredLoginFailures(): void {
        const now = Date.now();
        const forget_before = now - constants.ADMIN_LOGIN_LOCK_SEC * 1000;
        for (const [ip, record] of this.login_failures) {
            if (record.locked_until <= now && record.last_fail_at < forget_before) {
                this.login_failures.delete(ip);
            }
        }
    }

    // 요청 payload 의 game 을 읽는다. 생략하면 "rps"(PLAY_INFO/RANK_* 와 같은 관례), 지원하지 않는
    // 값이면 undefined 를 돌려줘 호출부가 조용히 무시하게 한다.
    private ReadGame(message: { game?: unknown } | undefined): channelNames.GameType | undefined {
        if (message?.game === undefined) return "rps"; // LobbyManager 와 같은 기본값 처리
        return channelNames.IsGameType(message.game) ? message.game : undefined;
    }

    public async HandleChannelCount(client: Client, message: AdminChannelCountQuery): Promise<void> {
        if (!this.RequireLoggedIn(client)) return;

        const game = this.ReadGame(message);
        if (game === undefined) return; // 지원하지 않는 게임 — 조용히 무시 (PLAY_INFO/RANK_* 와 같은 처리)

        const count = await ComputeChannelCounts(game);
        const payload: AdminChannelCountPayload = { game, count };
        messages.SendMessage(this.room, client, types.MessageType.ADMIN_CHANNEL_COUNT, payload);
    }

    public async HandleChannelUser(client: Client, message: AdminChannelUserQuery): Promise<void> {
        if (!this.RequireLoggedIn(client)) return;

        const game = this.ReadGame(message);
        if (game === undefined) return; // 지원하지 않는 게임 — 조용히 무시

        // channel 은 room_name 문자열(예: "lobby_1", "rps_1")이다 — 2026-10-07 통신규약 변경으로 예전
        // 숫자 형식({lobby:N}/{game:N})은 폐지됐다(사용자 결정: "channel 로만").
        // ⚠️ 아무 문자열이나 그대로 Redis 키로 쓰지 않도록, "지금 존재하는 채널 이름"인지 먼저 검사한다.
        if (typeof message?.channel !== "string" || !IsKnownChannelRoomName(message.channel, game)) return;

        const users = await channelUsers.GetChannelUsers(message.channel);
        const payload: AdminChannelUserResultPayload = {
            game,
            channel: message.channel,
            user: users,
            total: users.length,
        };
        messages.SendMessage(this.room, client, types.MessageType.ADMIN_CHANNEL_USER, payload);
    }

    // SEND_NOTICE — 응답 없음(발사 후 잊기). message.channel 에 담긴 room_name(예: "lobby_1")들에만
    // 공지를 전파한다 — 전체 채널에 보내려면 관리자 페이지가 그 목록을 모두 채워 보내야 한다.
    // message.time 이 있으면 그 구간(start~end) 동안 NOTICE_REPEAT_INTERVAL_SEC(1분) 간격으로 반복
    // 전송하고, 없으면 기존처럼 즉시 1회만 보낸다 (사용자 지시, 2026-09-30).
    public async HandleSendNotice(client: Client, message: SendNoticePayload): Promise<void> {
        if (!this.RequireLoggedIn(client)) return;
        if (typeof message?.message !== "string" || message.message.length === 0) return; // 형식 오류 — 무시
        if (!Array.isArray(message.channel) || message.channel.length === 0) return; // 형식 오류 — 무시
        if (!message.channel.every((c) => typeof c === "string")) return;
        // game 은 2026-10-07 통신규약에 추가됐지만, 전파 대상은 channel 목록(room_name)이 그대로 정한다 —
        // channel 에 이미 게임 접두사가 들어 있어 game 으로 더 좁힐 게 없다. 값이 틀리면 무시만 한다.
        if (this.ReadGame(message) === undefined) return; // 지원하지 않는 게임 — 조용히 무시

        if (message.time) {
            this.ScheduleRepeatingNotice(message.channel, message.message, message.time);
            return;
        }

        await noticePubSub.PublishNotice(message.message, message.channel);
    }

    // start~end 구간 동안 NOTICE_REPEAT_INTERVAL_SEC 간격으로 반복 전송을 예약한다. start 가 이미
    // 지났으면 곧바로 시작하고, end 가 이미 지났으면(잘못 지정했거나 너무 늦게 도착한 요청) 아무것도
    // 하지 않는다. end <= start 인 잘못된 구간도 무시한다.
    // ⚠️ 예약은 room.clock(메모리)에만 있다 — Watcher 프로세스가 재시작되면 진행 중이던 예약도 함께
    // 사라진다. Redis 등에 영속화하지 않는다(요청 범위 밖) — Watcher 는 로비처럼 autoDispose=false 로
    // 항상 떠 있는 게 기본 운영 방식이라, 재시작이 드물게만 일어난다고 가정한다.
    private ScheduleRepeatingNotice(channels: string[], message: string, time: NoticeTimeRange): void {
        const start = ParseNoticeTime(time, time.start);
        const end = ParseNoticeTime(time, time.end);
        if (!start || !end || end <= start) return; // 형식 오류 — 무시

        const now = new Date();
        if (end <= now) return; // 이미 끝난 시간대 — 무시

        const SendOnce = (): void => {
            noticePubSub.PublishNotice(message, channels).catch((error) => {
                console.error("[WatcherManager] 반복 공지 전송 실패:", error instanceof Error ? error.message : error);
            });
        };

        const delay_to_start_ms = Math.max(0, start.getTime() - now.getTime());
        this.room.clock.setTimeout(() => {
            SendOnce();
            const interval = this.room.clock.setInterval(() => {
                if (new Date() >= end) {
                    interval.clear();
                    return;
                }
                SendOnce();
            }, constants.NOTICE_REPEAT_INTERVAL_SEC * 1000);
        }, delay_to_start_ms);
    }

    public HandleLeave(client: Client): void {
        this.logged_in_sessions.delete(client.sessionId);
    }

    private RequireLoggedIn(client: Client): boolean {
        return this.logged_in_sessions.has(client.sessionId);
    }
}
