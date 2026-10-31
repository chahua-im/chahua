import { jsonSchemas, type JsonCodec } from '../../generated/json-codecs';
import { decodeId, encodeId, type SnowflakeID } from './snowflake-id';

/** Encode Snowflake IDs in freshly parsed API data; all other values remain unchanged. */
export function encodeJsonIds(
  value: unknown,
  codec?: JsonCodec,
  schemas: Record<string, JsonCodec> = jsonSchemas,
): unknown {
  return convertJson(value, codec, false, schemas);
}

/** Copy request data while restoring wire IDs; null and undefined remain unchanged. */
export function decodeJsonIds(
  value: unknown,
  codec?: JsonCodec,
  schemas: Record<string, JsonCodec> = jsonSchemas,
): unknown {
  return convertJson(value, codec, true, schemas);
}

function convertJson(
  value: unknown,
  codec: JsonCodec | undefined,
  outbound: boolean,
  schemas: Record<string, JsonCodec>,
): unknown {
  if (value == null || !codec) return value;
  if (codec === 1) {
    // HTTP retries and cached responses may pass through the boundary more than once.
    return outbound
      ? typeof value === 'number'
        ? decodeId(value as SnowflakeID)
        : value
      : typeof value === 'string'
        ? encodeId(value)
        : value;
  }
  if (typeof codec === 'string') return convertJson(value, schemas[codec], outbound, schemas);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const itemCodec = Array.isArray(codec) ? codec[0] : undefined;
    const array: unknown[] = outbound ? [...value] : value;
    for (let index = 0; index < array.length; index++)
      array[index] = convertJson(array[index], itemCodec, outbound, schemas);
    return array;
  }

  const object: Record<string, unknown> = outbound ? { ...value } : (value as Record<string, unknown>);
  const fields = codec as Record<string, JsonCodec>;
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(object, key)) object[key] = convertJson(object[key], fields[key], outbound, schemas);
  }
  return object;
}
