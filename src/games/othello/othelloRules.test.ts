// othelloRules.ts 단위 테스트 — 오델로 규칙 전체 (2026-10-07).
// 이 규칙이 틀리면 게임 진행·승패·점수·DB 로그가 전부 어긋난다. 특히 **좌표계(0~7, board[y][x])** 와
// 초기 배치는 클라이언트와의 와이어 계약이라, 여기서 못박아 둔다.
// 실행: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as othelloConstants from "./othelloConstants.js";
import * as othelloRules from "./othelloRules.js";
import type { OthelloBoard, OthelloColor, OthelloPoint } from "./othelloTypes.js";
import { OTHELLO_BLACK, OTHELLO_EMPTY, OTHELLO_WHITE } from "./othelloTypes.js";

// 좌표 목록을 비교하기 쉽게 "x,y" 문자열 집합으로 바꾼다 (순서 무관 비교용).
function ToKeySet(points: OthelloPoint[]): Set<string> {
    return new Set(points.map((p) => `${p.x},${p.y}`));
}

// 사람이 읽을 수 있는 문자열로 보드를 만든다. '.'=빈칸, 'B'=검정, 'W'=흰색.
// 테스트에서 특정 국면을 만들 때 쓴다 — 8줄 × 8글자.
function ParseBoard(rows: string[]): OthelloBoard {
    assert.equal(rows.length, othelloConstants.OTHELLO_BOARD_SIZE, "보드는 8줄이어야 한다");
    return rows.map((row) => {
        assert.equal(row.length, othelloConstants.OTHELLO_BOARD_SIZE, "한 줄은 8글자여야 한다");
        return [...row].map((ch) => (ch === "B" ? OTHELLO_BLACK : ch === "W" ? OTHELLO_WHITE : OTHELLO_EMPTY));
    });
}

describe("CreateInitialBoard", () => {
    it("8x8 보드를 만든다", () => {
        const board = othelloRules.CreateInitialBoard();
        assert.equal(board.length, 8);
        for (const row of board) assert.equal(row.length, 8);
    });

    it("중앙 4칸만 채워지고 나머지는 빈 칸이다 (돌 2:2)", () => {
        const counts = othelloRules.CountStones(othelloRules.CreateInitialBoard());
        assert.deepEqual(counts, { black: 2, white: 2, empty: 60 });
    });

    it("표준 배치를 0-based 좌표로 고정한다 — (3,3)·(4,4) 백, (4,3)·(3,4) 흑", () => {
        // ⚠️ board[y][x] 순서다. 이 단정이 깨지면 클라이언트와 좌표계가 어긋난다.
        const board = othelloRules.CreateInitialBoard();
        assert.equal(board[3][3], OTHELLO_WHITE);
        assert.equal(board[4][4], OTHELLO_WHITE);
        assert.equal(board[3][4], OTHELLO_BLACK);
        assert.equal(board[4][3], OTHELLO_BLACK);
    });

    it("같은 색이 대각선으로 마주본다", () => {
        const board = othelloRules.CreateInitialBoard();
        assert.equal(board[3][3], board[4][4]); // 백 대각선
        assert.equal(board[3][4], board[4][3]); // 흑 대각선
        assert.notEqual(board[3][3], board[3][4]);
    });
});

describe("GetLegalMoves — 초기 국면", () => {
    it("검정(선공)은 4곳에 둘 수 있다", () => {
        const moves = othelloRules.GetLegalMoves(othelloRules.CreateInitialBoard(), OTHELLO_BLACK);
        assert.equal(moves.length, 4);
        assert.deepEqual(ToKeySet(moves), new Set(["3,2", "2,3", "5,4", "4,5"]));
    });

    it("흰색도 4곳에 둘 수 있다", () => {
        const moves = othelloRules.GetLegalMoves(othelloRules.CreateInitialBoard(), OTHELLO_WHITE);
        assert.equal(moves.length, 4);
        assert.deepEqual(ToKeySet(moves), new Set(["4,2", "5,3", "2,4", "3,5"]));
    });

    it("두 색의 합법수가 겹치지 않는다 (초기 국면 대칭성)", () => {
        const board = othelloRules.CreateInitialBoard();
        const black = ToKeySet(othelloRules.GetLegalMoves(board, OTHELLO_BLACK));
        for (const key of ToKeySet(othelloRules.GetLegalMoves(board, OTHELLO_WHITE))) {
            assert.equal(black.has(key), false, `${key} 가 양쪽 합법수에 모두 있다`);
        }
    });
});

