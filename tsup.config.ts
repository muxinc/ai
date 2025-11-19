import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'], // Build both ESM and CommonJS
  dts: true, // Generate .d.ts files
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [
    '@anthropic-ai/sdk',
    '@aws-sdk/client-s3',
    '@aws-sdk/lib-storage',
    '@aws-sdk/s3-request-presigner',
    '@mux/mux-node',
    'dotenv',
    'openai',
    'p-retry',
    'zod'
  ]
})
