// `{게임}_user_play_info` 에서 **그 게임의** 플레이 통계만 조회한다 (2026-10-07 추가).
//
// 왜 필요한가: `queries/userInfo.ts` 의 SELECT 는 `JOIN rps_user_play_info` 로 **가위바위보 통계를
// UserInfo 에 직접 박아** 넣는다. 게임이 하나일 때는 문제가 없었지만, 오델로가 생기면서 오델로
// 게임방의 `win_per` 과 `PLAY_INFO{game:"othello"}` 가 RPS 숫자를 보여주게 된다.
// 기존 RPS 경로(ENTER_LOBBY → FetchUserInfo → user:info:{userid} 캐시)를 건드리지 않고, "특정 게임의
// 통계만" 따로 읽는 경로를 가산적으로 추가하는 방식을 택했다(사용자 결정 2026-10-07).
//
// 쓰는 곳: LobbyManager.HandlePlayInfo(game) / GameRoomMatcher(좌석 예약 직전에 그 게임 통계로 교체).

import type { Pool, RowDataPacket } from "mysql2/promise";
import * as channelNames from "../../common/channelNames.js";
import type { GameType } from "../../common/channelNames.js";

// UserInfo 의 통계 부분만 떼어낸 모양. 게임별로 값이 다르다.
export interface PlayInfo {
    total_game_count: number;
    total_win_count: number;
    today_game_count: number;
    today_win_count: number;
}

interface PlayInfoRow extends RowDataPacket, PlayInfo {}

// today_date 가 오늘과 다르면(자정이 지났는데 아직 이 유저의 게임 결과 반영으로 리셋된 적 없음)
// today_* 를 조회 시점에 0 으로 보정해서 돌려준다 — queries/userInfo.ts 와 같은 "지연 초기화" 패턴.
// ⚠️ IF(...) 로 감싼 컬럼은 mysql2 가 원래 컬럼(INT UNSIGNED)과 다르게 **문자열**로 반환하는 걸 실제로
//    겪었다 — CAST(... AS UNSIGNED) 로 타입을 명시해야 PlayInfo 의 number 와 실제 런타임 타입이 맞는다.
function GetSelectSql(game: GameType): string {
    // ⚠️ 테이블 이름을 문자열로 끼워 넣지만, game 은 아래 FetchPlayInfo 에서 ALL_GAME_TYPES
    //    화이트리스트를 통과한 값만 들어오므로 SQL Injection 위험이 없다
    //    (queries/ranking.ts 의 `${game}_rank_daily` 와 같은 방식).
    return `
        SELECT
            total_game_count,
            total_win_count,
            CAST(IF(today_date = CURDATE(), today_game_count, 0) AS UNSIGNED) as today_game_count,
            CAST(IF(today_date = CURDATE(), today_win_count, 0) AS UNSIGNED) as today_win_count
        FROM ${game}_user_play_info
        WHERE userid = ?
        LIMIT 1
    `;
}

// 그 게임의 통계를 돌려준다. 행이 없으면 null (가입 시 모든 게임의 행을 함께 만들므로 정상적으로는
// 발생하지 않는다 — queries/userRegistration.ts 참고).
export async function FetchPlayInfo(pool: Pool, userid: string, game: GameType): Promise<PlayInfo | null> {
    if (!channelNames.IsGameType(game)) return null; // 화이트리스트 — 위 GetSelectSql 주석 참고

    const [rows] = await pool.query<PlayInfoRow[]>(GetSelectSql(game), [userid]);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        total_game_count: row.total_game_count,
        total_win_count: row.total_win_count,
        today_game_count: row.today_game_count,
        today_win_count: row.today_win_count,
    };
}
