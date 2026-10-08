// nameFilter.ts 단위 테스트 — 별명(NAME) 형식 검사와 금칙어 필터.
// ⚠️ BANNED_WORDS 목록을 운영팀 목록으로 교체할 때, "부분 일치 + 대소문자 무시"라는 동작 자체가
// 유지되는지 이 테스트로 확인한다 (목록의 구체적인 단어에 의존하지 않도록 최소한만 검증).
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as constants from "./constants.js";
import * as nameFilter from "./nameFilter.js";

describe("IsValidNameFormat", () => {
    it("일반적인 별명을 통과시킨다", () => {
        assert.equal(nameFilter.IsValidNameFormat("홍길동"), true);
        assert.equal(nameFilter.IsValidNameFormat("player1"), true);
        assert.equal(nameFilter.IsValidNameFormat("a"), true);
    });

    it("앞뒤 공백을 제거한 길이로 판단한다", () => {
        assert.equal(nameFilter.IsValidNameFormat("  a  "), true);
        // 공백만 있는 별명은 trim 후 빈 문자열이라 거부
        assert.equal(nameFilter.IsValidNameFormat("   "), false);
        assert.equal(nameFilter.IsValidNameFormat("\t\n"), false);
    });

    it("빈 문자열을 거부한다", () => {
        assert.equal(nameFilter.IsValidNameFormat(""), false);
    });

    it("NAME_MAX_LENGTH 경계를 지킨다 (DB 컬럼 길이와 맞춘 값)", () => {
        assert.equal(nameFilter.IsValidNameFormat("가".repeat(constants.NAME_MAX_LENGTH)), true);
        assert.equal(nameFilter.IsValidNameFormat("가".repeat(constants.NAME_MAX_LENGTH + 1)), false);
    });

    it("문자열이 아닌 값을 거부한다", () => {
        assert.equal(nameFilter.IsValidNameFormat(undefined), false);
        assert.equal(nameFilter.IsValidNameFormat(null), false);
        assert.equal(nameFilter.IsValidNameFormat(123), false);
        assert.equal(nameFilter.IsValidNameFormat(["이름"]), false);
    });
});

describe("ContainsBannedWord", () => {
    it("금칙어가 없는 별명은 통과시킨다", () => {
        assert.equal(nameFilter.ContainsBannedWord("홍길동"), false);
        assert.equal(nameFilter.ContainsBannedWord("player1"), false);
        assert.equal(nameFilter.ContainsBannedWord(""), false);
    });

    it("금칙어가 그대로 들어오면 잡아낸다", () => {
        assert.equal(nameFilter.ContainsBannedWord("병신"), true);
    });

    it("부분 일치로 잡아낸다 (앞뒤에 다른 글자가 붙어도)", () => {
        assert.equal(nameFilter.ContainsBannedWord("나는병신이다"), true);
        assert.equal(nameFilter.ContainsBannedWord("xxfuckxx"), true);
    });

    it("대소문자를 구분하지 않는다", () => {
        assert.equal(nameFilter.ContainsBannedWord("FUCK"), true);
        assert.equal(nameFilter.ContainsBannedWord("FuCk"), true);
        assert.equal(nameFilter.ContainsBannedWord("SHIT"), true);
    });
});
