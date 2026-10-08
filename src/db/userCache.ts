// 유저 정보 Redis 캐시 (키 user:info:{userid}, TTL 120초)
// ⚠️ phone 은 여기 저장하지 않는다 — CLAUDE.md "phone 은 개인정보다. ... Redis 공유 정보에 넣지 않는다"
// (2026-10-01 사용자 지적으로 DbUserInfo 대신 phone 없는 UserInfo 를 그대로 캐시하도록 분리함).

import * as constants from "../common/constants.js";
import type { UserInfo } from "../common/types.js";
import * as redis from "./redis.js";

function GetUserCacheKey(userid: string): string {
    return `user:info:${userid}`;
}

export async function GetUserCache(userid: string): Promise<UserInfo | null> {
    return redis.GetJson<UserInfo>(GetUserCacheKey(userid));
}

// 값 저장 + TTL 설정. 값이 바뀔 때 호출한다 (로비 입장 직후, 게임 결과 DB 반영 직후 — CLAUDE.md 흐름 9번)
export async function SaveUserCache(user: UserInfo): Promise<void> {
    await redis.SetJson(GetUserCacheKey(user.userid), user, constants.USER_CACHE_TTL_SEC);
}

// TTL 만 다시 설정한다. 떠날 때 호출한다. 키가 이미 만료됐으면 SaveUserCache 로 다시 저장한다.
export async function TouchUserCache(user: UserInfo): Promise<void> {
    const touched = await redis.Touch(GetUserCacheKey(user.userid), constants.USER_CACHE_TTL_SEC);
    if (!touched) {
        await SaveUserCache(user);
    }
}
