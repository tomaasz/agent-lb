import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelChangeNote } from '../src/model-substitution.js';

test('modelChangeNote is null when the model is unchanged', () => {
  assert.equal(modelChangeNote('gpt-6.1-sol', 'gpt-6.1-sol', 'acc'), null);
});

test('modelChangeNote is null without a requested model', () => {
  assert.equal(modelChangeNote(undefined, 'gpt-5.6-sol', 'acc'), null);
});

test('modelChangeNote names both models and the account', () => {
  const note = modelChangeNote('gpt-5.6', 'gpt-5.6-sol', 'tomaasz@gmail.com');
  assert.match(note, /gpt-5\.6/);
  assert.match(note, /gpt-5\.6-sol/);
  assert.match(note, /tomaasz@gmail\.com/);
});
