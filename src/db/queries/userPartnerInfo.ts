// (partner, mid) → userid 조회

import type { Pool, RowDataPacket } from "mysql2/promise";

interface UseridRow extends RowDataPacket {
    userid: string;
}

export async function FindUseridByPartnerMid(pool: Pool, partner: string, mid: string): Promise<string | null> {
    const [rows] = await pool.query<UseridRow[]>(
        "SELECT userid FROM user_partner_info WHERE partner = ? AND mid = ? LIMIT 1",
        [partner, mid]
    );
    return rows.length > 0 ? rows[0].userid : null;
}
