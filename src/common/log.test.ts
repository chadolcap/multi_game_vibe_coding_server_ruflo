// log.ts 단위 테스트 — 로그 마스킹 규칙.
// ⚠️ 이 파일은 "편의 기능" 테스트가 아니라 보안 요구사항 회귀 방지용이다.
// 2026-10-06 에 실제로 관리자 비밀번호가 평문으로 stdout → PM2 로그에 남고 있던 문제를 고쳤고
// (마스킹 replacer 가 phone 키 하나만 처리하고 있었다), 같은 일이 재발하지 않도록 고정한다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as log from "./log.js";
import * as types from "./types.js";

describe("MaskPhone", () => {
    it("5자 이상이면 뒤 4자리만 남긴다", () => {
        assert.equal(log.MaskPhone("01012345678"), "*******5678");
        assert.equal(log.MaskPhone("12345"), "*2345");
    });

    it("4자 이하면 전부 가린다 (뒤 4자리를 남기면 원본이 그대로 드러나므로)", () => {
        assert.equal(log.MaskPhone("1234"), "****");
        assert.equal(log.MaskPhone("1"), "*");
    });

    it("마스킹한 결과는 원본과 길이가 같다 (로그 가독성 유지)", () => {
        const phone = "010-1234-5678";
        assert.equal(log.MaskPhone(phone).length, phone.length);
    });

    it("문자열이 아니거나 빈 값이면 그대로 문자열화한다", () => {
        assert.equal(log.MaskPhone(""), "");
        assert.equal(log.MaskPhone(undefined), "undefined");
        assert.equal(log.MaskPhone(null), "null");
    });
});

describe("StringifyPayload — 자격증명 보호", () => {
    it("ADMIN_LOGIN payload 는 통째로 생략한다 (id, password 둘 다 남기지 않는다)", () => {
        const text = log.StringifyPayload(types.MessageType.ADMIN_LOGIN, {
            id: "superadmin",
            password: "hunter2-very-secret",
        });

        assert.equal(text, "[민감 데이터 생략]");
        assert.ok(!text.includes("hunter2-very-secret"), "비밀번호가 로그에 남았다");
        // 관리자 계정명도 자격증명의 절반이라 함께 가려야 한다
        assert.ok(!text.includes("superadmin"), "관리자 계정명이 로그에 남았다");
    });

    it("ADMIN_LOGIN 외의 메시지에 password 가 섞여 와도 값을 가린다 (2차 방어선)", () => {
        const text = log.StringifyPayload(types.MessageType.ENTER_LOBBY, {
            partner: "p1",
            password: "leaked-secret",
        });

        assert.ok(!text.includes("leaked-secret"), "비밀번호가 로그에 남았다");
        assert.ok(text.includes("p1"), "비밀이 아닌 필드는 그대로 남아야 한다");
    });

    it("중첩된 비밀 필드도 가린다", () => {
        const text = log.StringifyPayload("ANY_TYPE", { outer: { inner: { token: "secret-token" } } });
        assert.ok(!text.includes("secret-token"), "중첩된 token 이 로그에 남았다");
    });

    it("비밀 필드는 뒷자리도 남기지 않는다 (phone 과 다른 규칙)", () => {
        const text = log.StringifyPayload("ANY_TYPE", { password: "abcdefgh" });
        assert.ok(!text.includes("efgh"), "비밀번호 뒷자리가 로그에 남았다");
    });

    it("type 을 모르는(undefined) 경우에도 비밀 필드를 가린다", () => {
        const text = log.StringifyPayload(undefined, { password: "no-type-secret" });
        assert.ok(!text.includes("no-type-secret"));
    });
});

describe("StringifyPayload — 개인정보/통계 보호", () => {
    it("phone 은 마스킹하되 뒤 4자리는 남긴다", () => {
        const text = log.StringifyPayload(types.MessageType.ENTER_LOBBY, {
            partner: "p1",
            mid: "user1",
            gender: "M",
            phone: "01012345678",
        });

        assert.ok(!text.includes("01012345678"), "phone 원본이 로그에 남았다");
        assert.ok(text.includes("5678"), "운영상 식별을 위해 뒤 4자리는 남긴다");
    });

    it("중첩된 phone 도 마스킹한다", () => {
        const text = log.StringifyPayload("ANY_TYPE", { user: { phone: "01099998888" } });
        assert.ok(!text.includes("01099998888"));
        assert.ok(text.includes("8888"));
    });

    it("통계성 메시지는 payload 를 생략한다 (유저 플레이 기록/순위 유출 방지)", () => {
        for (const type of [
            types.MessageType.PLAY_INFO,
            types.MessageType.RANK_DAILY,
            types.MessageType.RANK_WEEKLY,
            types.MessageType.GAME_RESULT,
        ]) {
            assert.equal(log.StringifyPayload(type, { total_game_count: 123 }), "[통계 데이터 생략]", `${type} 가 생략되지 않았다`);
        }
    });
});

describe("StringifyPayload — 그 외 동작", () => {
    it("비밀/통계가 아닌 payload 는 JSON 으로 그대로 남긴다", () => {
        assert.equal(log.StringifyPayload(types.MessageType.READY, { ready: "Y" }), '{"ready":"Y"}');
    });

    it("너무 긴 payload 는 잘라낸다", () => {
        const text = log.StringifyPayload("ANY_TYPE", { data: "x".repeat(1000) });
        assert.ok(text.length <= 501, `잘리지 않았다 (길이 ${text.length})`);
        assert.ok(text.endsWith("…"));
    });

    it("JSON 으로 직렬화할 수 없는 값(순환 참조)에도 예외를 던지지 않는다", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        assert.doesNotThrow(() => log.StringifyPayload("ANY_TYPE", circular));
    });
});
