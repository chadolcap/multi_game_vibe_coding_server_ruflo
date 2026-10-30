// 광고 시청 보상(AD_VIEW_COMPLETE) 처리 진입점. LobbyManager 는 db/queries 를 직접 부르지 않고 이 모듈만 호출한다.
// 순서: 연타 간격 검사(Redis) → star 지급(DB) → Redis 유저 캐시 write-through → ad_log 기록.
// 거부(간격 안·서버 오류)도 ad_log 에 result "N" 으로 남긴다.

import * as constants from "../common/constants.js";
import * as connection from "./connection.js";
import * as adLog from "./queries/adLog.js";
import type { AdLogDayResult } from "./queries/adLog.js";
import * as userRegistration from "./queries/userRegistration.js";
import * as redis from "./redis.js";
import * as userCache from "./userCache.js";

export type AdRewardResult =
    | { ok: true; star_add: number; star: number }
    | { ok: false; reason: "too_frequent" | "server_error"; star: number };

function GetAdCooldownKey(userid: string): string {
    return `ad_cooldown:${userid}`;
}

// current_star: 로비 세션이 알고 있는 보유 star — 거부됐을 때 응답·로그에 그대로 쓴다.
export async function RewardAdView(userid: string, channel: string, current_star: number): Promise<AdRewardResult> {
    const pool = connection.GetDbPool();
    const log_time = new Date();
    let result: AdRewardResult;

    try {
        const acquired = await redis.SetIfAbsent(GetAdCooldownKey(userid), constants.AD_VIEW_COOLDOWN_SEC);
        if (!acquired) {
            result = { ok: false, reason: "too_frequent", star: current_star };
        } else {
            const star = await userRegistration.AddUserStar(pool, userid, constants.AD_VIEW_REWARD_STAR);
            if (star === null) throw new Error(`star 지급 대상 유저가 없습니다: userid=${userid}`);
            result = { ok: true, star_add: constants.AD_VIEW_REWARD_STAR, star };

            const cached = await userCache.GetUserCache(userid);
            if (cached) await userCache.SaveUserCache({ ...cached, star });
        }
    } catch (error) {
        console.error("[adRepository] 광고 보상 지급 실패:", error instanceof Error ? error.message : error);
        result = { ok: false, reason: "server_error", star: current_star };
    }

    // 로그 기록 실패가 지급 결과를 바꾸지 않도록 따로 잡는다
    try {
        await adLog.InsertAdLog(pool, {
            log_time,
            userid,
            result: result.ok ? "Y" : "N",
            star_add: result.ok ? result.star_add : 0,
            star_after: result.star,
            channel,
        });
    } catch (error) {
        console.error("[adRepository] ad_log 기록 실패:", error instanceof Error ? error.message : error);
    }

    return result;
}

// 관리자 ADMIN_AD_LOG — 하루치 요약 + 최신순 목록(ADMIN_AD_LOG_LIST_LIMIT 건까지)
export async function FetchAdLogByDate(date: string): Promise<AdLogDayResult> {
    return adLog.FetchAdLogByDate(connection.GetDbPool(), date, constants.ADMIN_AD_LOG_LIST_LIMIT);
}
