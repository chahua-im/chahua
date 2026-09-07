import { defineConfig, type OpenApiSchemaObject } from 'orval';
import { finishApiGeneration, transformApiSchema } from './scripts/api-codegen';

export default defineConfig({
  chahua: {
    input: {
      target: process.env['OPENAPI_URL'] ?? 'http://127.0.0.1:3000/api-docs/openapi.json',
      override: {
        transformer(spec) {
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
