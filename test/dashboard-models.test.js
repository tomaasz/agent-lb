import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml } from '../src/dashboard.js';

function select(value = '') {
  return {
    value, options: [], disabled: false,
    set innerHTML(_value) { this.options = []; this.value = ''; },
    appendChild(option) { this.options.push(option); if (!this.value) this.value = option.value; },
  };
}
function harness() {
  const elements = { selTestProvider: select('anthropic'), selTestModel: select(), selTestAccount: select(), colTestEffort: { style: {} } };
  let data = { data: [{ id: 'claude-live', provider: 'anthropic', name: 'Claude Live' },
    { id: 'gpt-future', provider: 'codex', name: '<b>literal name</b>' },
    { id: 'gpt-internal', provider: 'codex', name: 'Hidden', visibility: 'hide' }] };
  const calls = [];
  const context = vm.createContext({ pollGeneration: 0, currentLang: 'pl', lastStatus: { accounts: [] },
    Date, AbortController, setTimeout, clearTimeout, setInterval() {},
    document: { getElementById: id => elements[id], createElement: () => ({}) },
    apiCall: async url => { calls.push(url); if (data instanceof Error) throw data; return data; },
  });
  const html = renderDashboardHtml();
  vm.runInContext(html.slice(html.indexOf('  var testModels = []'), html.indexOf('  var testChatLog = []')), context);
  return { context, elements, calls, setData: d => { data = d; },
    load: async () => { context.loadTestModels(true); await new Promise(resolve => setImmediate(resolve)); } };
}

test('playground uses the live catalog for both providers, hides internal models and renders names as text', async () => {
  const h = harness(); await h.load();
  assert.deepEqual(h.calls, ['/v1/models']);
  assert.deepEqual(h.elements.selTestModel.options.map(o => o.value), ['claude-live']);
  h.elements.selTestProvider.value = 'codex'; h.context.updateTestModelsAndAccounts();
  assert.deepEqual(h.elements.selTestModel.options.map(o => o.value), ['gpt-future']);
  assert.equal(h.elements.selTestModel.options[0].textContent, '<b>literal name</b>');
  h.setData({ data: [{ id: 'gpt-newer', provider: 'codex', name: 'Newer' }] }); await h.load();
  assert.deepEqual(h.elements.selTestModel.options.map(o => o.value), ['gpt-newer']);
});

test('failed refresh clears the playground list instead of retaining retired models indefinitely', async () => {
  const h = harness(); await h.load();
  h.setData(new Error('network unavailable')); await h.load();
  assert.equal(h.elements.selTestModel.disabled, true);
  assert.equal(h.elements.selTestModel.options[0].value, '');
});

test('a hung catalog request is aborted and a later refresh can recover', async () => {
  const h = harness();
  let timeout;
  h.context.setTimeout = callback => { timeout = callback; return 1; };
  h.context.clearTimeout = () => {};
  h.context.apiCall = (_url, _method, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const pending = h.context.loadTestModels(true);
  timeout(); await pending;
  assert.equal(h.context.testModelsPending, false);
  assert.equal(h.elements.selTestModel.disabled, true);
  h.context.apiCall = async () => ({ data: [{ id: 'claude-recovered', provider: 'anthropic', name: 'Recovered' }] });
  await h.context.loadTestModels(true);
  assert.equal(h.elements.selTestModel.options[0].value, 'claude-recovered');
});
