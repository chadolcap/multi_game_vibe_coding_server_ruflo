// 유저 정보 조회 진입점 (Redis → DB 순). 매니저(Lobby/Room/Watcher)는 이 모듈만 호출한다.
// (CLAUDE.md "유저 정보 처리 단계" 1~5 구현)

// ⚠️ 이 파일은 지역 변수/매개변수로 "userid" 를 많이 쓰기 때문에, common/userid.js 모듈의 import
// alias 는 관례(파일명 그대로)를 따르지 않고 "useridUtils" 로 바꿔서 섀도잉(가려짐)을 피한다.
import * as useridUtils from "../common/userid.js";
import type { EnterLobbyPayload, UserInfo } from "../common/types.js";
import * as connection from "./connection.js";
import * as userInfo from "./queries/userInfo.js";
import * as userRegistration from "./queries/userRegistration.js";
import type { SetNameDbResult } from "./queries/userRegistration.js";
import * as userCache from "./userCache.js";
import * as types from "./types.js";

export interface GetOrCreateUserResult {
    user: UserInfo;
    is_new_user: boolean;
}

// (partner, mid) 로 유저를 찾는다. 없으면 새로 만든다. phone 이 바뀌었으면 갱신한다.
// 호출 전에 partner/mid/gender/phone 형식은 이미 검사되어 있어야 한다 (LobbyManager, Phase 3).
export async function GetOrCreateUser(input: EnterLobbyPayload): Promise<GetOrCreateUserResult> {
    const userid = useridUtils.ConvertMidToUserid(input.partner, input.mid);
    const pool = connection.GetDbPool();

    const cached = await userCache.GetUserCache(userid);
    if (cached) {
        // 캐시 히트 — phone 은 캐시에 없으므로(위 "phone" 주석 참고) 비교/갱신을 생략한다. phone 은
        // 통계 전용 정보라 캐시 TTL(USER_CACHE_TTL_SEC) 동안 최신화가 늦어지는 걸 감수한다(2026-10-01
        // 사용자 결정) — 캐시가 만료돼 DB 를 다시 조회할 때(아래 분기) 비교/갱신된다.
        return { user: cached, is_new_user: false };
    }

    const db_user = await userInfo.FetchUserInfo(pool, userid);
    let user: UserInfo;
    let is_new_user = false;

    if (!db_user) {
        // 첫 접속 유저 — 여러 번/동시에 호출돼도 RegisterNewUser 가 한 번만 만들어지게 처리한다
        await userRegistration.RegisterNewUser(pool, {
            userid,
            partner: input.partner,
            mid: input.mid,
            gender: input.gender,
            phone: input.phone,
        });
        user = {
            userid,
            name: "",
            avatar: useridUtils.GetDefaultAvatar(input.gender),
            gender: input.gender,
            total_game_count: 0,
            total_win_count: 0,
            today_game_count: 0,
            today_win_count: 0,
        };
        is_new_user = true;
    } else {
        user = types.ToPublicUserInfo(db_user);
        // DB 에서 막 가져온 값이라야 phone 비교가 가능하다(캐시엔 phone 이 없음) — 기존 유저가 이전과
        // 다른 phone 을 보냈으면 갱신
        if (db_user.phone !== input.phone) {
            await userRegistration.UpdatePhoneIfChanged(pool, userid, input.phone);
        }
    }

    // 로비 입장 직후 — 값이 바뀌었을 수 있으니 매번 Redis 에 다시 저장한다 (write-through, TTL 갱신 겸함)
    await userCache.SaveUserCache(user);

    return { user, is_new_user };
}

export type SetNameResult = "ok" | "duplicate";

// NAME 등록 — 별명이 아직 없는 유저만 한 번 등록할 수 있다 (DB 의 UNIQUE 제약이 최종 방어선).
// 성공하면 Redis 캐시에도 반영한다 (write-through). 호출 전에 name 형식/금칙어 검사는 끝나 있어야 한다.
export async function SetUserName(userid: string, name: string): Promise<SetNameResult> {
    const pool = connection.GetDbPool();
    const db_result: SetNameDbResult = await userRegistration.TrySetUserName(pool, userid, name);
    if (db_result === "duplicate") return "duplicate";

    // 캐시에 없으면(TTL 만료 등) DB 에서 다시 읽어 채운 뒤 저장한다
    let cached: UserInfo | null = await userCache.GetUserCache(userid);
    if (!cached) {
        const db_user = await userInfo.FetchUserInfo(pool, userid);
        if (db_user) cached = types.ToPublicUserInfo(db_user);
    }
    if (cached) {
        await userCache.SaveUserCache({ ...cached, name });
    }
    return "ok";
}