describe("GetFlips", () => {
    it("초기 국면에서 (3,2) 에 검정을 놓으면 (3,3) 백 하나가 뒤집힌다", () => {
        const flips = othelloRules.GetFlips(othelloRules.CreateInitialBoard(), 3, 2, OTHELLO_BLACK);
        assert.deepEqual(flips, [{ x: 3, y: 3 }]);
    });

    it("빈 칸이 아니면 뒤집을 수 없다 (이미 돌이 있는 자리)", () => {
        const board = othelloRules.CreateInitialBoard();
        assert.deepEqual(othelloRules.GetFlips(board, 3, 3, OTHELLO_BLACK), []);
        assert.deepEqual(othelloRules.GetFlips(board, 4, 3, OTHELLO_BLACK), []);
    });

    it("보드 밖 좌표는 빈 배열이다", () => {
        const board = othelloRules.CreateInitialBoard();
        for (const [x, y] of [[-1, 0], [0, -1], [8, 0], [0, 8], [99, 99]]) {
            assert.deepEqual(othelloRules.GetFlips(board, x, y, OTHELLO_BLACK), [], `(${x},${y})`);
        }
    });

    it("상대 돌만 있고 내 돌로 닫히지 않으면 뒤집지 못한다", () => {
        // 가운데 줄에 흰 돌만 늘어놓고, 끝을 내 돌로 막지 않은 상태
        const board = ParseBoard([
            "........",
            "........",
            "........",
            ".WWW....",
            "........",
            "........",
            "........",
            "........",
        ]);
        assert.deepEqual(othelloRules.GetFlips(board, 0, 3, OTHELLO_BLACK), []);
    });

    it("중간에 빈 칸이 있으면 그 방향은 뒤집지 못한다", () => {
        const board = ParseBoard([
            "........",
            "........",
            "........",
            ".W.WB...",
            "........",
            "........",
            "........",
            "........",
        ]);
        // (0,3) 검정 → 오른쪽으로 W, 빈칸 … 이라 끊긴다
        assert.deepEqual(othelloRules.GetFlips(board, 0, 3, OTHELLO_BLACK), []);
    });

    it("8방향을 모두 본다 — 가운데에 놓으면 8개가 한꺼번에 뒤집힌다", () => {
        // (3,3) 을 비우고 그 **8방향 이웃을 전부 백**, 그 바로 바깥(거리 2)을 **검정**으로 둘러싼다.
        // 그러면 (3,3) 에 검정을 놓을 때 8방향이 각각 "백 1개 → 검정" 으로 닫혀 8개가 뒤집힌다.
        const board = ParseBoard([
            "........",
            ".B.B.B..", // (1,1) (3,1) (5,1) 검정 — 위쪽 거리 2
            "..WWW...", // (2,2) (3,2) (4,2) 백 — 위쪽 이웃
            ".BW.WB..", // (1,3) 검정 / (2,3) 백 / (3,3) 빈칸 / (4,3) 백 / (5,3) 검정
            "..WWW...", // 아래쪽 이웃
            ".B.B.B..", // 아래쪽 거리 2
            "........",
            "........",
        ]);
        const flips = othelloRules.GetFlips(board, 3, 3, OTHELLO_BLACK);

        assert.equal(flips.length, 8, `8방향이 모두 뒤집혀야 한다 (실제 ${flips.length})`);
        assert.deepEqual(
            ToKeySet(flips),
            new Set(["2,2", "3,2", "4,2", "2,3", "4,3", "2,4", "3,4", "4,4"])
        );
    });

    it("한 방향에서 연속된 상대 돌 여러 개를 모두 뒤집는다", () => {
        const board = ParseBoard([
            "........",
            "........",
            "........",
            ".WWWB...",
            "........",
            "........",
            "........",
            "........",
        ]);
        const flips = othelloRules.GetFlips(board, 0, 3, OTHELLO_BLACK);
        assert.deepEqual(ToKeySet(flips), new Set(["1,3", "2,3", "3,3"]));
    });
});

