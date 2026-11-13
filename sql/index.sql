CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);

-- X25519 identity public key per user (raw 32 bytes). Private key never leaves the client.
CREATE TABLE IF NOT EXISTS user_identity_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL CONSTRAINT user_identity_keys_public_key_len CHECK (octet_length(public_key) = 32),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  name TEXT NOT NULL CONSTRAINT rooms_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  created_by INTEGER NOT NULL REFERENCES users (id),
  member_count SMALLINT NOT NULL DEFAULT 0 CONSTRAINT rooms_max_members CHECK (member_count BETWEEN 0 AND 100),
  key_epoch INTEGER NOT NULL DEFAULT 0 CONSTRAINT rooms_key_epoch_nonneg CHECK (key_epoch >= 0),
  created_at TIMESTAMPTZ GENERATED ALWAYS AS (uuid_extract_timestamp(id)) STORED
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_delivered_message_id UUID,
  last_read_message_id UUID,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT room_members_read_after_delivered CHECK (
    last_read_message_id IS NULL
    OR (last_delivered_message_id IS NOT NULL AND last_read_message_id <= last_delivered_message_id)
  )
);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id, room_id);

-- Sender Keys: each sender's chain key for one epoch, encrypted to one recipient
-- (ephemeral X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM).
CREATE TABLE IF NOT EXISTS sender_key_envelopes (
  room_id UUID NOT NULL,
  key_epoch INTEGER NOT NULL CONSTRAINT sender_key_envelopes_epoch_nonneg CHECK (key_epoch >= 0),
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  ephemeral_public_key BYTEA NOT NULL CONSTRAINT sender_key_envelopes_epk_len CHECK (octet_length(ephemeral_public_key) = 32),
  ciphertext BYTEA NOT NULL CONSTRAINT sender_key_envelopes_ciphertext_len CHECK (octet_length(ciphertext) BETWEEN 1 AND 256),
  iv BYTEA NOT NULL CONSTRAINT sender_key_envelopes_iv_len CHECK (octet_length(iv) = 12),
  auth_tag BYTEA NOT NULL CONSTRAINT sender_key_envelopes_tag_len CHECK (octet_length(auth_tag) = 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, key_epoch, sender_id, recipient_id),
  FOREIGN KEY (room_id, sender_id) REFERENCES room_members (room_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, recipient_id) REFERENCES room_members (room_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sender_key_envelopes_recipient_idx
  ON sender_key_envelopes (recipient_id, room_id, key_epoch);

-- Opaque E2EE payloads only. id (UUIDv7) and created_at are server-generated.
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  room_id UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users (id),
  idempotency_key UUID NOT NULL,
  key_epoch INTEGER NOT NULL CONSTRAINT messages_epoch_nonneg CHECK (key_epoch >= 0),
  chain_index INTEGER NOT NULL CONSTRAINT messages_chain_index_nonneg CHECK (chain_index >= 0),
  ciphertext BYTEA NOT NULL CONSTRAINT messages_ciphertext_len CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  iv BYTEA NOT NULL CONSTRAINT messages_iv_len CHECK (octet_length(iv) = 12),
  auth_tag BYTEA NOT NULL CONSTRAINT messages_tag_len CHECK (octet_length(auth_tag) = 16),
  created_at TIMESTAMPTZ GENERATED ALWAYS AS (uuid_extract_timestamp(id)) STORED,
  CONSTRAINT messages_idempotency_uq UNIQUE (sender_id, idempotency_key),
  CONSTRAINT messages_chain_uq UNIQUE (room_id, sender_id, key_epoch, chain_index)
);
CREATE INDEX IF NOT EXISTS messages_room_id_desc_idx ON messages (room_id, id DESC);

-- Member counter + key epoch bump. The UPDATE row-locks the room, serializing concurrent
-- joins so rooms_max_members (<= 100) cannot be raced past.
CREATE OR REPLACE FUNCTION room_members_track() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE rooms SET member_count = member_count + 1, key_epoch = key_epoch + 1 WHERE id = NEW.room_id;
  ELSE
    UPDATE rooms SET member_count = member_count - 1, key_epoch = key_epoch + 1 WHERE id = OLD.room_id;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER room_members_track
  AFTER INSERT OR DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION room_members_track();

-- Minimum of 2 members, checked at COMMIT so a room and its members are created in one transaction.
CREATE OR REPLACE FUNCTION rooms_assert_min_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  members SMALLINT;
BEGIN
  IF TG_TABLE_NAME = 'rooms' THEN
    target := NEW.id;
  ELSE
    target := OLD.room_id;
  END IF;
  SELECT member_count INTO members FROM rooms WHERE id = target;
  IF FOUND AND members < 2 THEN
    RAISE EXCEPTION 'room % has % members; minimum is 2', target, members
      USING ERRCODE = '23514', CONSTRAINT = 'rooms_min_members';
  END IF;
  RETURN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'rooms'::regclass AND tgname = 'rooms_min_members_on_create') THEN
    CREATE CONSTRAINT TRIGGER rooms_min_members_on_create AFTER INSERT ON rooms
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rooms_assert_min_members();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'room_members'::regclass AND tgname = 'rooms_min_members_on_leave') THEN
    CREATE CONSTRAINT TRIGGER rooms_min_members_on_leave AFTER DELETE ON room_members
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rooms_assert_min_members();
  END IF;
END $$;

-- Defense in depth: only current members can write to a room.
CREATE OR REPLACE FUNCTION messages_assert_sender_is_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = NEW.room_id AND user_id = NEW.sender_id) THEN
    RAISE EXCEPTION 'user % is not a member of room %', NEW.sender_id, NEW.room_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER messages_assert_sender_is_member
  BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_assert_sender_is_member();
