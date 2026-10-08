// 게임별 플레이 통계 조회 진입점 (Redis → DB 순, 2026-10-07 추가).
// 매니저(LobbyManager)/매처(GameRoomMatcher)는 이 모듈만 호출한다 — userRepository.ts 와 같은 구조다.
//
// 캐시 키를 `user:play:{game}:{userid}` 로 게임마다 분리하는 게 핵심이다. 기존
// `user:info:{userid}`(userCache.ts)는 신원(이름/아바타) + RPS 통계가 섞여 있어 그대로 두고,
// "어느 게임의 통계인지"가 중요한 경로만 이 모듈을 쓴다 (CLAUDE.md "게임별 통계 분리" 참고).

import * as constants from "../common/constants.js";
import type { GameType } from "../common/channelNames.js";
import type { UserInfo } from "../common/types.js";
import * as connection from "./connection.js";
import * as userPlayInfo from "./queries/userPlayInfo.js";
import type { PlayInfo } from "./queries/userPlayInfo.js";
import * as redis from "./redis.js";

function GetPlayInfoCacheKey(game: GameType, userid: string): string {
    return `user:play:${game}:${userid}`;
}

// 그 게임의 통계를 돌려준다 (Redis → DB). 행이 없으면 null.
export async function GetPlayInfo(userid: string, game: GameType): Promise<PlayInfo | null> {
    const key = GetPlayInfoCacheKey(game, userid);

    const cached = await redis.GetJson<PlayInfo>(key);
    if (cached) return cached;

    const fetched = await userPlayInfo.FetchPlayInfo(connection.GetDbPool(), userid, game);
    if (!fetched) return null;

    await redis.SetJson(key, fetched, constants.USER_CACHE_TTL_SEC);
    return fetched;
}

// 게임 결과를 DB 에 반영한 뒤 호출한다 — 캐시에 오래된 통계가 남지 않게 지운다.
// (덮어쓰기 대신 삭제하는 이유: 다음 조회가 DB 를 읽어 "지연 초기화" 보정까지 다시 타게 하려는 것)
export async function InvalidatePlayInfoCache(userid: string, game: GameType): Promise<void> {
    await redis.DeleteJson(GetPlayInfoCacheKey(game, userid));
}

// UserInfo 의 통계 부분을 그 게임 것으로 바꿔 돌려준다 (신원 필드는 그대로).
// GameRoomMatcher 가 좌석 예약 **직전**에 호출해서, 게임방이 받는 통계가 항상 그 게임 것이 되게 한다.
// 통계 행을 못 찾으면 원본을 그대로 돌려준다 — 매칭을 막을 만한 일은 아니라서 조용히 넘어간다.
export async function WithGamePlayInfo(user: UserInfo, game: GameType): Promise<UserInfo> {
    const play = await GetPlayInfo(user.userid, game);
    if (!play) return user;

    return {
        ...user,
        total_game_count: play.total_game_count,
        total_win_count: play.total_win_count,
        today_game_count: play.today_game_count,
        today_win_count: play.today_win_count,
    };
}
