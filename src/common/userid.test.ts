// userid.ts 단위 테스트 — (partner, mid) → userid 변환과 입력 형식 검사.
// 외부 의존(DB/Redis/config)이 없는 순수 함수라 서버를 띄우지 않고 바로 돌린다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as constants from "./constants.js";
import * as userid from "./userid.js";

describe("ConvertMidToUserid", () => {
    it("CLAUDE.md 예시대로 변환한다 ('u'(117) ^ 5 = 112)", () => {
        assert.equal(userid.ConvertMidToUserid("p1", "u"), "p1_112");
    });

    it("같은 입력이면 항상 같은 결과를 준다 (결정성)", () => {
        assert.equal(userid.ConvertMidToUserid("partner", "abc123"), userid.ConvertMidToUserid("partner", "abc123"));
    });

    it("partner 가 다르면 userid 도 다르다 (파트너 간 충돌 방지)", () => {
        assert.notEqual(userid.ConvertMidToUserid("p1", "samemid"), userid.ConvertMidToUserid("p2", "samemid"));
    });

    it("mid 가 다르면 userid 도 다르다", () => {
        assert.notEqual(userid.ConvertMidToUserid("p1", "aaa"), userid.ConvertMidToUserid("p1", "aab"));
    });

    it("partner 와 XOR 숫자열을 '_' 하나로 잇는다", () => {
        const result = userid.ConvertMidToUserid("abc", "xy");
        assert.equal(result.split("_").length, 2);
        assert.ok(result.startsWith("abc_"));
        // XOR 결과는 10진수 숫자만 이어 붙인 문자열이다
        assert.match(result.slice("abc_".length), /^[0-9]+$/);
    });

    it("mid 최대 길이(63자)에서도 userid 가 DB 컬럼 한도(255자)를 넘지 않는다", () => {
        const max_mid = "a".repeat(constants.MID_MAX_LENGTH);
        const max_partner = "p".repeat(constants.PARTNER_MAX_LENGTH);
        assert.ok(userid.ConvertMidToUserid(max_partner, max_mid).length <= 255);
    });

    // ⚠️ 이 변환은 **단방향이 아니다**. 2026-10-06 까지 코드 주석과 CLAUDE.md 가 "단방향이라 복원할 수
    // 없다"고 잘못 적고 있었다. userid 를 비밀로 취급해도 된다고 오해하면 파트너사 mid 가 노출되므로,
    // "되돌릴 수 있다"는 사실 자체를 테스트로 고정해 둔다 (복호 함수는 프로덕션 코드에 두지 않는다 —
    // 되돌릴 일이 있으면 user_partner_info 를 조회한다).
    it("단방향이 아니다 — userid 에서 mid 를 되돌릴 수 있다", () => {
        // XOR 결과는 48~127 범위라, 앞자리로 2자리(4~9)인지 3자리(1)인지 정해져 유일하게 쪼갤 수 있다.
        const DecodeMid = (xored: string): string => {
            let mid = "";
            let index = 0;
            while (index < xored.length) {
                const two = Number(xored.slice(index, index + 2));
                if (two >= 48 && two <= 99) {
                    mid += String.fromCharCode(two ^ constants.USERID_XOR_KEY);
                    index += 2;
                } else {
                    mid += String.fromCharCode(Number(xored.slice(index, index + 3)) ^ constants.USERID_XOR_KEY);
                    index += 3;
                }
            }
            return mid;
        };

        for (const mid of ["u", "abc123", "ZZ", "a0Z9", "0", "z", "MixedCase99"]) {
            const converted = userid.ConvertMidToUserid("p1", mid);
            assert.equal(DecodeMid(converted.slice("p1_".length)), mid, `${mid} 를 되돌리지 못했다`);
        }
    });
});

