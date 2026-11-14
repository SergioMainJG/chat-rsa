import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { ReceiptKind } from '../domain/messaging.receipt.ts';
import type {
  MessageRepository,
  ReceiptRepository,
  RoomRepository,
} from '../domain/messaging.repository.ts';

import { type AppError, ForbiddenError, NotFoundError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { MessageId } from '../domain/messaging.value-objects.ts';
import { Fields, type Input, roomOfMember } from './messaging.access.ts';

export type ReceiptUpdate = {
  readonly delivered: null | string;
  readonly read: null | string;
  readonly roomId: string;
  readonly userId: number;
};

/**
 * Moves a member's `delivered` or `read` watermark. `read` is only sent by the client once the
 * message element is visible in the viewport.
 */
export class ReceiptUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
    private readonly receipts: ReceiptRepository,
  ) {}

  async execute(actor: UserId, input: Input): Promise<Result<ReceiptUpdate, AppError>> {
    const fields = new Fields();
    const messageId = fields.take(MessageId.create(input.messageId));
    const kind = isReceiptKind(input.kind) ? input.kind : undefined;
    if (kind === undefined) {
      fields.push({ field: 'kind', message: 'kind must be delivered or read' });
    }
    if (messageId === undefined || kind === undefined) {
      return err(fields.error());
    }
    const room = await roomOfMember(this.rooms, input.roomId, actor);
    if (!room.ok) {
      return room;
    }
    // Only real messages of this room move a watermark, so a receipt cannot mark future messages.
    if (!(await this.messages.exists(room.value.id, messageId))) {
      return err(new NotFoundError('Message not found in this room'));
    }
    let marks: Awaited<ReturnType<ReceiptRepository['advance']>>;
    try {
      marks = await this.receipts.advance(room.value.id, actor, kind, messageId);
    } catch (error) {
      // A concurrent leave between `roomOfMember` and the UPDATE.
      if (error instanceof ForbiddenError) {
        return err(error);
      }
      throw error;
    }
    return ok({
      delivered: marks.delivered,
      read: marks.read,
      roomId: room.value.id,
      userId: actor,
    });
  }
}

function isReceiptKind(raw: unknown): raw is ReceiptKind {
  return raw === 'delivered' || raw === 'read';
}
