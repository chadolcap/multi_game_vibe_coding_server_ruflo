// 광고 시청 로그(ad_log_YYYY_MM) 쓰기·일자별 조회 쿼리 모음.
// 쓰기는 AD_VIEW_COMPLETE 처리(db/adRepository.ts), 조회는 관리자 ADMIN_AD_LOG(watch/WatcherManager.ts)가 쓴다.

import type { Pool, RowDataPacket } from "mysql2/promise";
import * as adLogSchema from "../adLogSchema.js";

export interface AdLogEntry {
    log_time: Date;
    userid: string;
    result: "Y" | "N";
    star_add: number;
    star_after: number;
    channel: string;
}

// log_time 이 속한 달의 ad_log 테이블에 한 줄 남긴다.
export async function InsertAdLog(pool: Pool, entry: AdLogEntry): Promise<void> {
    const table_name = await adLogSchema.EnsureAdLogTable(pool, entry.log_time);
    await pool.query(
        `INSERT INTO \`${table_name}\` (log_time, userid, result, star_add, star_after, channel) VALUES (?, ?, ?, ?, ?, ?)`,
        [entry.log_time, entry.userid, entry.result, entry.star_add, entry.star_after, entry.channel]
    );
}

export interface AdLogDaySummary {
    view_count: number; // 지급된 시청 수 (result Y)
    user_count: number; // 지급받은 유저 수 (중복 제외)
    star_total: number; // 지급한 star 합계
    reject_count: number; // 거부된 요청 수 (result N)
}

export interface AdLogListRow {
    time: string; // "HH:MM:SS"
    userid: string;
    result: "Y" | "N";
    star_add: number;
    star: number; // 처리 뒤 보유 star
    channel: string;
}

export interface AdLogDayResult {
    summary: AdLogDaySummary;
    list: AdLogListRow[]; // 최신순, 최대 limit 건
    total: number; // 그날 전체 로그 수 (list 가 잘렸는지 판단용)
}

interface SummaryRow extends RowDataPacket {
    total: number;
    view_count: number;
    user_count: number;
    star_total: number;
    reject_count: number;
}

interface ListRow extends RowDataPacket {
    time: string;
    userid: string;
    result: "Y" | "N";
    star_add: number;
    star_after: number;
    channel: string;
}

const EMPTY_DAY: AdLogDayResult = {
    summary: { view_count: 0, user_count: 0, star_total: 0, reject_count: 0 },
    list: [],
    total: 0,
};

// "YYYY-MM-DD" 하루의 요약과 상세 목록. 호출 전에 날짜 형식은 검사돼 있어야 한다(IsValidAdLogDate).
// 그 달 테이블이 아직 없으면(광고 로그가 한 건도 없던 달) 빈 결과를 돌려준다.
// ⚠️ SUM/IF 결과는 mysql2 가 문자열(DECIMAL)로 돌려주므로 CAST(... AS UNSIGNED) 로 감싼다.
export async function FetchAdLogByDate(pool: Pool, date: string, limit: number): Promise<AdLogDayResult> {
    const [year, month] = date.split("-");
    const table_name = adLogSchema.GetAdLogTableName(new Date(Number(year), Number(month) - 1, 1));
    const day_start = `${date} 00:00:00`;

    try {
        const [summary_rows] = await pool.query<SummaryRow[]>(
            `SELECT
                COUNT(*) as total,
                CAST(COALESCE(SUM(result = 'Y'), 0) AS UNSIGNED) as view_count,
                COUNT(DISTINCT IF(result = 'Y', userid, NULL)) as user_count,
                CAST(COALESCE(SUM(star_add), 0) AS UNSIGNED) as star_total,
                CAST(COALESCE(SUM(result = 'N'), 0) AS UNSIGNED) as reject_count
             FROM \`${table_name}\`
             WHERE log_time >= ? AND log_time < DATE_ADD(?, INTERVAL 1 DAY)`,
            [day_start, day_start]
        );
        const [list_rows] = await pool.query<ListRow[]>(
            `SELECT DATE_FORMAT(log_time, '%H:%i:%s') as time, userid, result, star_add, star_after, channel
             FROM \`${table_name}\`
             WHERE log_time >= ? AND log_time < DATE_ADD(?, INTERVAL 1 DAY)
             ORDER BY log_time DESC, id DESC
             LIMIT ?`,
            [day_start, day_start, limit]
        );

        const summary = summary_rows[0];
        return {
            summary: {
                view_count: Number(summary.view_count),
                user_count: Number(summary.user_count),
                star_total: Number(summary.star_total),
                reject_count: Number(summary.reject_count),
            },
            list: list_rows.map((row) => ({
                time: row.time,
                userid: row.userid,
                result: row.result,
                star_add: row.star_add,
                star: row.star_after,
                channel: row.channel,
            })),
            total: Number(summary.total),
        };
    } catch (error) {
        if ((error as { code?: string }).code === "ER_NO_SUCH_TABLE") return EMPTY_DAY;
        throw error;
    }
}

// ADMIN_AD_LOG 의 date 형식 검사 — "YYYY-MM-DD" 이고 실제로 있는 날짜여야 한다.
// 이 값이 테이블 이름(연·월)과 쿼리 조건에 쓰이므로 형식이 틀리면 조회하지 않는다.
export function IsValidAdLogDate(date: unknown): date is string {
    if (typeof date !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}