describe("IsValidPartner", () => {
    it("영문/숫자 1~11자를 통과시킨다", () => {
        assert.equal(userid.IsValidPartner("a"), true);
        assert.equal(userid.IsValidPartner("abc123"), true);
        assert.equal(userid.IsValidPartner("p".repeat(constants.PARTNER_MAX_LENGTH)), true);
    });

    it("빈 값, 길이 초과, '_' 포함, 비영숫자를 거부한다", () => {
        assert.equal(userid.IsValidPartner(""), false);
        assert.equal(userid.IsValidPartner("p".repeat(constants.PARTNER_MAX_LENGTH + 1)), false);
        assert.equal(userid.IsValidPartner("a_b"), false); // userid 구분자와 충돌하면 안 된다
        assert.equal(userid.IsValidPartner("한글"), false);
        assert.equal(userid.IsValidPartner("a b"), false);
    });

    it("문자열이 아닌 값을 거부한다", () => {
        assert.equal(userid.IsValidPartner(undefined), false);
        assert.equal(userid.IsValidPartner(null), false);
        assert.equal(userid.IsValidPartner(123), false);
        assert.equal(userid.IsValidPartner({}), false);
    });
});

describe("IsValidMid", () => {
    it("영문/숫자 1~63자를 통과시킨다", () => {
        assert.equal(userid.IsValidMid("u"), true);
        assert.equal(userid.IsValidMid("a".repeat(constants.MID_MAX_LENGTH)), true);
    });

    it("빈 값, 길이 초과, 비영숫자를 거부한다", () => {
        assert.equal(userid.IsValidMid(""), false);
        assert.equal(userid.IsValidMid("a".repeat(constants.MID_MAX_LENGTH + 1)), false);
        // 영문/숫자로 제한해야 XOR 숫자열끼리 충돌하지 않는다 (CLAUDE.md 흐름 3번)
        assert.equal(userid.IsValidMid("a-b"), false);
        assert.equal(userid.IsValidMid("홍길동"), false);
    });

    it("문자열이 아닌 값을 거부한다", () => {
        assert.equal(userid.IsValidMid(undefined), false);
        assert.equal(userid.IsValidMid(42), false);
    });
});

describe("IsValidGender", () => {
    it("F 와 M 만 통과시킨다", () => {
        assert.equal(userid.IsValidGender("F"), true);
        assert.equal(userid.IsValidGender("M"), true);
    });

    it("그 외 값은 거부한다 (소문자 포함)", () => {
        assert.equal(userid.IsValidGender("f"), false);
        assert.equal(userid.IsValidGender("m"), false);
        assert.equal(userid.IsValidGender(""), false);
        assert.equal(userid.IsValidGender("X"), false);
        assert.equal(userid.IsValidGender(undefined), false);
    });
});

describe("IsValidPhone", () => {
    it("1~100자 문자열을 통과시킨다 (형식은 자유)", () => {
        assert.equal(userid.IsValidPhone("01012345678"), true);
        assert.equal(userid.IsValidPhone("010-1234-5678"), true);
        assert.equal(userid.IsValidPhone("1"), true);
        assert.equal(userid.IsValidPhone("9".repeat(constants.PHONE_MAX_LENGTH)), true);
    });

    it("빈 값은 거부한다 (phone 은 필수)", () => {
        assert.equal(userid.IsValidPhone(""), false);
    });

    it("DB 컬럼 길이(100자)를 넘으면 거부한다", () => {
        assert.equal(userid.IsValidPhone("9".repeat(constants.PHONE_MAX_LENGTH + 1)), false);
    });

    it("문자열이 아닌 값을 거부한다", () => {
        assert.equal(userid.IsValidPhone(undefined), false);
        assert.equal(userid.IsValidPhone(1012345678), false);
    });
});

describe("GetDefaultAvatar", () => {
    it("성별별 기본 아바타를 준다", () => {
        assert.equal(userid.GetDefaultAvatar("M"), constants.DEFAULT_AVATAR_BY_GENDER.M);
        assert.equal(userid.GetDefaultAvatar("F"), constants.DEFAULT_AVATAR_BY_GENDER.F);
    });

    it("검사되지 않은 값이면 빈 문자열을 준다 (throw 하지 않는다)", () => {
        assert.equal(userid.GetDefaultAvatar("X"), "");
        assert.equal(userid.GetDefaultAvatar(""), "");
    });
});
