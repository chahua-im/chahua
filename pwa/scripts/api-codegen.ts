import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  additionalProperties?: boolean | Schema;
  'x-snowflake-id'?: boolean;
  [key: string]: unknown;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema };
type Content = { content?: Record<string, { schema?: Schema }> };
type Operation = { parameters?: Parameter[]; requestBody?: Content; responses?: Record<string, Content> };
type OpenApiDocument = { components: { schemas: Record<string, Schema> }; paths: Record<string, PathItem> };
type OpenRpcMethod = {
  name: string;
  params?: Array<{ name: string; required?: boolean; schema: Schema }>;
  result?: { schema: Schema };
  'x-params-schema'?: Schema;
  'x-execution-class'?: RpcExecutionClass;
};
type OpenRpcEvent = {
  name: string;
  params?: Array<{ name: string; required?: boolean; schema: Schema }>;
  'x-params-schema'?: Schema;
};
type OpenRpcDocument = {
  openrpc: string;
  components: { schemas: Record<string, Schema> };
  methods: OpenRpcMethod[];
  'x-events': OpenRpcEvent[];
  'x-error-codes': Array<{ name: string; code: number; message: string }>;
};
type RpcExecutionClass = 'read' | 'mutation' | 'session' | 'control';
type PathItem = Partial<Record<(typeof methods)[number], Operation>> & { parameters?: Parameter[] };
type JsonCodec = 0 | 1 | string | [JsonCodec] | { [field: string]: JsonCodec };
type JsonOperationCodec = {
  method: string;
  path: string;
  body?: JsonCodec;
  response?: JsonCodec;
  query?: Record<string, JsonCodec>;
};

const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'query'] as const;
const generatedRoot = './src/generated';
const nullableCommands: Readonly<Record<string, true>> = {
  'UpdateChatBody.avatarImageId': true,
  'PatchInviteBody.expiresAt': true,
  'GroupsUpdateParams.avatarImageId': true,
  'InvitesUpdateParams.expiresAt': true,
};
const idFields = new Set([
  'attachmentId',
  'avatarImageId',
  'chatId',
  'destinationChatId',
  'forwardedBundleId',
  'dmChatId',
  'id',
  'imageId',
  'inviteId',
  'lastReadMessageId',
  'peerLastReadMessageId',
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
  'threadId',
]);
const idArrays = new Set(['attachmentIds', 'chatIds', 'messageIds', 'threadRootIds']);
const cursorFields: Record<string, string[]> = {
  ListMessagesResponse: ['nextCursor', 'prevCursor', 'olderCursor', 'newerCursor'],
  ListChatThreadsResponse: ['nextCursor'],
  ListChatAttachmentsResponse: ['olderCursor', 'newerCursor'],
  ListChatsResponse: ['nextCursor'],
  NotificationExceptionsResponse: ['nextCursor'],
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
  'bundle_id',
]);
const queryIds: Record<string, string[]> = {
  '/chats': ['after', 'chatId'],
  '/group': ['after'],
  '/threads': ['rootId'],
  '/chats/{chat_id}/threads': ['cursor'],
  '/chats/{chat_id}/attachments': ['before', 'after'],
  '/chats/{chat_id}/messages': ['before', 'after', 'around', 'threadId'],
  '/chats/{chat_id}/read-receipt': ['threadId'],
  '/chats/{chat_id}/mentions': ['threadId'],
  '/chats/{chat_id}/reactions': ['threadId'],
  '/chats/{chat_id}/saved-messages': ['before'],
  '/saved-messages': ['before'],
  '/invites': ['groupId'],
  '/users/search': ['excludeMemberOf'],
  '/users/me/notification-exceptions': ['after'],
};

let httpMetadata = '';
let untransformedOpenApi: OpenApiDocument | undefined;
let openApiSource: string | undefined;

export function captureOpenApiWireDocument(document: unknown, source?: string): void {
  untransformedOpenApi = structuredClone(document as OpenApiDocument);
  openApiSource = source;
}

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

