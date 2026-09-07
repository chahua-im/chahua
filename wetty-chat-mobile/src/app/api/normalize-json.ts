import { decodeId, encodeId, type SnowflakeID } from './snowflake-id';
import { jsonSchemas, type JsonCodec } from '../../generated/json-codecs';

/** Normalize freshly parsed API data, preserving keys that explicitly clear cached fields. */
export function normalizeJson(value: unknown, codec?: JsonCodec): unknown {
  return convertJson(value, codec, false);
}

/** Copy request data while restoring wire IDs and preserving explicit null clears. */
export function serializeJson(value: unknown, codec: JsonCodec): unknown {
  return convertJson(value, codec, true);
}

function convertJson(value: unknown, codec: JsonCodec | undefined, outbound: boolean): unknown {
  if (value === null) return outbound ? null : undefined;
  if (value === undefined || codec === 0) return value;
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
  if (typeof codec === 'string') return convertJson(value, jsonSchemas[codec], outbound);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const itemCodec = Array.isArray(codec) ? codec[0] : undefined;
    const array: unknown[] = outbound ? [...value] : value;
    for (let index = 0; index < array.length; index++) array[index] = convertJson(array[index], itemCodec, outbound);
    return array;
  }

  const object: Record<string, unknown> = outbound ? { ...value } : (value as Record<string, unknown>);
  const fields = codec as Record<string, JsonCodec> | undefined;
  for (const key of Object.keys(fields ?? object)) {
    if (Object.hasOwn(object, key)) object[key] = convertJson(object[key], fields?.[key], outbound);
  }
  return object;
}
