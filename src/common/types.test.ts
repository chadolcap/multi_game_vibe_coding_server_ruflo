// types.ts 단위 테스트 — C→S envelope 읽기(ReadPayload).
// ⚠️ 이 동작은 클라이언트와의 계약이다. 통신 프로토콜 문서는 C→S 를 `{payload:{...}}` 로 정의하지만
// 서버가 오랫동안 메시지 최상위를 읽고 있었고(2026-10-06 발견), 어느 쪽인지 확실하지 않아 둘 다
// 받아들이기로 했다. 한쪽만 되도록 되돌아가면 클라이언트 전체가 깨지므로 양쪽을 모두 고정한다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as types from "./types.js";

describe("ReadPayload — 문서 형식 (envelope)", () => {
    it("payload 가 있으면 그 안을 돌려준다", () => {
        assert.deepEqual(types.ReadPayload({ payload: { select: "Y" } }), { select: "Y" });
    });

    it("type/ts 가 함께 와도 payload 만 꺼낸다", () => {
        const envelope = { type: "JOIN_MATCH", payload: { select: "Y", game: "rps" }, ts: "10-06 16:00:00:00" };
        assert.deepEqual(types.ReadPayload(envelope), { select: "Y", game: "rps" });
    });

    it("ADMIN_LOGIN 처럼 자격증명이 담긴 payload 도 그대로 꺼낸다", () => {
        assert.deepEqual(types.ReadPayload({ payload: { id: "a", password: "b" } }), { id: "a", password: "b" });
    });
});

describe("ReadPayload — 기존 평탄 형식 (하위 호환)", () => {
    it("payload 필드가 없으면 메시지 자체를 돌려준다", () => {
        assert.deepEqual(types.ReadPayload({ select: "Y" }), { select: "Y" });
    });

    it("ENTER_LOBBY 를 평탄하게 보내도 필드가 보존된다", () => {
        const flat = { partner: "p1", mid: "u1", gender: "M", phone: "01012345678" };
        assert.deepEqual(types.ReadPayload(flat), flat);
    });

    it("빈 객체는 빈 객체로 돌려준다 (ENTER_ROOM 처럼 payload 없는 메시지)", () => {
        assert.deepEqual(types.ReadPayload({}), {});
    });
});

describe("ReadPayload — 경계값", () => {
    it("payload 가 명시적으로 undefined/null 이면 그 값을 돌려준다", () => {
        assert.equal(types.ReadPayload({ payload: undefined }), undefined);
        assert.equal(types.ReadPayload({ payload: null }), null);
    });

    it("payload 가 객체가 아니어도 그대로 돌려준다 (형식 검사는 각 핸들러 몫)", () => {
        assert.equal(types.ReadPayload({ payload: "문자열" }), "문자열");
        assert.equal(types.ReadPayload({ payload: 42 }), 42);
    });

    it("객체가 아닌 메시지는 그대로 돌려준다", () => {
        assert.equal(types.ReadPayload(undefined), undefined);
        assert.equal(types.ReadPayload(null), null);
        assert.equal(types.ReadPayload("문자열"), "문자열");
        assert.equal(types.ReadPayload(42), 42);
    });

    it("배열은 그대로 돌려준다 (payload 필드가 없으므로)", () => {
        assert.deepEqual(types.ReadPayload([1, 2]), [1, 2]);
    });
});