function schemaName(schema: Schema): string {
  if (!schema.$ref?.startsWith('#/components/schemas/')) throw new Error('Expected a local component schema reference');
  return schema.$ref.slice('#/components/schemas/'.length);
}

function codecFor(
  schema: Schema | undefined,
  schemas: Record<string, Schema>,
  explicitMarkers: boolean,
  identities?: Set<Schema>,
): JsonCodec | undefined {
  if (!schema) return undefined;
  const clean = withoutNull(schema);
  if ((explicitMarkers && clean['x-snowflake-id'] === true) || identities?.has(schema)) return 1;
  if (clean.$ref) return schemaName(clean);
  const variants = clean.oneOf ?? clean.anyOf;
  const fields: Record<string, JsonCodec> = {};
  for (const branch of variants ?? []) {
    const descriptor = codecFor(
      branch.$ref ? schemas[schemaName(branch)] : branch,
      schemas,
      explicitMarkers,
      identities,
    );
    if (!descriptor) continue;
    if (typeof descriptor !== 'object' || Array.isArray(descriptor))
      throw new Error('Expected object variants in JSON codec');
    for (const [key, value] of Object.entries(descriptor)) {
      if (fields[key] !== undefined && JSON.stringify(fields[key]) !== JSON.stringify(value))
        throw new Error(`Conflicting variant codec for ${key}`);
      fields[key] = value;
    }
  }
  for (const branch of clean.allOf ?? []) {
    const descriptor = codecFor(
      branch.$ref ? schemas[schemaName(branch)] : branch,
      schemas,
      explicitMarkers,
      identities,
    );
    if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) Object.assign(fields, descriptor);
  }
  for (const [key, property] of Object.entries(clean.properties ?? {})) {
    const descriptor = codecFor(property, schemas, explicitMarkers, identities);
    if (descriptor !== undefined) fields[key] = descriptor;
  }
  if (Object.keys(fields).length) return fields;
  if (clean.items) {
    const item = codecFor(clean.items, schemas, explicitMarkers, identities);
    if (item !== undefined) return [item];
  }
  return undefined;
}

function compactCodecs(
  schemas: Record<string, Schema>,
  descriptors: Record<string, JsonCodec | undefined>,
): Record<string, JsonCodec> {
  const needed = new Set<string>();
  const needsCodec = (codec: JsonCodec | undefined): boolean => {
    if (codec === undefined) return false;
    if (typeof codec === 'number') return true;
    if (typeof codec === 'string') return needed.has(codec);
    return Object.values(codec).some(needsCodec);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, codec] of Object.entries(descriptors))
      if (!needed.has(name) && needsCodec(codec)) {
        needed.add(name);
        changed = true;
      }
  }
  const compact = (codec: JsonCodec | undefined): JsonCodec | undefined => {
    if (codec === undefined || typeof codec === 'number') return codec;
    if (typeof codec === 'string') return needed.has(codec) ? codec : undefined;
    if (Array.isArray(codec)) {
      const item = compact(codec[0]);
      return item === undefined ? undefined : [item];
    }
    const fields = Object.fromEntries(
      Object.entries(codec).flatMap(([key, value]) => {
        const child = compact(value);
        return child === undefined ? [] : [[key, child]];
      }),
    );
    return Object.keys(fields).length ? fields : undefined;
  };
  return Object.fromEntries([...needed].sort().map((name) => [name, compact(descriptors[name])!]));
}