describe("ApplyMove", () => {
    it("놓은 자리와 뒤집힌 자리가 모두 내 색이 된다", () => {
        const board = othelloRules.CreateInitialBoard();
        const flips = othelloRules.ApplyMove(board, 3, 2, OTHELLO_BLACK);

        assert.deepEqual(flips, [{ x: 3, y: 3 }]);
        assert.equal(board[2][3], OTHELLO_BLACK, "놓은 자리");
        assert.equal(board[3][3], OTHELLO_BLACK, "뒤집힌 자리");
    });

    it("한 수를 두면 돌 수가 (내 +1 +뒤집은 수) / (상대 -뒤집은 수) 가 된다", () => {
        const board = othelloRules.CreateInitialBoard();
        othelloRules.ApplyMove(board, 3, 2, OTHELLO_BLACK);
        assert.deepEqual(othelloRules.CountStones(board), { black: 4, white: 1, empty: 59 });
    });

    it("합법수가 아니면 null 을 주고 보드를 건드리지 않는다", () => {
        const board = othelloRules.CreateInitialBoard();
        const before = JSON.stringify(board);

        assert.equal(othelloRules.ApplyMove(board, 0, 0, OTHELLO_BLACK), null);
        assert.equal(othelloRules.ApplyMove(board, 3, 3, OTHELLO_BLACK), null); // 이미 돌이 있는 자리
        assert.equal(othelloRules.ApplyMove(board, -1, 0, OTHELLO_BLACK), null);
        assert.equal(JSON.stringify(board), before, "보드가 바뀌었다");
    });
});

describe("IsGameOver / 패스", () => {
    it("초기 국면은 종료가 아니다", () => {
        assert.equal(othelloRules.IsGameOver(othelloRules.CreateInitialBoard()), false);
    });

    it("보드가 꽉 차면 종료다", () => {
        const board = ParseBoard([
            "BBBBBBBB",
            "BBBBBBBB",
            "BBBBBBBB",
            "BBBBWWWW",
            "WWWWWWWW",
            "WWWWWWWW",
            "WWWWWWWW",
            "WWWWWWWW",
        ]);
        assert.equal(othelloRules.IsGameOver(board), true);
    });

    it("한쪽 돌이 전멸하면 종료다 (끼울 상대가 없다)", () => {
        const board = ParseBoard([
            "BB......",
            "........",
            "........",
            "........",
            "........",
            "........",
            "........",
            "........",
        ]);
        assert.equal(othelloRules.GetLegalMoves(board, OTHELLO_BLACK).length, 0);
        assert.equal(othelloRules.GetLegalMoves(board, OTHELLO_WHITE).length, 0);
        assert.equal(othelloRules.IsGameOver(board), true);
    });

    it("한쪽만 둘 곳이 없으면 패스이고 종료는 아니다", () => {
        // 흑은 둘 곳이 있지만 백은 없는 국면.
        // ⚠️ 검정 줄이 **보드 오른쪽 끝까지 닿아야** 백이 둘 곳이 없어진다 — "WBB....." 처럼 두면
        //    백이 (3,0) 에 놓아 검정 둘을 끼울 수 있다(처음에 이렇게 썼다가 테스트가 실패했다).
        const board = ParseBoard([
            ".....WBB",
            "........",
            "........",
            "........",
            "........",
            "........",
            "........",
            "........",
        ]);
        const white_moves = othelloRules.GetLegalMoves(board, OTHELLO_WHITE);
        const black_moves = othelloRules.GetLegalMoves(board, OTHELLO_BLACK);

        assert.equal(white_moves.length, 0, "백은 둘 곳이 없어야 한다");
        assert.ok(black_moves.length > 0, "흑은 둘 곳이 있어야 한다");
        assert.equal(othelloRules.IsGameOver(board), false, "한쪽만 막힌 건 패스일 뿐 종료가 아니다");
    });
});

