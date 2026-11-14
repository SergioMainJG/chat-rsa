import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';

export type MembershipChange = {
  readonly added: null | number;
  readonly removed: null | number;
};

/**
 * Port the HTTP controllers call after a REST change that live sockets must learn about. The
 * WebSocket gateway implements it (subscriptions and `room.rotated` / `sender-keys.available`).
 */
export type RoomEvents = {
  readonly membersChanged: (room: RoomSummary, change: MembershipChange) => void;
  readonly senderKeysAvailable: (roomId: string, keyEpoch: number, senderId: number) => void;
};