export function transformApiSchema<T>(document: T): T {
  const spec = document as unknown as OpenApiDocument;
  untransformedOpenApi ??= structuredClone(spec);
  const schemas = spec.components.schemas;
  for (const parameter of spec.paths['/chats/{chat_id}/messages'].get!.parameters!)
    if (parameter.name === 'thread_id') parameter.name = 'threadId';
  const ids = new Set<Schema>();
  const isString = (schema: Schema) =>
    schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'));
  for (const [name, schema] of Object.entries(schemas)) {
    visitSchema(schema, (node) => {
      if (node['x-snowflake-id'] === true && isString(node)) ids.add(node);
      for (const [key, property] of Object.entries(node.properties ?? {})) {
        if (idFields.has(key) && isString(property)) ids.add(property);
        if (idArrays.has(key) && property.items && isString(property.items)) ids.add(property.items);
      }
    });
    for (const key of cursorFields[name] ?? []) ids.add(schema.properties![key]);
  }
  for (const [path, item] of Object.entries(spec.paths))
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])])
        if (
          parameter.schema &&
          ((parameter.in === 'path' && pathIds.has(parameter.name)) ||
            (parameter.in === 'query' && queryIds[path]?.includes(parameter.name)))
        )
          ids.add(parameter.schema);
    }
  const descriptors = Object.fromEntries(
    Object.entries(schemas)
      .filter(([name]) => name !== 'ServerWsMessage')
      .map(([name, schema]) => [name, codecFor(schema, schemas, false, ids)]),
  );
  httpMetadata = `/** Generated from the API contract by scripts/api-codegen.ts. */\nexport type JsonCodec = 0 | 1 | string | [JsonCodec] | { [field: string]: JsonCodec };\nexport interface JsonOperationCodec { method: string; path: string; body?: JsonCodec; response?: JsonCodec; query?: Record<string, JsonCodec>; }\nexport const jsonSchemas: Record<string, JsonCodec> = ${JSON.stringify(compactCodecs(schemas, descriptors), null, 2)};\nexport const jsonOperations: JsonOperationCodec[] = ${JSON.stringify(httpOperations(spec, ids), null, 2)};\nexport const wsPayloadCodecs: Record<string, JsonCodec> = ${JSON.stringify(Object.fromEntries(schemas['ServerWsMessage'].oneOf!.map((event) => [event.properties!['type'].enum![0], codecFor(event.properties!['payload'], schemas, false, ids) ?? 0])), null, 2)};\n`;
  for (const schema of ids) {
    const nullable = isNullable(schema);
    const details = { ...schema };
    for (const key of ['type', 'format', 'nullable', 'x-snowflake-id']) delete details[key];
    for (const key of Object.keys(schema)) delete schema[key];
    const reference = { $ref: '#/components/schemas/SnowflakeID' };
    Object.assign(
      schema,
      nullable ? { oneOf: [{ type: 'null' }, reference], ...details } : { ...reference, ...details },
    );
  }
  for (const [name, schema] of Object.entries(schemas))
    visitSchema(schema, (node) => {
      for (const [key, property] of Object.entries(node.properties ?? {}))
        if (!node.required?.includes(key) && !(node === schema && nullableCommands[`${name}.${key}`]))
          node.properties![key] = withoutNull(property);
    });
  for (const item of Object.values(spec.paths))
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])])
        if (parameter.schema && !parameter.required) parameter.schema = withoutNull(parameter.schema);
    }
  schemas['SnowflakeID'] = { type: 'number' };
  return document;
}

function httpOperations(spec: OpenApiDocument, ids: Set<Schema>): JsonOperationCodec[] {
  const operations: JsonOperationCodec[] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const body = codecFor(jsonSchema(operation.requestBody), spec.components.schemas, false, ids);
      const response = codecFor(
        jsonSchema(
          Object.entries(operation.responses ?? {}).find(
            ([status, content]) => /^2\d\d$/.test(status) && jsonSchema(content),
          )?.[1],
        ),
        spec.components.schemas,
        false,
        ids,
      );
      const query = Object.fromEntries(
        [...(item.parameters ?? []), ...(operation.parameters ?? [])]
          .filter((parameter) => parameter.in === 'query' && parameter.schema && ids.has(parameter.schema))
          .map((parameter) => [parameter.name, 1]),
      );
      if (body !== undefined || response !== undefined || Object.keys(query).length)
        operations.push({
          method: method.toUpperCase(),
          path,
          ...(body === undefined ? {} : { body }),
          ...(response === undefined ? {} : { response }),
          ...(Object.keys(query).length ? { query } : {}),
        });
    }
  return operations;
}

