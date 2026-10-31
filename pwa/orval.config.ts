import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig, type OpenApiSchemaObject } from 'orval';
import { captureOpenApiWireDocument, finishApiGeneration, transformApiSchema } from './scripts/api-codegen';

function openApiTarget() {
  if (process.env['OPENAPI_URL']) return process.env['OPENAPI_URL'];
  const envFile = new URL('../runspace/.env', import.meta.url);
  if (!existsSync(envFile)) {
    throw new Error('Start this worktree with node runspace/dev.mjs dev first, or set OPENAPI_URL.');
  }
  const { API_PORT } = parseEnv(readFileSync(envFile, 'utf8'));
  const port = Number(API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Set a valid API_PORT in this worktree's runspace/.env, or set OPENAPI_URL.");
  }
  return `http://127.0.0.1:${port}/api-docs/openapi.json`;
}

const apiTarget = openApiTarget();

export default defineConfig({
  chahua: {
    input: {
      target: apiTarget,
      override: {
        transformer(spec) {
          captureOpenApiWireDocument(spec, apiTarget);
          transformApiSchema(spec);
          const schemas = spec.components!.schemas!;
          const events = (schemas['ServerWsMessage'] as OpenApiSchemaObject).oneOf as OpenApiSchemaObject[];
          // Reuse the wire discriminants without widening the message union.
          schemas['ServerWsMessageType'] = {
            type: 'string',
            enum: events.flatMap((event) => (event.properties!['type'] as OpenApiSchemaObject).enum!),
          };
          return spec;
        },
      },
    },
    hooks: { afterAllFilesWrite: finishApiGeneration },
    output: {
      target: './src/generated/endpoints/chahua.ts',
      schemas: {
        path: './src/generated/models',
        splitByTags: true,
      },
      mode: 'tags-split',
      client: 'angular',
      clean: true,
      formatter: 'prettier',
      override: {
        enumGenerationType: 'enum',
        angular: {
          retrievalClient: 'both',
          baseUrl: { apiId: 'chahua' },
        },
      },
    },
  },
});
