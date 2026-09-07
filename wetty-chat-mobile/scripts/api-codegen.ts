import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';

type Schema = {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  [key: string]: unknown;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema };
type Content = { content?: Record<string, { schema?: Schema }> };
type Operation = { parameters?: Parameter[]; requestBody?: Content; responses?: Record<string, Content> };
const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'query'] as const;
type PathItem = Partial<Record<(typeof methods)[number], Operation>> & { parameters?: Parameter[] };
type Document = { components: { schemas: Record<string, Schema> }; paths: Record<string, PathItem> };
type JsonCodec = 0 | 1 | string | [JsonCodec] | { [field: string]: JsonCodec };
type JsonOperationCodec = {
  method: string;
  path: string;
  body?: JsonCodec;
  response?: JsonCodec;
  query?: Record<string, JsonCodec>;
};

// These fields are decimal i64 identities in the backend contract. Numeric UID,
// permission-group IDs, service-token IDs, and client-generated UUIDs stay unchanged.
const idFields = new Set([
  'attachmentId',
  'avatarImageId',
  'chatId',
  'destinationChatId',
  'dmChatId',
  'id',
  'imageId',
  'inviteId',
  'lastReadMessageId',
  'messageId',
  'originalChatId',
  'originalMessageId',
  'originalReplyToMessageId',
  'originalThreadRootId',
  'pinId',
  'replyRootId',
  'replyToId',
  'requestId',
  'requiredChatId',
  'sourceChatId',
  'stickerId',
  'stickerPackId',
  'threadRootId',
]);
const idArrays = new Set(['attachmentIds', 'messageIds']);
const cursorFields: Record<string, string[]> = {
  ListMessagesResponse: ['nextCursor', 'prevCursor', 'olderCursor', 'newerCursor'],
  ListChatAttachmentsResponse: ['olderCursor', 'newerCursor'],
  ListChatsResponse: ['nextCursor'],
  ListGroupsResponse: ['nextCursor'],
  ListSavedMessagesResponse: ['nextCursor'],
};
const pathIds = new Set([
  'chat_id',
  'message_id',
  'thread_id',
  'thread_root_id',
  'request_id',
  'invite_id',
  'pin_id',
  'pack_id',
  'sticker_id',
  'saved_message_id',
]);
const queryIds: Record<string, string[]> = {
  '/chats': ['after'],
  '/group': ['after'],
  '/chats/{chat_id}/attachments': ['before', 'after'],
  '/chats/{chat_id}/messages': ['before', 'after', 'around', 'threadId'],
  '/chats/{chat_id}/saved-messages': ['before'],
  '/saved-messages': ['before'],
  '/invites': ['groupId'],
  '/users/search': ['excludeMemberOf'],
};
const nullableCommands = new Set(['UpdateChatBody.avatarImageId', 'PatchInviteBody.expiresAt']);
const generatedRoot = './src/generated';
let metadata = '';

function isNullable(schema: Schema): boolean {
  return (
    schema.nullable === true ||
    schema.type === 'null' ||
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some((branch) => branch.type === 'null')
  );
}

function withoutNull(schema: Schema): Schema {
  const result = { ...schema };
  delete result.nullable;
  if (Array.isArray(result.type)) {
    const types = result.type.filter((type) => type !== 'null');
    result.type = types.length === 1 ? types[0] : types;
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = result[keyword];
    if (!branches) continue;
    const nonNull = branches.filter((branch) => branch.type !== 'null');
    if (nonNull.length === branches.length) continue;
    if (nonNull.length === 1) {
      delete result[keyword];
      return { ...nonNull[0], ...result };
    }
    result[keyword] = nonNull;
  }
  return result;
}

function visitSchema(schema: Schema, visit: (schema: Schema) => void): void {
  visit(schema);
  for (const property of Object.values(schema.properties ?? {})) visitSchema(property, visit);
  if (schema.items) visitSchema(schema.items, visit);
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])])
    visitSchema(branch, visit);
}

function jsonSchema(content: Content | undefined): Schema | undefined {
  return Object.entries(content?.content ?? {}).find(([type]) => type.includes('json'))?.[1].schema;
}

