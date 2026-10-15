// airhockey_game_log_YYYY_MM — 에어하키 월별 게임 로그 테이블. 이름이 매달 바뀌므로 schema.sql 이 아니라
// 여기서 동적으로 만든다 (steppingGameLogSchema.ts 와 같은 패턴, 2026-10-15 추가).
// - vs: 승자 기준 **골 수** "3:1" 형태
// - score: 이번 게임에서 승자가 획득한 **랭킹 점수**(넣은 골 수 × 5 = AIRHOCKEY_SCORE_PER_GOAL).
//   패자도 자기 골 수 × 5 를 받지만 그 값은 vs 로 재현되므로 따로 두지 않는다.
// - plays: 골 기록을 순서대로 담은 JSON 배열, `[{ userid, sec }, ...]` — sec 는 게임 시작부터 몇 초 뒤에
//   넣었는지. 퍽/레버의 실시간 좌표는 양이 너무 많아 남기지 않는다.
// - is_draw: 무승부 여부(둘 다 나갔는데 골 수가 같을 때만 생긴다). ⚠️ 오델로와 같이 무승부면 win/lose 에
//   player1/player2 를 **입장 순서대로** 넣고 이 플래그로 구분한다 — 집계 쿼리를 쓸 때 반드시 함께 볼 것.
// - win_is_bot / lose_is_bot: 게임이 끝날 때 그 유저가 자리를 비운(끊김 5초 이상/퇴장) 상태였는지

import type { Pool } from "mysql2/promise";

// date 가 속한 달의 테이블 이름 (예: 2026-10-15 → airhockey_game_log_2026_10)
export function GetAirhockeyGameLogTableName(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `airhockey_game_log_${year}_${month}`;
}

function GetCreateTableSql(table_name: string): string {
    // 테이블 이름은 GetAirhockeyGameLogTableName() 이 만든 값만 들어오므로 SQL Injection 위험이 없다 (외부 입력을 직접 꽂지 않음)
    return `
        CREATE TABLE IF NOT EXISTS \`${table_name}\` (
            id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
            start_time    DATETIME         NOT NULL,
            end_time      DATETIME         NOT NULL,
            win           VARCHAR(255)     NOT NULL,
            lose          VARCHAR(255)     NOT NULL,
            vs            VARCHAR(16)      NOT NULL,
            score         INT UNSIGNED     NOT NULL DEFAULT 0,
            plays         JSON             NOT NULL,
            is_draw       TINYINT(1)       NOT NULL DEFAULT 0,
            win_is_bot    TINYINT(1)       NOT NULL DEFAULT 0,
            lose_is_bot   TINYINT(1)       NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            KEY idx_win (win),
            KEY idx_lose (lose)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
}

// date 가 속한 달의 airhockey_game_log 테이블이 없으면 만든다. 로그를 쓰기 직전에 호출한다.
export async function EnsureAirhockeyGameLogTable(pool: Pool, date: Date): Promise<string> {
    const table_name = GetAirhockeyGameLogTableName(date);
    await pool.query(GetCreateTableSql(table_name));
    return table_name;
}
