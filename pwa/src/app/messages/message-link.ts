import { decodeId, type SnowflakeID } from '../api/snowflake-id';

export function messageLink(chatId: SnowflakeID, messageId: SnowflakeID): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(decodeId(chatId)));
  view.setBigUint64(8, BigInt(decodeId(messageId)));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `/m/${encoded}`;
}
