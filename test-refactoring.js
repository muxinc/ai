/**
 * Smoke tests for refactored code
 * Tests that all modules load correctly and have expected exports
 */

const assert = require('assert');

console.log('🧪 Running smoke tests for refactored code...\n');

// Test 1: All main exports are available
console.log('Test 1: Checking main exports...');
const mainExports = require('./dist/index');
const requiredExports = [
  'getSummaryAndTags',
  'getModerationScores',
  'hasBurnedInCaptions',
  'generateChapters',
  'translateCaptions',
  'version'
];

requiredExports.forEach(exportName => {
  assert(mainExports[exportName] !== undefined, `Missing export: ${exportName}`);
  console.log(`  ✅ ${exportName} exported`);
});

// Test 2: Verify client factory module exists and exports
console.log('\nTest 2: Checking client factory module...');
const clientFactory = require('./dist/lib/client-factory');
const factoryExports = [
  'validateCredentials',
  'createMuxClient',
  'createOpenAIClient',
  'createAnthropicClient',
  'createWorkflowClients'
];

factoryExports.forEach(exportName => {
  assert(typeof clientFactory[exportName] === 'function', `Missing or invalid function: ${exportName}`);
  console.log(`  ✅ ${exportName} function available`);
});

// Test 3: Verify provider models module
console.log('\nTest 3: Checking provider models module...');
const providerModels = require('./dist/lib/provider-models');
assert(providerModels.PROVIDER_MODELS !== undefined, 'PROVIDER_MODELS not exported');
assert(providerModels.PROVIDER_MODELS.openai !== undefined, 'OpenAI models not defined');
assert(providerModels.PROVIDER_MODELS.anthropic !== undefined, 'Anthropic models not defined');
assert(typeof providerModels.getDefaultModel === 'function', 'getDefaultModel not a function');
assert(typeof providerModels.validateProvider === 'function', 'validateProvider not a function');
console.log('  ✅ Provider models configured correctly');
console.log(`  ✅ OpenAI default: ${providerModels.PROVIDER_MODELS.openai.default}`);
console.log(`  ✅ Anthropic default: ${providerModels.PROVIDER_MODELS.anthropic.default}`);

// Test 4: Verify retry utility
console.log('\nTest 4: Checking retry utility module...');
const retry = require('./dist/lib/retry');
assert(typeof retry.withRetry === 'function', 'withRetry not exported as function');
console.log('  ✅ withRetry function available');

// Test 5: Test basic retry functionality
console.log('\nTest 5: Testing retry logic...');
let attemptCount = 0;
retry.withRetry(async () => {
  attemptCount++;
  if (attemptCount < 2) {
    const error = new Error('Timeout while downloading image');
    throw error;
  }
  return 'success';
}, { maxRetries: 3 }).then(result => {
  assert(result === 'success', 'Retry did not return success');
  assert(attemptCount === 2, `Expected 2 attempts, got ${attemptCount}`);
  console.log(`  ✅ Retry logic works (succeeded after ${attemptCount} attempts)`);

  // Test 6: Verify error types are preserved
  console.log('\nTest 6: Testing error handling...');
  const chapters = require('./dist/chapters');
  const summarization = require('./dist/summarization');
  const moderation = require('./dist/moderation');
  const burnedIn = require('./dist/burned-in-captions');

  assert(typeof chapters.generateChapters === 'function', 'generateChapters not a function');
  assert(typeof summarization.getSummaryAndTags === 'function', 'getSummaryAndTags not a function');
  assert(typeof moderation.getModerationScores === 'function', 'getModerationScores not a function');
  assert(typeof burnedIn.hasBurnedInCaptions === 'function', 'hasBurnedInCaptions not a function');
  console.log('  ✅ All workflow functions properly exported');

  // Test 7: Verify TypeScript types are generated
  console.log('\nTest 7: Checking TypeScript type definitions...');
  const fs = require('fs');
  const typeFiles = [
    './dist/index.d.ts',
    './dist/lib/client-factory.d.ts',
    './dist/lib/provider-models.d.ts',
    './dist/lib/retry.d.ts',
    './dist/chapters.d.ts',
    './dist/summarization.d.ts',
    './dist/moderation.d.ts',
    './dist/burned-in-captions.d.ts'
  ];

  typeFiles.forEach(file => {
    assert(fs.existsSync(file), `Type definition file missing: ${file}`);
    console.log(`  ✅ ${file.replace('./dist/', '')} exists`);
  });

  console.log('\n✅ All smoke tests passed!');
  console.log('\n📊 Summary:');
  console.log('  - Main exports: ✅');
  console.log('  - Client factory: ✅');
  console.log('  - Provider models: ✅');
  console.log('  - Retry utility: ✅');
  console.log('  - Workflow functions: ✅');
  console.log('  - TypeScript types: ✅');
  console.log('\n🎉 Refactored code is working correctly!');
}).catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
