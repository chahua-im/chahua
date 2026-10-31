import { describe, expect, it } from 'vitest';

import { validateRpcDocument } from './api-codegen';

type TestSchema = { type?: string; $ref?: string };

const openApi = { components: { schemas: {} as Record<string, TestSchema> }, paths: {} };

function rpcDocument() {
  return {
    openrpc: '1.4.0',
    components: { schemas: {} as Record<string, TestSchema> },
    methods: [
      {
        name: 'users.getMe',
        params: [],
        result: { schema: { type: 'null' } as TestSchema },
        'x-execution-class': 'read' as const,
      },
    ],
    'x-events': [],
    'x-error-codes': [],
  };
}

describe('OpenRPC schema validation', () => {
  it('rejects duplicate RPC method literals', () => {
    const rpc = rpcDocument();
    rpc.methods.push({ ...rpc.methods[0] });

    expect(() => validateRpcDocument(openApi, rpc)).toThrow();
  });

  it('rejects unresolved component references before generation', () => {
    const rpc = rpcDocument();
    rpc.methods[0].result = { schema: { $ref: '#/components/schemas/MissingResult' } };

    expect(() => validateRpcDocument(openApi, rpc)).toThrow();
  });

  it('rejects incompatible shared OpenAPI and OpenRPC component schemas', () => {
    const rpc = rpcDocument();
    rpc.components.schemas.Shared = { type: 'string' };
    const http = {
      components: { schemas: { Shared: { type: 'integer' } } as Record<string, TestSchema> },
      paths: {},
    };

    expect(() => validateRpcDocument(http, rpc)).toThrow();
  });
});