function projectDraft07(schema: Schema, schemas?: Record<string, Schema>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'x-snowflake-id' || key === 'nullable' || key === 'allOf') continue;
    if (key === 'properties') {
      result.properties = Object.fromEntries(
        Object.entries(value as Record<string, Schema>).map(([name, child]) => [name, projectDraft07(child, schemas)]),
      );
    } else if (key === 'items') {
      result.items = projectDraft07(value as Schema, schemas);
    } else if (['oneOf', 'anyOf'].includes(key)) {
      result[key] = (value as Schema[]).map((branch) => projectDraft07(branch, schemas));
    } else if (key === 'required') {
      result.required = [...(value as string[])].sort();
    } else {
      result[key] = value;
    }
  }
  const allOf = schema.allOf ?? [];
  if (allOf.length) {
    const parts = allOf.map((part) =>
      part.$ref && schemas ? projectDraft07(schemas[schemaName(part)], schemas) : projectDraft07(part, schemas),
    );
    if (parts.every((part) => part && typeof part === 'object' && !Array.isArray(part))) {
      const fields = Object.assign({}, ...parts, result) as Record<string, unknown>;
      const properties = Object.assign(
        {},
        ...parts.map((part) => (part as Record<string, unknown>).properties ?? {}),
        result.properties ?? {},
      );
      const required = [
        ...new Set(
          parts
            .flatMap((part) => ((part as Record<string, unknown>).required as string[] | undefined) ?? [])
            .concat((result.required as string[] | undefined) ?? []),
        ),
      ].sort();
      return {
        ...fields,
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(required.length ? { required } : {}),
      };
    }
    result.allOf = parts;
  }
  if (schema.nullable === true) {
    if (result.type) {
      result.type = Array.isArray(result.type) ? [...(result.type as string[]), 'null'] : [result.type, 'null'];
    } else {
      result.anyOf = [...((result.anyOf as unknown[] | undefined) ?? []), { type: 'null' }];
    }
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function validateRpcDocument(openApi: OpenApiDocument, rpc: OpenRpcDocument): void {
  if (rpc.openrpc !== '1.4.0') throw new Error(`Expected OpenRPC 1.4.0, received ${rpc.openrpc}`);
  const seen = new Set<string>();
  for (const method of rpc.methods) {
    if (!method.name || seen.has(method.name)) throw new Error(`Duplicate RPC method ${method.name}`);
    seen.add(method.name);
    if (!['read', 'mutation', 'session', 'control'].includes(method['x-execution-class'] ?? ''))
      throw new Error(`Invalid execution class for ${method.name}`);
    validateRefs(method['x-params-schema'], rpc.components.schemas, method.name);
    validateRefs(method.result?.schema, rpc.components.schemas, method.name);
    for (const parameter of method.params ?? []) validateRefs(parameter.schema, rpc.components.schemas, method.name);
  }
  for (const event of rpc['x-events']) {
    if (!event.name) throw new Error('RPC event is missing a name');
    validateRefs(event['x-params-schema'], rpc.components.schemas, event.name);
    for (const parameter of event.params ?? []) validateRefs(parameter.schema, rpc.components.schemas, event.name);
  }
  for (const [name, schema] of Object.entries(rpc.components.schemas))
    validateRefs(schema, rpc.components.schemas, name);
  for (const [name, rpcSchema] of Object.entries(rpc.components.schemas)) {
    const httpSchema = openApi.components.schemas[name];
    if (
      httpSchema &&
      stableJson(projectDraft07(httpSchema, openApi.components.schemas)) !==
        stableJson(projectDraft07(rpcSchema, rpc.components.schemas))
    ) {
      throw new Error(`Incompatible OpenAPI/OpenRPC schema ${name}`);
    }
  }
}

function validateRefs(schema: Schema | undefined, schemas: Record<string, Schema>, owner: string): void {
  if (!schema) return;
  visitSchema(schema, (node) => {
    if (node.$ref && (!node.$ref.startsWith('#/components/schemas/') || !schemas[schemaName(node)]))
      throw new Error(`Unresolved schema reference ${node.$ref} in ${owner}`);
  });
}

function rpcType(schema: Schema, rpcSchemas: Record<string, Schema>, shared: Set<string>, owner?: string): string {
  if (schema.default === null) return 'null';
  if (schema['x-snowflake-id'] === true) return 'Shared.SnowflakeID';
  if (schema.$ref) {
    const name = schemaName(schema);
    return shared.has(name) ? `Shared.${name}` : name;
  }
  const variants = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  if (variants.length) return variants.map((variant) => rpcType(variant, rpcSchemas, shared, owner)).join(' | ');
  const allOf = schema.allOf ?? [];
  if (allOf.length) return allOf.map((part) => rpcType(part, rpcSchemas, shared, owner)).join(' & ');
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const mapped = types
    .filter(Boolean)
    .map(
      (type) =>
        ({
          string: 'string',
          integer: 'number',
          number: 'number',
          boolean: 'boolean',
          null: 'null',
          object: undefined,
          array: undefined,
        })[type!],
    );
  if (types.includes('array')) return `Array<${rpcType(schema.items ?? {}, rpcSchemas, shared)}>`;
  if (types.includes('object') || schema.properties) {
    const fields = Object.entries(schema.properties ?? {}).map(([name, property]) => {
      const required = schema.required?.includes(name);
      const value = required || nullableCommands[`${owner}.${name}`] ? property : withoutNull(property);
      return `${JSON.stringify(name)}${required ? '' : '?'}: ${rpcType(value, rpcSchemas, shared)};`;
    });
    const additional = schema.additionalProperties;
    if (additional && typeof additional === 'object')
      fields.push(`[key: string]: ${rpcType(additional, rpcSchemas, shared)};`);
    return `{ ${fields.join(' ')} }`;
  }
  return mapped.filter((type): type is string => Boolean(type)).join(' | ') || 'unknown';
}

function namespaceName(method: string): [string, string] {
  const [namespace, ...rest] = method.split('.');
  if (!namespace || !rest.length) throw new Error(`Invalid RPC method name ${method}`);
  return [namespace, rest.join('.')];
}

function methodProperty(name: string): string {
  return name.replace(/\.([a-z])/g, (_, character: string) => character.toUpperCase());
}

function generateRpcModels(rpc: OpenRpcDocument, openApi: OpenApiDocument): string {
  const rpcSchemas = rpc.components.schemas;
  const shared = new Set(Object.keys(openApi.components.schemas));
  const local = Object.keys(rpcSchemas)
    .filter((name) => !shared.has(name))
    .sort();
  const definitions = local
    .map((name) => {
      const type = rpcType(rpcSchemas[name], rpcSchemas, shared, name);
      return `export type ${name} = ${name === 'SessionOpenResult' ? type.replaceAll('"protocolVersion": number', '"protocolVersion": 1') : type};`;
    })
    .join('\n');
  return `/** Generated from OpenRPC by scripts/api-codegen.ts. */\nimport type * as Shared from '../models';\n\nexport type { SnowflakeID } from '../models';\nexport { RpcErrorCode } from './rpc-error-code';\nexport type { ${[...shared].sort().join(', ')} } from '../models';\n\n${definitions}\n\n`;
}

function generateRpcErrorCode(rpc: OpenRpcDocument): string {
  return `/** Generated from OpenRPC x-error-codes by scripts/api-codegen.ts. */\nexport enum RpcErrorCode {\n${rpc['x-error-codes'].map(({ name, code }) => `  ${name} = ${code},`).join('\n')}\n}\n`;
}

function generateRpcCodecs(rpc: OpenRpcDocument, openApi: OpenApiDocument): string {
  const schemas = rpc.components.schemas;
  const descriptors = Object.fromEntries(
    Object.entries(schemas)
      .filter(([name]) => name !== 'ServerWsMessage')
      .map(([name, schema]) => [name, codecFor(schema, schemas, true)]),
  );
  const schemaCodecs = Object.fromEntries(Object.entries(descriptors).filter(([, codec]) => codec !== undefined));
  const methodCodecs = Object.fromEntries(
    rpc.methods.map((method) => [
      method.name,
      {
        ...(method['x-params-schema'] ? { params: codecFor(method['x-params-schema'], schemas, true) } : {}),
        ...(method.result?.schema ? { result: codecFor(method.result.schema, schemas, true) } : {}),
      },
    ]),
  );
  const eventCodecs = Object.fromEntries(
    rpc['x-events'].map((event) => [
      event.name,
      codecFor(event['x-params-schema'] ?? event.params?.[0]?.schema, schemas, true) ?? 0,
    ]),
  );
  const shared = new Set(Object.keys(openApi.components.schemas));
  const local = Object.keys(schemas)
    .filter((name) => !shared.has(name))
    .sort();
  const eventMap = rpc['x-events']
    .map((event) => {
      const schema = event['x-params-schema'] ?? event.params?.[0]?.schema;
      return `  ${JSON.stringify(event.name)}: ${schema ? rpcType(schema, schemas, shared) : 'null'};`;
    })
    .join('\n');
  return `/** Generated from OpenRPC by scripts/api-codegen.ts. */\nimport type { JsonCodec } from './json-codecs';\nimport type * as Shared from './models';\nimport type { ${local.join(', ')} } from './rpc-models';\n\nexport type RpcMethodClass = 'read' | 'mutation' | 'session' | 'control';\nexport type RpcMethodCodec = { params?: JsonCodec; result?: JsonCodec };\nexport const rpcSchemas: Record<string, JsonCodec> = ${JSON.stringify(schemaCodecs, null, 2)};\nexport const rpcMethods: Record<string, RpcMethodCodec> = ${JSON.stringify(methodCodecs, null, 2)};\nexport const rpcMethodClasses: Record<string, RpcMethodClass> = ${JSON.stringify(Object.fromEntries(rpc.methods.map((method) => [method.name, method['x-execution-class']])), null, 2)};\nexport const rpcEvents: Record<string, JsonCodec> = ${JSON.stringify(eventCodecs, null, 2)};\nexport interface RpcEventMap {\n${eventMap}\n}\n`;
}

function generateRpcApi(rpc: OpenRpcDocument, openApi: OpenApiDocument): string {
  const schemas = rpc.components.schemas;
  const shared = new Set(Object.keys(openApi.components.schemas));
  const local = Object.keys(schemas)
    .filter((name) => !shared.has(name))
    .sort();
  const namespaces = new Map<string, OpenRpcMethod[]>();
  for (const method of rpc.methods) {
    const [namespace] = namespaceName(method.name);
    namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), method]);
  }
  const fields = [...namespaces.entries()]
    .map(
      ([namespace, entries]) =>
        `  readonly ${namespace} = {\n${entries
          .map((method) => {
            const [, name] = namespaceName(method.name);
            const params = method['x-params-schema'];
            const paramsSchema = params?.$ref ? schemas[schemaName(params)] : params;
            const paramsType = params ? rpcType(params, schemas, shared) : 'Record<string, never>';
            const resultType = method.result?.schema ? rpcType(method.result.schema, schemas, shared) : 'null';
            const required =
              paramsSchema?.properties &&
              Object.keys(paramsSchema.properties).some((key) => paramsSchema.required?.includes(key));
            return `    ${methodProperty(name)}: (params: ${paramsType}${required ? '' : ' = {}'}) => this.#call<${resultType}>(${JSON.stringify(method.name)}, params),`;
          })
          .join('\n')}\n  } as const;`,
    )
    .join('\n\n');
  return `/** Generated from OpenRPC by scripts/api-codegen.ts. */\nimport { Service, inject } from '@angular/core';\nimport { Subject, defer, map, tap, type Observable } from 'rxjs';\nimport { RpcTransport } from '../app/api/rpc-transport';\nimport { decodeJsonIds, encodeJsonIds } from '../app/api/json-ids';\nimport { rpcMethods, rpcSchemas } from './rpc-codecs';\nimport type * as Shared from './models';\nimport type { ${local.join(', ')} } from './rpc-models';\n\n@Service()\nexport class RpcApi {\n  readonly #transport = inject(RpcTransport);\n  readonly #results = new Subject<{ method: string; result: unknown }>();\n  readonly results$ = this.#results.asObservable();\n\n${fields}\n\n  #call<Result>(method: string, params: object): Observable<Result> {\n    return defer(() => {\n      const codecs = rpcMethods[method];\n      const request = decodeJsonIds(params, codecs?.params, rpcSchemas) as object;\n      return this.#transport.call<unknown>(method, request).pipe(\n        map((result) => encodeJsonIds(result, codecs?.result, rpcSchemas) as Result),\n        tap((result) => this.#results.next({ method, result })),\n      );\n    });\n  }\n}\n`;
}

