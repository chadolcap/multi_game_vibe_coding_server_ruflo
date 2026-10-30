// 광고 로그 테이블 이름·관리자 조회 날짜 검사 단위 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import * as adLogSchema from "./adLogSchema.js";
import * as adLog from "./queries/adLog.js";

test("GetAdLogTableName: 그 날짜가 속한 달의 소문자 테이블 이름", () => {
    assert.equal(adLogSchema.GetAdLogTableName(new Date(2026, 9, 30)), "ad_log_2026_10");
    assert.equal(adLogSchema.GetAdLogTableName(new Date(2027, 0, 1)), "ad_log_2027_01");
});

test("IsValidAdLogDate: YYYY-MM-DD 형식의 실제 날짜만 통과", () => {
    assert.equal(adLog.IsValidAdLogDate("2026-10-30"), true);
    assert.equal(adLog.IsValidAdLogDate("2024-02-29"), true);
    assert.equal(adLog.IsValidAdLogDate("2026-02-30"), false);
    assert.equal(adLog.IsValidAdLogDate("2026-13-01"), false);
    assert.equal(adLog.IsValidAdLogDate("2026-1-01"), false);
    assert.equal(adLog.IsValidAdLogDate("2026-10-30; DROP TABLE x"), false);
    assert.equal(adLog.IsValidAdLogDate(20261030), false);
    assert.equal(adLog.IsValidAdLogDate(undefined), false);
});
