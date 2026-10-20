import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import * as contract from '../public/validation.js';

// Exercise the actual UI module without external test dependencies. Minimal DOM
// doubles capture rendered controls/errors; HTTP behavior is covered in api.test.js.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import .* from '\/validation\.js';\r?\n/m, '')
  .replace('void route();', '');
const field = (type, options = []) => ({ id: randomUUID(), type, label: 'Вопрос', required: true, options });
function client(form) {
  const app = { innerHTML: '', addEventListener() {} };
  const banner = { textContent: '', remove() {}, scrollIntoView() {} };
  const toast = {};
  const errors = new Map();
  const requests = [];
  const document = {
    querySelector(selector) {
      if (selector === '#app') return app;
      if (selector === '#page-error') return banner;
      if (selector === '#toast') return toast;
      if (selector.startsWith('#group-')) {
        const id = selector.slice('#group-'.length);
        if (!errors.has(id)) errors.set(id, { textContent: '' });
        return { classList: { toggle() {} }, scrollIntoView() {}, querySelectorAll: () => [], querySelector: s => s === '.field-error' ? errors.get(id) : { focus() {} } };
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  const context = createContext({
    ...contract, document, fixture: form, crypto: { randomUUID }, AbortController,
    location: { pathname: `/admin/forms/${form.id}`, origin: 'http://localhost:3000' },
    window: { addEventListener() {}, scrollTo() {} },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, bytes: Buffer.byteLength(options.body) });
      return { ok: true, json: async () => ({ ...form, ...body, revision: form.revision + 1 }) };
    },
  });
  runInContext(source, context);
  runInContext('current = fixture; dirty = true; publicForm = fixture; student = { answers: {} };', context);
  return { context, app, banner, errors, requests, run: js => runInContext(js, context) };
}
function fixture(fields) {
  return { id: randomUUID(), title: 'Форма', description: '', fields, revision: 1, updatedAt: new Date().toISOString(), published: null, stats: { submissions: 0 } };
}

test('UI: maxlength и лимит вопросов согласованы с общим контрактом', () => {
  const ui = client(fixture([field('text'), field('email'), field('textarea'), field('radio', ['А', 'Б'])]));
  ui.run('renderEditor()');
  assert.match(ui.app.innerHTML, /id="form-title"[^>]*maxlength="160"/);
  assert.match(ui.app.innerHTML, /id="form-description"[^>]*maxlength="2000"/);
  assert.match(ui.app.innerHTML, /class="question-title"[^>]*maxlength="240"/);
  assert.doesNotMatch(ui.app.innerHTML, /<textarea id="options-[^>]*maxlength=/);
  assert.match(ui.app.innerHTML, /до 160 символов каждый/);
  const controls = ui.run('current.fields.map(studentField).join("")');
  assert.match(controls, /type="text" maxlength="500"/);
  assert.match(controls, /type="email" maxlength="254"/);
  assert.match(controls, /<textarea[^>]*maxlength="5000"/);
  ui.context.fixture = fixture(Array.from({ length: 30 }, () => field('text')));
  ui.run('current = fixture; renderEditor()');
  assert.match(ui.app.innerHTML, /30\/30/);
  assert.equal((ui.app.innerHTML.match(/data-action="add"[^>]*disabled/g) || []).length, 4);
  ui.context.fixture = fixture([field('radio', ['', ' А ', 'Б', ' '])]);
  ui.run('current = fixture');
  const preview = ui.run('renderPreview()');
  assert.match(preview, /<span>○ А<\/span><span>○ Б<\/span>/);
  assert.equal((preview.match(/<span>○ /g) || []).length, 2);
});

test('UI: неверный вариант и восстановленный длинный ответ отклоняются до HTTP-запроса', async () => {
  const radio = field('radio', ['А'.repeat(161), 'Б']);
  const ui = client(fixture([radio]));
  await ui.run('save()');
  assert.match(ui.banner.textContent, /вариант 1.*160/);
  assert.equal(ui.requests.length, 0);
  ui.context.answer = 'a'.repeat(501);
  ui.context.fixture = fixture([field('text')]);
  ui.run('publicForm = fixture; student = { answers: { [fixture.fields[0].id]: answer } };');
  await ui.run('submitStudent({ preventDefault() {} })');
  assert.equal(ui.errors.get(ui.context.fixture.fields[0].id).textContent, 'Не более 500 символов');
  assert.equal(ui.requests.length, 0);
});

test('UI: сохранение большой опубликованной формы отправляет только черновик', async () => {
  const options = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0') + '\u0001'.repeat(158));
  const form = fixture(Array.from({ length: 30 }, () => field('radio', options)));
  form.published = { title: form.title, description: form.description, fields: structuredClone(form.fields), version: 1 };
  assert.ok(Buffer.byteLength(JSON.stringify(form)) > contract.LIMITS.jsonBytes);
  const ui = client(form);
  await ui.run('save()');
  assert.equal(ui.requests.length, 1);
  const request = ui.requests[0];
  assert.ok(request.bytes < contract.LIMITS.jsonBytes);
  assert.equal(request.body.published, undefined);
  assert.equal(request.body.stats, undefined);
  assert.deepEqual(request.body.fields, form.fields);
});
