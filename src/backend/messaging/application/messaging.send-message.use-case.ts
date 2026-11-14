import type { MessageView } from '../../../shared/contracts/messaging.contract.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { MessageRepository, RoomRepository } from '../domain/messaging.repository.ts';

import { type AppError, ConflictError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
} from '../domain/messaging.value-objects.ts';
import { Fields, type Input, roomOfMember } from './messaging.access.ts';

export type SentMessage = {
  readonly duplicate: boolean;
  readonly message: MessageView;
};

const REUSED_KEY = 'idempotencyKey was already used for another message';

/**
 * Persists one encrypted message. The client never chooses the id or the timestamp: both come from
 * PostgreSQL (UUIDv7), so the stored order is the canonical chronology.
 */
export class SendMessageUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
  ) {}

  async execute(actor: UserId, input: Input): Promise<Result<SentMessage, AppError>> {
    const fields = new Fields();
    const idempotencyKey = fields.take(IdempotencyKey.create(input.idempotencyKey));
    const keyEpoch = fields.take(KeyEpoch.create(input.keyEpoch));
    const chainIndex = fields.take(ChainIndex.create(input.chainIndex));
    const payload = fields.take(EncryptedPayload.create(input));
    if (
      idempotencyKey === undefined ||
      keyEpoch === undefined ||
      chainIndex === undefined ||
      payload === undefined
    ) {
      return err(fields.error());
    }
    const room = await roomOfMember(this.rooms, input.roomId, actor);
    if (!room.ok) {
      return room;
    }
    // A retry is answered with the stored original, even after the key epoch rotated.
    const existing = await this.messages.findByIdempotencyKey(actor, idempotencyKey);
    if (existing) {
      return existing.roomId === room.value.id
        ? ok({ duplicate: true, message: existing.toView() })
        : err(new ConflictError(REUSED_KEY));
    }
    const current = room.value.assertCurrentEpoch(keyEpoch);
    if (!current.ok) {
      return current;
    }
    const { duplicate, message } = await this.messages.append({
      chainIndex,
      idempotencyKey,
      keyEpoch,
      payload,
      roomId: room.value.id,
      senderId: actor,
    });
    // A concurrent send can store the key first in another room; its row must never leak here.
    if (duplicate && message.roomId !== room.value.id) {
      return err(new ConflictError(REUSED_KEY));
    }
    return ok({ duplicate, message: message.toView() });
  }
}