describe("CountStones", () => {
    it("빈 보드는 전부 빈 칸이다", () => {
        const board = ParseBoard(new Array(8).fill("........"));
        assert.deepEqual(othelloRules.CountStones(board), { black: 0, white: 0, empty: 64 });
    });

    it("세 값의 합은 항상 64 다", () => {
        for (const board of [
            othelloRules.CreateInitialBoard(),
            ParseBoard(["BWBWBWBW", "WBWBWBWB", "BWBWBWBW", "WBWBWBWB", "BWBWBWBW", "WBWBWBWB", "BWBWBWBW", "WBWBWBWB"]),
        ]) {
            const c = othelloRules.CountStones(board);
            assert.equal(c.black + c.white + c.empty, 64);
        }
    });
});

describe("GetStonePositions", () => {
    it("초기 보드의 흑/백 좌표를 정확히 돌려준다 (GAME_STATUS 의 status0/status1)", () => {
        const board = othelloRules.CreateInitialBoard();
        assert.deepEqual(ToKeySet(othelloRules.GetStonePositions(board, OTHELLO_BLACK)), new Set(["4,3", "3,4"]));
        assert.deepEqual(ToKeySet(othelloRules.GetStonePositions(board, OTHELLO_WHITE)), new Set(["3,3", "4,4"]));
    });

    it("개수가 CountStones 와 일치한다", () => {
        const board = othelloRules.CreateInitialBoard();
        othelloRules.ApplyMove(board, 3, 2, OTHELLO_BLACK);

        const counts = othelloRules.CountStones(board);
        assert.equal(othelloRules.GetStonePositions(board, OTHELLO_BLACK).length, counts.black);
        assert.equal(othelloRules.GetStonePositions(board, OTHELLO_WHITE).length, counts.white);
    });

    it("두 색의 좌표가 겹치지 않고, 합치면 빈 칸을 뺀 전체가 된다", () => {
        const board = ParseBoard([
            "BWBW....",
            "........",
            "...BW...",
            "........",
            "........",
            "........",
            "........",
            "......WB",
        ]);
        const black = ToKeySet(othelloRules.GetStonePositions(board, OTHELLO_BLACK));
        const white = ToKeySet(othelloRules.GetStonePositions(board, OTHELLO_WHITE));

        for (const key of black) assert.equal(white.has(key), false, `${key} 가 양쪽에 있다`);
        const counts = othelloRules.CountStones(board);
        assert.equal(black.size + white.size, counts.black + counts.white);
        assert.equal(black.size + white.size, 64 - counts.empty);
    });

    it("그 색 돌이 없으면 빈 배열이다", () => {
        const board = ParseBoard(["BB......", "........", "........", "........", "........", "........", "........", "........"]);
        assert.deepEqual(othelloRules.GetStonePositions(board, OTHELLO_WHITE), []);
    });
});

describe("GetOpponentColor", () => {
    it("두 색을 서로 바꾼다", () => {
        assert.equal(othelloRules.GetOpponentColor(OTHELLO_BLACK), OTHELLO_WHITE);
        assert.equal(othelloRules.GetOpponentColor(OTHELLO_WHITE), OTHELLO_BLACK);
    });

    it("두 번 적용하면 원래 색이다", () => {
        for (const color of [OTHELLO_BLACK, OTHELLO_WHITE] as OthelloColor[]) {
            assert.equal(othelloRules.GetOpponentColor(othelloRules.GetOpponentColor(color)), color);
        }
    });
});

describe("CloneBoard", () => {
    it("복사본을 바꿔도 원본이 안 바뀐다 (한 수를 가정해 볼 때 쓴다)", () => {
        const board = othelloRules.CreateInitialBoard();
        const clone = othelloRules.CloneBoard(board);
        othelloRules.ApplyMove(clone, 3, 2, OTHELLO_BLACK);

        assert.equal(board[2][3], OTHELLO_EMPTY, "원본이 바뀌었다");
        assert.equal(clone[2][3], OTHELLO_BLACK);
    });
});
