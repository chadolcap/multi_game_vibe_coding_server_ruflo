// ad_log_YYYY_MM — 광고 시청 완료(AD_VIEW_COMPLETE) 월별 로그 테이블. 이름이 매달 바뀌므로 schema.sql 이 아니라
// 여기서 동적으로 만든다 (flagGameLogSchema.ts 와 같은 패턴).
// ⚠️ 요청 문서의 이름은 대문자(AD_LOG_2026_10)지만 다른 테이블과 같이 소문자로 만든다 — Windows MariaDB 는
//    테이블 이름을 소문자로 저장하고(lower_case_table_names=1), Linux 는 대소문자를 구분해서 섞어 쓰면 환경마다 깨진다.
// - log_time: 서버가 AD_VIEW_COMPLETE 를 받은 시각
// - result: "Y" 지급 / "N" 거부(연타 간격 안, 서버 오류). 거부도 남긴다 — 관리자 페이지의 거부 수 집계용
// - star_add: 이번에 더한 star (거부면 0), star_after: 처리 뒤 보유 star (거부면 그때 알고 있던 값)
// - channel: 요청이 들어온 로비 room_name (lobby_1 …)

import type { Pool } from "mysql2/promise";

// date 가 속한 달의 테이블 이름 (예: 2026-10-30 → ad_log_2026_10)
export function GetAdLogTableName(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `ad_log_${year}_${month}`;
}

function GetCreateTableSql(table_name: string): string {
    // 테이블 이름은 GetAdLogTableName() 이 만든 값만 들어오므로 SQL Injection 위험이 없다 (외부 입력을 직접 꽂지 않음)
    return `
        CREATE TABLE IF NOT EXISTS \`${table_name}\` (
            id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
            log_time    DATETIME         NOT NULL,
            userid      VARCHAR(255)     NOT NULL,
            result      CHAR(1)          NOT NULL,
            star_add    INT UNSIGNED     NOT NULL DEFAULT 0,
            star_after  INT UNSIGNED     NOT NULL DEFAULT 0,
            channel     VARCHAR(32)      NOT NULL DEFAULT '',
            PRIMARY KEY (id),
            KEY idx_log_time (log_time),
            KEY idx_userid (userid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
}

// date 가 속한 달의 ad_log 테이블이 없으면 만든다. 로그를 쓰기 직전에 호출한다.
export async function EnsureAdLogTable(pool: Pool, date: Date): Promise<string> {
    const table_name = GetAdLogTableName(date);
    await pool.query(GetCreateTableSql(table_name));
    return table_name;
}