async function loadJson(target: string): Promise<unknown> {
  if (/^https?:\/\//.test(target)) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`Unable to load ${target}: ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(target.startsWith('file:') ? new URL(target) : target, 'utf8'));
}

export function openRpcTarget(openApiTarget: string): string {
  if (process.env['OPENRPC_URL']) return process.env['OPENRPC_URL'];
  if (/^(?:https?|file):/.test(openApiTarget)) return new URL('openrpc.json', openApiTarget).toString();
  return resolve(dirname(openApiTarget), 'openrpc.json');
}

export async function finishApiGeneration(): Promise<void> {
  const alias = `${generatedRoot}/models/snowflakeID.ts`;
  const source = readFileSync(alias, 'utf8');
  if (!source.includes('export type SnowflakeID = number;')) throw new Error('Generated SnowflakeID alias changed');
  writeFileSync(
    alias,
    source.replace(
      'export type SnowflakeID = number;',
      "export type { SnowflakeID } from '../../app/api/snowflake-id';",
    ),
  );
  const metadataFile = `${generatedRoot}/json-codecs.ts`;
  writeFileSync(
    metadataFile,
    await format(httpMetadata, { ...(await resolveConfig(metadataFile)), filepath: metadataFile }),
  );
  addPathCodecs();
  if (!untransformedOpenApi) throw new Error('OpenAPI wire document was not captured before transformation');
  const rpc = (await loadJson(openRpcTarget(openApiSource ?? process.env['OPENAPI_URL'] ?? ''))) as OpenRpcDocument;
  validateRpcDocument(untransformedOpenApi, rpc);
  mkdirSync(`${generatedRoot}/rpc-models`, { recursive: true });
  for (const [file, content] of Object.entries({
    [`${generatedRoot}/rpc-models/index.ts`]: generateRpcModels(rpc, untransformedOpenApi),
    [`${generatedRoot}/rpc-models/rpc-error-code.ts`]: generateRpcErrorCode(rpc),
    [`${generatedRoot}/rpc-codecs.ts`]: generateRpcCodecs(rpc, untransformedOpenApi),
    [`${generatedRoot}/rpc-api.ts`]: generateRpcApi(rpc, untransformedOpenApi),
  }))
    writeFileSync(file, await format(content, { ...(await resolveConfig(file)), filepath: file }));
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
            for (const parameter of node.parameters)
              if (ts.isIdentifier(parameter.name)) {
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
        return (node: ts.Node) => visit(node) as ts.SourceFile;
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
