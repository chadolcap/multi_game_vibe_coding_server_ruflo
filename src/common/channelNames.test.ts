// channelNames.ts 단위 테스트 — 채널 룸 이름 / 채널 ID 규칙.
// ⚠️ 이 규칙은 클라이언트와 공유하는 와이어 값이다 (MATCH_FOUND.room_name 등). 2026-10-02 "게임별
// 분리 구조"에서 game_N → rps_N 으로 바뀌면서 클라이언트도 영향을 받았으므로, 그 형식을 고정한다.
// GetChannelPort 는 .env(config) 값에 따라 결과가 달라져 환경 의존이라 여기서 다루지 않는다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as channelNames from "./channelNames.js";

describe("GetChannelRoomName", () => {
    it("로비는 lobby_N 형식이다 (채널 번호는 1부터)", () => {
        assert.equal(channelNames.GetChannelRoomName("lobby", 1), "lobby_1");
        assert.equal(channelNames.GetChannelRoomName("lobby", 2), "lobby_2");
    });

    it("가위바위보는 rps_N 형식이다 (예전 game_N 이 아니다)", () => {
        assert.equal(channelNames.GetChannelRoomName("rps", 1), "rps_1");
        assert.equal(channelNames.GetChannelRoomName("rps", 3), "rps_3");
    });

    it("watcher 는 채널이 1개뿐이라 번호를 붙이지 않는다", () => {
        assert.equal(channelNames.GetChannelRoomName("watcher", 1), "watcher");
    });
});

describe("ParseChannelNo", () => {
    it("룸 이름 끝의 번호를 뽑는다", () => {
        assert.equal(channelNames.ParseChannelNo("rps_2"), 2);
        assert.equal(channelNames.ParseChannelNo("lobby_1"), 1);
        assert.equal(channelNames.ParseChannelNo("rps_10"), 10);
    });

    it("GetChannelRoomName 과 왕복한다", () => {
        for (const channel_no of [1, 2, 3]) {
            assert.equal(channelNames.ParseChannelNo(channelNames.GetChannelRoomName("rps", channel_no)), channel_no);
            assert.equal(channelNames.ParseChannelNo(channelNames.GetChannelRoomName("lobby", channel_no)), channel_no);
        }
    });

    it("번호가 없는 이름이면 throw 한다 (watcher 룸 포함)", () => {
        assert.throws(() => channelNames.ParseChannelNo("watcher"));
        assert.throws(() => channelNames.ParseChannelNo("rps"));
        assert.throws(() => channelNames.ParseChannelNo(""));
        assert.throws(() => channelNames.ParseChannelNo("rps_abc"));
    });
});

describe("ALL_GAME_TYPES / IsGameType", () => {
    it("지원하는 게임 목록이 비어 있지 않다", () => {
        assert.ok(channelNames.ALL_GAME_TYPES.length > 0);
        assert.ok(channelNames.ALL_GAME_TYPES.includes("rps"));
    });

    it("지원하는 게임 목록에 rps 와 othello 가 있다 (2026-10-07 오델로 추가)", () => {
        assert.equal(channelNames.IsGameType("othello"), true);
    });

    it("목록에 있는 값만 통과시킨다 (관리자/로비 메시지의 game 런타임 검사용)", () => {
        for (const game of channelNames.ALL_GAME_TYPES) {
            assert.equal(channelNames.IsGameType(game), true, `${game} 가 거부됐다`);
        }
    });

    it("목록에 없는 값과 문자열이 아닌 값을 거부한다", () => {
        assert.equal(channelNames.IsGameType("chess"), false); // 아직 없는 게임
        assert.equal(channelNames.IsGameType(""), false);
        assert.equal(channelNames.IsGameType("RPS"), false); // 대소문자 구분
        assert.equal(channelNames.IsGameType("OTHELLO"), false);
        assert.equal(channelNames.IsGameType(undefined), false);
        assert.equal(channelNames.IsGameType(1), false);
    });
});

describe("ParseGameTypeFromRoomName", () => {
    it("게임 룸 이름에서 게임 종류를 뽑는다 (REJOIN_GAME 의 game 필드용)", () => {
        assert.equal(channelNames.ParseGameTypeFromRoomName("rps_1"), "rps");
        assert.equal(channelNames.ParseGameTypeFromRoomName("othello_1"), "othello");
        assert.equal(channelNames.ParseGameTypeFromRoomName("othello_3"), "othello");
    });

    it("게임 룸이 아니면 undefined 다", () => {
        assert.equal(channelNames.ParseGameTypeFromRoomName("lobby_1"), undefined);
        assert.equal(channelNames.ParseGameTypeFromRoomName("watcher"), undefined);
        assert.equal(channelNames.ParseGameTypeFromRoomName(""), undefined);
        assert.equal(channelNames.ParseGameTypeFromRoomName("chess_1"), undefined);
    });

    it("GetChannelRoomName 과 왕복한다", () => {
        for (const game of channelNames.ALL_GAME_TYPES) {
            assert.equal(channelNames.ParseGameTypeFromRoomName(channelNames.GetChannelRoomName(game, 1)), game);
        }
    });
});

describe("GetGameChannelCount", () => {
    it("지원하는 게임마다 1 이상의 채널 수를 준다", () => {
        for (const game of channelNames.ALL_GAME_TYPES) {
            const count = channelNames.GetGameChannelCount(game);
            assert.ok(Number.isInteger(count) && count >= 1, `${game} 채널 수가 ${count} 다`);
        }
    });

    it("각 채널 번호로 룸 이름을 만들 수 있다 (관리자 channel 화이트리스트가 이 조합을 쓴다)", () => {
        for (const game of channelNames.ALL_GAME_TYPES) {
            for (let channel_no = 1; channel_no <= channelNames.GetGameChannelCount(game); channel_no++) {
                assert.equal(channelNames.GetChannelRoomName(game, channel_no), `${game}_${channel_no}`);
            }
        }
    });
});

describe("GetChannelId", () => {
    it("로그/통계 표시용 ID 는 하이픈으로 잇는다 (룸 이름은 밑줄)", () => {
        assert.equal(channelNames.GetChannelId("lobby", 1), "lobby-1");
        assert.equal(channelNames.GetChannelId("rps", 3), "rps-3");
        assert.equal(channelNames.GetChannelId("watcher", 1), "watcher-1");
    });
});
