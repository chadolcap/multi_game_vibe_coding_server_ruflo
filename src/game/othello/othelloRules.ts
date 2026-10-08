// 오델로의 순수 규칙 — 보드 생성, 합법수 판정, 뒤집기, 돌 세기, 종료 판정 (2026-10-07 추가).
// 규칙 출처: 나무위키 "오델로(보드게임)" — 8x8, 검정 선공, 8방향 끼우기 뒤집기, 놓을 곳이 없으면 패스,
// 양쪽 모두 놓을 곳이 없으면 종료, 돌이 많은 쪽 승리, 같으면 무승부.
//
// OthelloGameRoom 에서 분리해 둔 이유: 게임 Room 은 db 모듈(결과 저장/유저 캐시)을 값으로 import 해서,
// 규칙 함수만 쓰려 해도 DB 연결 모듈까지 전부 끌고 온다. 외부 의존이 없는 규칙만 여기 모아 두면
// 단위 테스트(othelloRules.test.ts)에서 Redis/MySQL 없이 바로 검증할 수 있다 (rpsRules.ts 와 같은 이유).

import * as othelloConstants from "./othelloConstants.js";
import type { OthelloBoard, OthelloColor, OthelloPoint } from "./othelloTypes.js";
import { OTHELLO_BLACK, OTHELLO_EMPTY, OTHELLO_WHITE } from "./othelloTypes.js";

// 8방향 (가로/세로/대각선). [dx, dy]
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
];

function IsInside(x: number, y: number): boolean {
    const size = othelloConstants.OTHELLO_BOARD_SIZE;
    return x >= 0 && x < size && y >= 0 && y < size;
}

export function GetOpponentColor(color: OthelloColor): OthelloColor {
    return color === OTHELLO_BLACK ? OTHELLO_WHITE : OTHELLO_BLACK;
}

// 초기 보드. 중앙 4칸에 흑/백이 대각선으로 놓인다.
// 표준 표기(d4/e5 흑, d5/e4 백)를 0-based 로 옮기면: (3,3)·(4,4) 백, (4,3)·(3,4) 흑.
// (d=열 3, 4=행 3 / e=열 4, 5=행 4 — 좌표계는 othelloRules.test.ts 가 고정한다)
export function CreateInitialBoard(): OthelloBoard {
    const size = othelloConstants.OTHELLO_BOARD_SIZE;
    const board: OthelloBoard = [];
    for (let y = 0; y < size; y++) {
        board.push(new Array(size).fill(OTHELLO_EMPTY));
    }

    const mid = size / 2; // 8 → 4
    board[mid - 1][mid - 1] = OTHELLO_WHITE; // (3,3)
    board[mid][mid] = OTHELLO_WHITE; // (4,4)
    board[mid - 1][mid] = OTHELLO_BLACK; // (4,3)
    board[mid][mid - 1] = OTHELLO_BLACK; // (3,4)
    return board;
}

// 보드를 깊은 복사한다 (한 수를 가정해 보거나, 상태를 스냅샷으로 남길 때).
export function CloneBoard(board: OthelloBoard): OthelloBoard {
    return board.map((row) => [...row]);
}

// (x,y) 에 color 돌을 놓았을 때 뒤집히는 상대 돌의 좌표 목록.
// 빈 칸이 아니거나 한 개도 못 뒤집으면 빈 배열 — 즉 **빈 배열이면 그 자리는 합법수가 아니다**.
// 한 방향으로 상대 돌이 연속으로 이어지다가 내 돌로 끝나야 그 사이가 전부 뒤집힌다. 중간에 빈 칸이
// 나오거나 보드를 벗어나면 그 방향은 아무것도 못 뒤집는다.
export function GetFlips(board: OthelloBoard, x: number, y: number, color: OthelloColor): OthelloPoint[] {
    if (!IsInside(x, y) || board[y][x] !== OTHELLO_EMPTY) return [];

    const opponent = GetOpponentColor(color);
    const flips: OthelloPoint[] = [];

    for (const [dx, dy] of DIRECTIONS) {
        const line: OthelloPoint[] = [];
        let cx = x + dx;
        let cy = y + dy;

        while (IsInside(cx, cy) && board[cy][cx] === opponent) {
            line.push({ x: cx, y: cy });
            cx += dx;
            cy += dy;
        }

        // 내 돌로 닫혀야 유효하다. 보드 밖이거나 빈 칸이면 이 방향은 버린다.
        if (line.length > 0 && IsInside(cx, cy) && board[cy][cx] === color) {
            flips.push(...line);
        }
    }

    return flips;
}

// color 가 놓을 수 있는 모든 자리. TURN_START 의 `can` 으로 그대로 보낸다.
export function GetLegalMoves(board: OthelloBoard, color: OthelloColor): OthelloPoint[] {
    const size = othelloConstants.OTHELLO_BOARD_SIZE;
    const moves: OthelloPoint[] = [];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (GetFlips(board, x, y, color).length > 0) moves.push({ x, y });
        }
    }
    return moves;
}

export function IsLegalMove(board: OthelloBoard, x: number, y: number, color: OthelloColor): boolean {
    return GetFlips(board, x, y, color).length > 0;
}

// (x,y) 에 color 를 놓고 뒤집기까지 **보드를 직접 수정**한 뒤, 뒤집힌 좌표를 돌려준다.
// 합법수가 아니면 보드를 건드리지 않고 null 을 돌려준다 — 호출부가 잘못된 좌표를 거를 수 있게 한다.
export function ApplyMove(board: OthelloBoard, x: number, y: number, color: OthelloColor): OthelloPoint[] | null {
    const flips = GetFlips(board, x, y, color);
    if (flips.length === 0) return null;

    board[y][x] = color;
    for (const point of flips) {
        board[point.y][point.x] = color;
    }
    return flips;
}

// 색깔별 돌 개수. GAME_RESULT 의 win_count 와 vs 문자열에 쓴다.
export function CountStones(board: OthelloBoard): { black: number; white: number; empty: number } {
    let black = 0;
    let white = 0;
    let empty = 0;
    for (const row of board) {
        for (const cell of row) {
            if (cell === OTHELLO_BLACK) black++;
            else if (cell === OTHELLO_WHITE) white++;
            else empty++;
        }
    }
    return { black, white, empty };
}

// 그 색 돌이 놓여 있는 좌표 전부. GAME_STATUS(재접속 유저에게 보내는 보드 스냅샷)의
// status0/status1 에 그대로 쓴다. 보드를 훑는 순서대로(위→아래, 왼→오른쪽) 담는다.
export function GetStonePositions(board: OthelloBoard, color: OthelloColor): OthelloPoint[] {
    const positions: OthelloPoint[] = [];
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[y].length; x++) {
            if (board[y][x] === color) positions.push({ x, y });
        }
    }
    return positions;
}

// 게임 종료 조건 — **양쪽 모두** 놓을 곳이 없을 때.
// 보드가 꽉 찬 경우도 자연히 여기에 걸리고, 한쪽 돌이 0개가 된 경우도(남은 색이 끼울 상대가 없으므로)
// 걸린다. 한쪽만 놓을 곳이 없으면 그 턴은 패스이고 게임은 계속된다.
export function IsGameOver(board: OthelloBoard): boolean {
    return GetLegalMoves(board, OTHELLO_BLACK).length === 0 && GetLegalMoves(board, OTHELLO_WHITE).length === 0;
}
