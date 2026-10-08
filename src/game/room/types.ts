// 게임방 관련 서버 내부 타입

import type { OpponentInfo } from "../../common/types.js";

// "기다리는 방" — 재게임을 신청하고 혼자 남은 유저가 있는 방 (Phase 5 에서 실제로 등록/삭제한다).
// opponent 는 이미 방에 있는 그 유저의 표시 정보 — 로비 쪽에서 매칭할 때 DB/Redis 조회 없이 바로 쓸 수 있게
// 여기 함께 담아 둔다.
export interface WaitingRoomEntry {
    channel_no: number;
    room_name: string;
    room_id: string;
    opponent: OpponentInfo;
}

// "게임 중인 userid → 게임방" 기록 (Phase 6-1, activeGame.ts). F5 새로고침 등으로 로비를 통해 다시
// 접속했을 때, 로비가 이 기록으로 matchMaker.reconnect() 를 불러 원래 게임방으로 돌려보내는 데 쓴다.
// reconnection_token 은 게임 Room 클래스(RpsGameRoom 등)의 onJoin/onReconnect 때마다(재접속할 때마다 새로 발급되므로) 다시 저장한다.
export interface ActiveGameEntry {
    room_name: string;
    room_id: string;
    reconnection_token: string;
}