export function transformApiSchema<T>(document: T): T {
  const spec = document as Document;
  const schemas = spec.components.schemas;
  // The server's serde query contract is camelCase; this OpenAPI parameter is stale.
  for (const parameter of spec.paths['/chats/{chat_id}/messages'].get!.parameters!) {
    if (parameter.name === 'thread_id') parameter.name = 'threadId';
  }
  const ids = new Set<Schema>();
  const isString = (schema: Schema) =>
    schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'));
  for (const [name, schema] of Object.entries(schemas)) {
    visitSchema(schema, (node) => {
      for (const [key, property] of Object.entries(node.properties ?? {})) {
        if (idFields.has(key) && isString(property)) ids.add(property);
        if (idArrays.has(key) && property.items && isString(property.items)) ids.add(property.items);
      }
    });
    for (const key of cursorFields[name] ?? []) ids.add(schema.properties![key]);
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        if (
          parameter.schema &&
          ((parameter.in === 'path' && pathIds.has(parameter.name)) ||
            (parameter.in === 'query' && queryIds[path]?.includes(parameter.name)))
        )
          ids.add(parameter.schema);
      }
    }
  }

  const nullableRefs = new Set<string>();
  function describe(schema: Schema | undefined, optional = false): JsonCodec | undefined {
    if (!schema) return undefined;
    if (ids.has(schema)) return 1;
    const nullable = optional && isNullable(schema);
    const clean = withoutNull(schema);
    if (clean.$ref) {
      const name = clean.$ref.split('/').at(-1)!;
      if (nullable) nullableRefs.add(name);
      return name;
    }
    const variants = clean.oneOf ?? clean.anyOf;
    if (variants?.length === 1) return describe(variants[0]) ?? (nullable ? 0 : undefined);
    if (variants?.length) throw new Error('Unexpected non-null schema union in JSON codec');
    const fields: Record<string, JsonCodec> = {};
    for (const branch of clean.allOf ?? []) {
      const descriptor = describe(branch);
      if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) Object.assign(fields, descriptor);
    }
    for (const [key, property] of Object.entries(clean.properties ?? {})) {
      const descriptor = describe(property, !clean.required?.includes(key));
      if (descriptor !== undefined) fields[key] = descriptor;
    }
    if (Object.keys(fields).length) return fields;
    if (clean.items) {
      const item = describe(clean.items);
      if (item !== undefined) return [item];
    }
    return nullable ? 0 : undefined;
  }

  const described = Object.fromEntries(
    Object.entries(schemas)
      .filter(([name]) => name !== 'ServerWsMessage')
      .map(([name, schema]) => [name, describe(schema)]),
  );
  for (const name of nullableRefs) described[name] ??= 0;
  const needed = new Set<string>();
  function needsCodec(codec: JsonCodec | undefined): boolean {
    if (codec === undefined) return false;
    if (typeof codec === 'number') return true;
    if (typeof codec === 'string') return needed.has(codec);
    return Object.values(codec).some(needsCodec);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, codec] of Object.entries(described)) {
      if (!needed.has(name) && needsCodec(codec)) {
        needed.add(name);
        changed = true;
      }
    }
  }
  function compact(codec: JsonCodec | undefined): JsonCodec | undefined {
    if (codec === undefined || typeof codec === 'number') return codec;
    if (typeof codec === 'string') return needed.has(codec) ? codec : undefined;
    if (Array.isArray(codec)) {
      const item = compact(codec[0]);
      return item === undefined ? undefined : [item];
    }
    const fields: Record<string, JsonCodec> = {};
    for (const [key, child] of Object.entries(codec)) {
      const value = compact(child);
      if (value !== undefined) fields[key] = value;
    }
    return Object.keys(fields).length ? fields : undefined;
  }
  const jsonSchemas = Object.fromEntries([...needed].sort().map((name) => [name, compact(described[name])]));
  const wsPayloadCodecs = Object.fromEntries(
    schemas['ServerWsMessage'].oneOf!.map((event) => [
      event.properties!['type'].enum![0],
      compact(describe(event.properties!['payload'])) ?? 0,
    ]),
  );
  const jsonOperations: JsonOperationCodec[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const requestSchema = jsonSchema(operation.requestBody);
      const body = requestSchema ? (compact(describe(requestSchema)) ?? 0) : undefined;
      const success = Object.entries(operation.responses ?? {}).find(
        ([status, content]) => /^2\d\d$/.test(status) && jsonSchema(content),
      )?.[1];
      const responseSchema = jsonSchema(success);
      const response = responseSchema ? (compact(describe(responseSchema)) ?? 0) : undefined;
      const query = Object.fromEntries(
        [...(item.parameters ?? []), ...(operation.parameters ?? [])]
          .filter((parameter) => parameter.in === 'query' && parameter.schema && ids.has(parameter.schema))
          .map((parameter) => [parameter.name, 1 as const]),
      );
      if (body !== undefined || response !== undefined || Object.keys(query).length)
        jsonOperations.push({
          method: method.toUpperCase(),
          path,
          ...(body === undefined ? {} : { body }),
          ...(response === undefined ? {} : { response }),
          ...(Object.keys(query).length ? { query } : {}),
        });
    }
  }
  metadata = `/** Generated from the API contract by scripts/api-codegen.ts. */
export type JsonCodec = 0 | 1 | string | [JsonCodec] | { [field: string]: JsonCodec };
export interface JsonOperationCodec {
  method: string;
  path: string;
  body?: JsonCodec;
  response?: JsonCodec;
  query?: Record<string, JsonCodec>;
}
export const jsonSchemas: Record<string, JsonCodec> = ${JSON.stringify(jsonSchemas, null, 2)};
export const jsonOperations: JsonOperationCodec[] = ${JSON.stringify(jsonOperations, null, 2)};
export const wsPayloadCodecs: Record<string, JsonCodec> = ${JSON.stringify(wsPayloadCodecs, null, 2)};
`;

  for (const schema of ids) {
    const nullable = isNullable(schema);
    const details = { ...schema };
    for (const key of ['type', 'format', 'nullable']) delete details[key];
    for (const key of Object.keys(schema)) delete schema[key];
    const reference = { $ref: '#/components/schemas/SnowflakeID' };
    Object.assign(
      schema,
      nullable ? { oneOf: [{ type: 'null' }, reference], ...details } : { ...reference, ...details },
    );
  }
  for (const [name, schema] of Object.entries(schemas))
    visitSchema(schema, (node) => {
      for (const [key, property] of Object.entries(node.properties ?? {})) {
        if (!node.required?.includes(key) && !(node === schema && nullableCommands.has(`${name}.${key}`))) {
          node.properties![key] = withoutNull(property);
        }
      }
    });
  for (const item of Object.values(spec.paths))
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        if (parameter.schema && !parameter.required) parameter.schema = withoutNull(parameter.schema);
      }
    }
  schemas['SnowflakeID'] = { type: 'number' };
  return document;
}

