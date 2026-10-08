// user_partner_info + user_member_info + rps_user_play_info 조회 (DbUserInfo, phone 포함).
// ⚠️ 지금 이 JOIN 은 가위바위보 통계(rps_user_play_info)만 본다 — 오델로가 추가되면 "ENTER_LOBBY 때
// 보여주는 게임 정보가 어느 게임 것인지"를 다시 결정해야 한다(CLAUDE.md "게임별 분리 구조" 참고).

import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DbUserInfo } from "../types.js";

interface UserInfoRow extends RowDataPacket {
    userid: string;
    gender: string;
    name: string | null; // 별명을 아직 등록하지 않은 유저는 NULL (schema.sql 참고)
    avatar: string;
    phone: string;
    total_game_count: number;
    total_win_count: number;
    today_game_count: number;
    today_win_count: number;
}

// today_date 가 오늘과 다르면(자정이 지났는데 아직 이 유저의 게임 결과 반영으로 리셋된 적 없음)
// today_game_count/today_win_count 를 조회 시점에 0 으로 보정해서 돌려준다 — "지연 초기화" 패턴.
// DB 의 실제 값은 그대로 두고, 다음에 이 유저가 게임을 하면 UpdateRpsPlayInfoAfterGame 이 실제로 리셋한다
// (Phase 8, TASKS.md "자정에 today_game_count, today_win_count 초기화" 참고).
// ⚠️ IF(...) 표현식으로 감싼 컬럼은 mysql2 가 원래 컬럼(INT UNSIGNED)과 다르게 문자열로 반환하는 걸
// 실제로 겪었다 — CAST(... AS UNSIGNED) 로 타입을 명시해야 DbUserInfo.today_game_count(number)
// 와 실제로 맞는 타입이 온다.
const SELECT_USER_INFO_SQL = `
    SELECT
        p.userid,
        p.gender,
        m.name,
        m.avatar,
        m.phone,
        g.total_game_count,
        g.total_win_count,
        CAST(IF(g.today_date = CURDATE(), g.today_game_count, 0) AS UNSIGNED) as today_game_count,
        CAST(IF(g.today_date = CURDATE(), g.today_win_count, 0) AS UNSIGNED) as today_win_count
    FROM user_partner_info p
    JOIN user_member_info m ON m.userid = p.userid
    JOIN rps_user_play_info g ON g.userid = p.userid
    WHERE p.userid = ?
    LIMIT 1
`;

export async function FetchUserInfo(pool: Pool, userid: string): Promise<DbUserInfo | null> {
    const [rows] = await pool.query<UserInfoRow[]>(SELECT_USER_INFO_SQL, [userid]);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        userid: row.userid,
        gender: row.gender,
        name: row.name ?? "", // 앱 계층에서는 "별명 없음" 을 빈 문자열로 다룬다 (DB 는 UNIQUE 제약 때문에 NULL 사용)
        avatar: row.avatar,
        phone: row.phone,
        total_game_count: row.total_game_count,
        total_win_count: row.total_win_count,
        today_game_count: row.today_game_count,
        today_win_count: row.today_win_count,
    };
}
