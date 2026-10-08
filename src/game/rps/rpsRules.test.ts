// rpsRules.ts 단위 테스트 — 가위바위보 승패 판정과 승률 계산.
// 게임의 핵심 규칙이라, 바뀌면 점수/랭킹/DB 로그까지 전부 틀어진다. 9가지 조합을 모두 고정한다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as rpsRules from "./rpsRules.js";
import type { RpsChoice } from "./rpsTypes.js";

const ALL_CHOICES: RpsChoice[] = ["가위", "바위", "보"];

describe("JudgeChoice", () => {
    it("같은 값이면 무승부(0)다 — 무승부 판은 승수에 들어가지 않는다", () => {
        for (const choice of ALL_CHOICES) {
            assert.equal(rpsRules.JudgeChoice(choice, choice), 0, `${choice} 끼리 무승부가 아니다`);
        }
    });

    it("a 가 이기면 1 이다 (가위>보, 바위>가위, 보>바위)", () => {
        assert.equal(rpsRules.JudgeChoice("가위", "보"), 1);
        assert.equal(rpsRules.JudgeChoice("바위", "가위"), 1);
        assert.equal(rpsRules.JudgeChoice("보", "바위"), 1);
    });

    it("a 가 지면 -1 이다", () => {
        assert.equal(rpsRules.JudgeChoice("보", "가위"), -1);
        assert.equal(rpsRules.JudgeChoice("가위", "바위"), -1);
        assert.equal(rpsRules.JudgeChoice("바위", "보"), -1);
    });

    it("순서를 바꾸면 결과도 반대가 된다 (반대칭) — player1/player2 를 어느 쪽에 넣어도 공평해야 한다", () => {
        for (const a of ALL_CHOICES) {
            for (const b of ALL_CHOICES) {
                // 합이 0 인지로 확인한다. `-JudgeChoice(b, a)` 로 비교하면 무승부(0)일 때 -0 이 되고,
                // node:assert/strict 는 Object.is 를 쓰므로 0 과 -0 을 다른 값으로 본다.
                assert.equal(rpsRules.JudgeChoice(a, b) + rpsRules.JudgeChoice(b, a), 0, `${a} vs ${b} 가 반대칭이 아니다`);
            }
        }
    });

    it("9가지 조합 모두 -1, 0, 1 중 하나만 돌려준다", () => {
        for (const a of ALL_CHOICES) {
            for (const b of ALL_CHOICES) {
                assert.ok([-1, 0, 1].includes(rpsRules.JudgeChoice(a, b)), `${a} vs ${b} 결과가 범위를 벗어났다`);
            }
        }
    });

    it("모든 선택은 정확히 하나를 이기고 하나에게 진다 (규칙에 우열이 없다)", () => {
        for (const choice of ALL_CHOICES) {
            const wins = ALL_CHOICES.filter((other) => rpsRules.JudgeChoice(choice, other) === 1);
            const loses = ALL_CHOICES.filter((other) => rpsRules.JudgeChoice(choice, other) === -1);
            assert.equal(wins.length, 1, `${choice} 가 이기는 상대가 1개가 아니다`);
            assert.equal(loses.length, 1, `${choice} 가 지는 상대가 1개가 아니다`);
        }
    });
});

describe("ComputeWinPer", () => {
    it("한 판도 안 한 유저는 0 이다 (0으로 나누지 않는다)", () => {
        assert.equal(rpsRules.ComputeWinPer(0, 0), 0);
    });

    it("승률을 0~100 정수로 준다", () => {
        assert.equal(rpsRules.ComputeWinPer(1, 2), 50);
        assert.equal(rpsRules.ComputeWinPer(10, 10), 100);
        assert.equal(rpsRules.ComputeWinPer(0, 10), 0);
        assert.equal(rpsRules.ComputeWinPer(1, 4), 25);
    });

    it("반올림한다 (1/3 = 33.33% → 33)", () => {
        assert.equal(rpsRules.ComputeWinPer(1, 3), 33);
        assert.equal(rpsRules.ComputeWinPer(2, 3), 67);
    });

    it("항상 정수를 준다 — 와이어 프로토콜 win_per 가 0~100 정수다", () => {
        for (let total = 1; total <= 20; total++) {
            for (let win = 0; win <= total; win++) {
                const win_per = rpsRules.ComputeWinPer(win, total);
                assert.ok(Number.isInteger(win_per), `${win}/${total} 가 정수가 아니다`);
                assert.ok(win_per >= 0 && win_per <= 100, `${win}/${total} 가 범위를 벗어났다`);
            }
        }
    });

    it("이번 판 결과를 더한 예상값도 계산할 수 있다 (FinishGame 이 쓰는 방식)", () => {
        // 승자: 기존 0승 0판 → 이번 판 포함 1승 1판 = 100%
        assert.equal(rpsRules.ComputeWinPer(0 + 1, 0 + 1), 100);
        // 패자: 기존 0승 0판 → 이번 판 포함 0승 1판 = 0%
        assert.equal(rpsRules.ComputeWinPer(0, 0 + 1), 0);
    });
});

describe("BEATS", () => {
    it("세 선택 모두 이기는 상대가 정의되어 있다", () => {
        for (const choice of ALL_CHOICES) {
            assert.ok(ALL_CHOICES.includes(rpsRules.BEATS[choice]), `${choice} 의 상대가 올바르지 않다`);
            assert.notEqual(rpsRules.BEATS[choice], choice, `${choice} 가 자기 자신을 이긴다`);
        }
    });
});