export async function finishApiGeneration(): Promise<void> {
  const alias = `${generatedRoot}/models/snowflakeID.ts`;
  const source = readFileSync(alias, 'utf8');
  if (!source.includes('export type SnowflakeID = number;')) throw new Error('Generated SnowflakeID alias changed');
  writeFileSync(
    alias,
    source.replace('export type SnowflakeID = number;', "export type { SnowflakeID } from '../../app/api/snowflake-id';"),
  );
  const metadataFile = `${generatedRoot}/json-codecs.ts`;
  writeFileSync(
    metadataFile,
    await format(metadata, { ...(await resolveConfig(metadataFile)), filepath: metadataFile }),
  );
  addPathCodecs();
}

function addPathCodecs(): void {
  for (const relative of readdirSync(generatedRoot, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(service|resource)\.ts$/.test(relative)) continue;
    const file = `${generatedRoot}/${relative}`;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let changed = false;
    const transformed = ts.transform(source, [
      (context) => {
        function visit(node: ts.Node, scope = new Map<string, boolean>(), inTemplate = false): ts.Node {
          if (ts.isFunctionLike(node)) {
            scope = new Map(scope);
            for (const parameter of node.parameters) {
              if (!ts.isIdentifier(parameter.name)) continue;
              const type = parameter.type?.getText(source).replaceAll(/\s/g, '');
              scope.delete(parameter.name.text);
              if (type === 'SnowflakeID' || type === 'Signal<SnowflakeID>')
                scope.set(parameter.name.text, type.startsWith('Signal'));
            }
          }
          if (
            inTemplate &&
            ((ts.isIdentifier(node) && scope.get(node.text) === false) ||
              (ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                scope.get(node.expression.text) === true &&
                node.arguments.length === 0))
          ) {
            changed = true;
            return ts.factory.createCallExpression(ts.factory.createIdentifier('decodeId'), undefined, [
              node as ts.Expression,
            ]);
          }
          return ts.visitEachChild(
            node,
            (child) => visit(child, scope, inTemplate || ts.isTemplateSpan(node)),
            context,
          );
        }
        return (node) => visit(node) as ts.SourceFile;
      },
    ]);
    if (changed)
      writeFileSync(
        file,
        "import { decodeId } from '../../../app/api/snowflake-id';\n" +
          ts.createPrinter().printFile(transformed.transformed[0]),
      );
    transformed.dispose();
  }
}
