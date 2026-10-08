// "게임 중인 userid → 게임방" 기록 — Redis 에 저장해 로비 프로세스가 볼 수 있게 한다 (Phase 6-1).
// 게임방 프로세스(게임 Room 클래스, 지금은 RpsGameRoom)가 입장/재접속할 때마다 저장하고 최종 퇴장 때 지운다, 로비 프로세스
// (LobbyManager)가 ENTER_LOBBY 때 이 값으로 matchMaker.reconnect() 를 시도한다.
// userid 별로 값 하나만 있으면 되므로(같은 유저가 동시에 두 게임방에 있을 수 없다) 단순 키-값으로 둔다.

import * as constants from "../../common/constants.js";
import * as redis from "../../db/redis.js";
import type { ActiveGameEntry } from "./types.js";

function GetKey(userid: string): string {
    return `active_game:${userid}`;
}

// 게임방에 입장/재접속할 때마다 호출한다 (reconnectionToken 은 (재)입장마다 새로 발급되므로 매번 덮어쓴다)
export async function SaveActiveGame(userid: string, entry: ActiveGameEntry): Promise<void> {
    await redis.SetJson(GetKey(userid), entry, constants.ACTIVE_GAME_TTL_SEC);
}

// 로비가 ENTER_LOBBY 때 "이 유저가 게임 중인지" 확인하는 용도
export async function GetActiveGame(userid: string): Promise<ActiveGameEntry | null> {
    return redis.GetJson<ActiveGameEntry>(GetKey(userid));
}

// 게임방에서 최종적으로 나갈 때(정상 종료든 재접속 실패든) 호출한다
export async function RemoveActiveGame(userid: string): Promise<void> {
    await redis.DeleteJson(GetKey(userid));
}
