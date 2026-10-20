import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { LIMITS, draftPayload, parseForm, parseAnswers } from '../public/validation.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const id = randomUUID;
const q = (type, label, required = true, options = []) => ({ id: id(), type, label, required, options });
async function boot(file, port = 0) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup timeout: ${output}`)); }, 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Exit ${code}: ${output}`)); });
  });
  return { base, async stop() { const exited = once(child, 'exit'); child.kill(); await exited; } };
}
async function call(base, path, payload, method = payload === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, data: await response.json() };
}

test('полный жизненный цикл, версии, валидация, PORT и сохранение на диске', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-'));
  const file = join(dir, 'store.json');
  let server = await boot(file);
  t.after(async () => { if (server) await server.stop(); await rm(dir, { recursive: true, force: true }); });
  let base = server.base;
  let form;
  let oldVersion;
  let payload;
  await t.test('HTTP: админка, статические ресурсы, редирект, 404', async () => {
    const admin = await fetch(base + '/admin');
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /lang="ru"/);
    assert.ok(admin.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal((await fetch(base + '/styles.css')).status, 200);
    const validation = await fetch(base + '/validation.js');
    assert.equal(validation.status, 200);
    assert.match(validation.headers.get('content-type'), /javascript/);
    assert.match(await validation.text(), /export function parseAnswers/);
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), '/admin');
    assert.equal((await fetch(base + '/missing')).status, 404);
  });
  await t.test('создание, закрытый черновик, четыре типа, публикация', async () => {
    const result = await call(base, '/api/admin/forms', { title: 'Стажировка <UX>', description: 'Описание\nВторая строка', fields: [q('text', 'Имя'), q('email', 'Почта'), q('radio', 'Направление', true, ['Дизайн', 'Разработка']), q('textarea', 'О себе', false)] });
    assert.equal(result.status, 200);
    form = result.data;
    assert.equal((await call(base, `/api/forms/${form.id}`)).status, 404);
    const published = await call(base, `/api/admin/forms/${form.id}/publish`, { revision: form.revision });
    assert.equal(published.status, 200);
    form = published.data;
    oldVersion = (await call(base, `/api/forms/${form.id}`)).data;
    assert.equal(oldVersion.version, 1);
    assert.equal(oldVersion.revision, undefined);
    payload = { sessionId: id(), requestId: id(), version: 1, answers: Object.fromEntries(form.fields.map((f, i) => [f.id, ['Тест Студент', 'student@example.test', 'Дизайн', 'Хочу учиться'][i]])) };
  });
  await t.test('сервер отклоняет обязательное поле, неверный email, вариант и длинный ответ', async () => {
    for (const [index, value] of [[0, ' '], [1, 'invalid'], [2, 'Другое'], [3, 'a'.repeat(5001)]]) {
      const invalid = structuredClone(payload);
      invalid.answers[form.fields[index].id] = value;
      const result = await call(base, `/api/forms/${form.id}/responses`, invalid);
      assert.equal(result.status, 422);
      assert.ok(result.data.fields[form.fields[index].id]);
    }
    assert.equal((await call(base, `/api/admin/forms/${form.id}/responses`)).data.length, 0);
  });
  await t.test('успешная отправка и повтор не создают дубль; аналитика дедуплицирует события', async () => {
    const path = `/api/forms/${form.id}`;
    const event = { sessionId: payload.sessionId, version: 1 };
    await Promise.all([call(base, path + '/events', { ...event, event: 'open' }), call(base, path + '/events', { ...event, event: 'start' }), call(base, path + '/events', { ...event, event: 'start' })]);
    const results = await Promise.all([call(base, path + '/responses', payload), call(base, path + '/responses', payload)]);
    assert.equal(results[0].status, 200);
    assert.equal(results[0].data.id, results[1].data.id);
    const read = (await call(base, `/api/admin/forms/${form.id}`)).data;
    assert.deepEqual(read.stats, { opens: 1, starts: 1, submissions: 1 });
  });
  await t.test('удаление, переименование и перестановка не меняют старые ответы; старая вкладка отправляется', async () => {
    form.title = 'Обновлённая стажировка';
    form.fields = [form.fields[2], form.fields[0]];
    form.fields[1].label = 'Полное имя';
    form = (await call(base, `/api/admin/forms/${form.id}`, form, 'PUT')).data;
    assert.equal((await call(base, `/api/forms/${form.id}`)).data.title, oldVersion.title);
    form = (await call(base, `/api/admin/forms/${form.id}/publish`, { revision: form.revision })).data;
    assert.equal(form.published.version, 2);
    assert.equal((await call(base, `/api/forms/${form.id}`)).data.fields[0].type, 'radio');
    const oldTab = await call(base, `/api/forms/${form.id}/responses`, { ...payload, requestId: id(), sessionId: id() });
    assert.equal(oldTab.status, 200);
    const responses = (await call(base, `/api/admin/forms/${form.id}/responses`)).data;
    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.equal(response.version, 1);
      assert.equal(response.fields.length, 4);
      assert.equal(response.fields[0].label, 'Имя');
      assert.equal(response.answers[oldVersion.fields[1].id], 'student@example.test');
    }
  });
  await t.test('optimistic locking предотвращает перезапись из другой вкладки, в том числе конкурентную', async () => {
    const draft = structuredClone(form);
    const concurrent = await Promise.all([call(base, `/api/admin/forms/${form.id}`, { ...draft, title: 'A' }, 'PUT'), call(base, `/api/admin/forms/${form.id}`, { ...draft, title: 'B' }, 'PUT')]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    form = concurrent.find(r => r.status === 200).data;
    assert.equal((await call(base, `/api/admin/forms/${form.id}/publish`, { revision: draft.revision })).status, 409);
  });
  await t.test('неверные схемы, чужой Origin и плохой JSON не принимаются', async () => {
    assert.equal((await call(base, '/api/admin/forms', { title: '', description: '', fields: [] })).status, 422);
    assert.equal((await call(base, '/api/admin/forms', { title: 'Форма', description: '', fields: [q('unknown', 'Ошибка')] })).status, 422);
    assert.equal((await call(base, '/api/admin/forms', { title: 'Форма', description: '', fields: [] }, 'POST', { Origin: 'https://other.test' })).status, 403);
    assert.equal((await fetch(base + '/api/admin/forms', { method: 'POST', body: '{broken' })).status, 400);
    assert.equal((await call(base, `/api/forms/${form.id}/responses`, { ...payload, version: 999 })).status, 409);
    const duplicate = q('text', 'Повтор');
    assert.equal((await call(base, '/api/admin/forms', { title: 'Форма', description: '', fields: [duplicate, duplicate] })).status, 422);
    const empty = (await call(base, '/api/admin/forms', { title: 'Пустая', description: '', fields: [] })).data;
    assert.equal((await call(base, `/api/admin/forms/${empty.id}/publish`, { revision: empty.revision })).status, 422);
  });
  await t.test('явный PORT, рестарт, JSON содержит версии и ответы', async () => {
    const expected = (await call(base, `/api/admin/forms/${form.id}/responses`)).data;
    const socket = http.createServer();
    await new Promise(resolve => socket.listen(0, resolve));
    const customPort = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await server.stop();
    server = null;
    server = await boot(file, customPort);
    base = server.base;
    assert.equal(base, `http://localhost:${customPort}`);
    assert.deepEqual((await call(base, `/api/admin/forms/${form.id}/responses`)).data, expected);
    assert.equal((await call(base, `/api/forms/${form.id}`)).data.version, 2);
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.responses.length, 2);
    assert.equal(disk.forms.find(f => f.id === form.id).versions.length, 2);
  });
});

test('30 длинных ответов по 5000 символов принимаются с учётом UTF-8 и JSON-экранирования', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-max-answers-'));
  const file = join(dir, 'store.json');
  const server = await boot(file);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const { base } = server;
  const fields = Array.from({ length: 30 }, (_, i) => q('textarea', `Вопрос ${i + 1}`));
  const created = await call(base, '/api/admin/forms', { title: 'Максимальная форма', description: '', fields });
  assert.equal(created.status, 200);
  const form = created.data;
  const published = await call(base, `/api/admin/forms/${form.id}/publish`, { revision: form.revision });
  assert.equal(published.status, 200);
  const path = `/api/forms/${form.id}/responses`;
  let payload;
  for (const char of ['a', 'Я', '漢', '\u0000']) {
    const answer = char.repeat(5000);
    payload = { sessionId: id(), requestId: id(), version: 1, answers: Object.fromEntries(fields.map(f => [f.id, answer])) };
    // One UTF-16 code unit can occupy six bytes in JSON (for example, \u0000).
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    assert.ok(bytes > 128 * 1024);
    assert.ok(bytes < 1024 * 1024);
    const result = await call(base, path, payload);
    assert.equal(result.status, 200, `Запрос ${bytes} байт: ${JSON.stringify(result.data)}`);
    const responses = (await call(base, `/api/admin/forms/${form.id}/responses`)).data;
    const saved = responses.find(r => r.id === result.data.id);
    assert.deepEqual(saved.answers, payload.answers);
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(disk.responses.find(r => r.id === result.data.id).answers, payload.answers);
  }

  const tooLong = { ...payload, requestId: id(), answers: { ...payload.answers, [fields[0].id]: 'Я'.repeat(5001) } };
  const invalid = await call(base, path, tooLong);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.data.fields[fields[0].id], 'Не более 5000 символов');

  // The transport cap still rejects excessive JSON, independently of field validation.
  const oversized = await call(base, path, { ...payload, requestId: id(), padding: 'a'.repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await call(base, `/api/admin/forms/${form.id}/responses`)).data.length, 4);
});

test('единый контракт конструктора, публичной формы и API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-contract-'));
  const server = await boot(join(dir, 'store.json'));
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const { base } = server;
  const formInput = () => ({ title: 'Форма', description: '', fields: [q('text', 'Имя')] });
  async function rejectForm(input) {
    let clientError;
    try { parseForm(input); } catch (error) { clientError = error; }
    assert.equal(clientError?.status, 422, 'Клиент должен отклонить схему');
    const api = await call(base, '/api/admin/forms', input);
    assert.equal(api.status, 422);
    assert.equal(api.data.error, clientError.message);
  }

  await t.test('границы названия, описания, вопросов и вариантов совпадают', async () => {
    const valid = { title: 'Я'.repeat(160), description: '漢'.repeat(2000), fields: [q('radio', 'В'.repeat(240), true, ['А'.repeat(160), 'Б'.repeat(160)])] };
    const created = await call(base, '/api/admin/forms', valid);
    assert.equal(created.status, 200);
    assert.deepEqual(created.data.fields, parseForm(valid).fields);
    for (const key of ['title', 'description']) {
      const input = structuredClone(valid);
      input[key] += 'X';
      await rejectForm(input);
    }
    for (const key of ['label', 'options']) {
      const input = structuredClone(valid);
      if (key === 'label') input.fields[0].label += 'X';
      else input.fields[0].options[0] += 'X';
      await rejectForm(input);
    }
    await rejectForm({ ...formInput(), fields: Array.from({ length: 31 }, () => q('text', 'Вопрос')) });
    for (const input of [
      { ...formInput(), title: 'Две\nстроки' },
      { ...formInput(), fields: [q('text', 'Две\r\nстроки')] },
      { ...formInput(), fields: [q('radio', 'Выбор', true, ['Две\nстроки', 'Другой'])] },
    ]) await rejectForm(input);
  });

  await t.test('20 вариантов с пустыми строками сохраняются; 21 и повтор после trim отклоняются', async () => {
    const options = Array.from({ length: 20 }, (_, i) => `Вариант ${i + 1}`);
    const input = { ...formInput(), fields: [q('radio', 'Выбор', true, ['', ...options, ' ', ''])] };
    const created = await call(base, '/api/admin/forms', input);
    assert.equal(created.status, 200);
    assert.deepEqual(created.data.fields[0].options, options);
    const published = await call(base, `/api/admin/forms/${created.data.id}/publish`, { revision: created.data.revision });
    assert.equal(published.status, 200);
    await rejectForm({ ...input, fields: [q('radio', 'Выбор', true, [...options, 'Лишний'])] });
    await rejectForm({ ...input, fields: [q('radio', 'Выбор', true, ['Дизайн', ' Дизайн '])] });
    await rejectForm({ ...input, fields: [q('radio', 'Выбор', true, ['Дизайн', null])] });
  });

  await t.test('незаполненный вопрос и один вариант допустимы в черновике, но не при публикации', async () => {
    for (const field of [q('text', ''), q('radio', 'Выбор', true, ['Один'])]) {
      const input = { ...formInput(), fields: [field] };
      const created = await call(base, '/api/admin/forms', input);
      assert.equal(created.status, 200);
      let clientError;
      try { draftPayload(created.data, true); } catch (error) { clientError = error; }
      const published = await call(base, `/api/admin/forms/${created.data.id}/publish`, { revision: created.data.revision });
      assert.equal(published.status, 422);
      assert.equal(published.data.error, clientError.message);
    }
  });

  await t.test('все типы ответов: точные границы, UTF-16, типы, переносы и варианты', async () => {
    const fields = [q('text', 'Текст'), q('email', 'Email'), q('textarea', 'Длинный текст'), q('radio', 'Выбор', true, ['Я'.repeat(160), 'Другой'])];
    const created = (await call(base, '/api/admin/forms', { ...formInput(), fields })).data;
    await call(base, `/api/admin/forms/${created.id}/publish`, { revision: created.revision });
    const emailSuffix = '@example.test';
    const valid = Object.fromEntries(fields.map((f, i) => [f.id, ['🙂'.repeat(250), 'a'.repeat(254 - emailSuffix.length) + emailSuffix, '🙂'.repeat(2500), 'Я'.repeat(160)][i]]));
    const submit = answers => call(base, `/api/forms/${created.id}/responses`, { answers, version: 1, sessionId: id(), requestId: id() });
    assert.equal((await submit(valid)).status, 200);
    assert.deepEqual(parseAnswers(fields, valid), valid);
    for (let i = 0; i < fields.length; i++) {
      for (const value of [valid[fields[i].id] + 'X', null, 123, ' ']) {
        const answers = { ...valid, [fields[i].id]: value };
        let clientError;
        try { parseAnswers(fields, answers); } catch (error) { clientError = error; }
        const result = await submit(answers);
        assert.equal(clientError?.status, 422);
        assert.equal(result.status, 422);
        assert.deepEqual(result.data.fields, clientError.fields);
      }
    }
    for (const [i, value] of [[0, 'Одна\nДругая'], [1, 'a@b.test\n'], [3, 'Несуществующий']]) {
      const answers = { ...valid, [fields[i].id]: value };
      assert.throws(() => parseAnswers(fields, answers), { status: 422 });
      assert.equal((await submit(answers)).status, 422);
    }
    const multiline = { ...valid, [fields[2].id]: 'Первая\nВторая' };
    assert.equal((await submit(multiline)).status, 200);
    assert.equal(parseAnswers(fields, multiline)[fields[2].id], 'Первая\nВторая');
    const optional = q('email', 'Email необязательно', false);
    const optionalForm = (await call(base, '/api/admin/forms', { ...formInput(), fields: [optional] })).data;
    await call(base, `/api/admin/forms/${optionalForm.id}/publish`, { revision: optionalForm.revision });
    for (const [value, expectedStatus] of [[' ', 200], ['не email', 422], [' name@example.test ', 200]]) {
      const answers = { [optional.id]: value };
      if (expectedStatus === 200) assert.equal(parseAnswers([optional], answers)[optional.id], value.trim());
      else assert.throws(() => parseAnswers([optional], answers), { status: 422 });
      const result = await call(base, `/api/forms/${optionalForm.id}/responses`, { answers, version: 1, sessionId: id(), requestId: id() });
      assert.equal(result.status, expectedStatus);
    }
  });

  await t.test('повтор отправки возвращает прежний отклик только при совпадении версии и ответов', async () => {
    const input = formInput();
    let form = (await call(base, '/api/admin/forms', input)).data;
    form = (await call(base, `/api/admin/forms/${form.id}/publish`, { revision: form.revision })).data;
    const path = `/api/forms/${form.id}/responses`;
    const payload = { sessionId: id(), requestId: id(), version: 1, answers: { [input.fields[0].id]: '  Исходный ответ  ' } };
    const first = await call(base, path, payload);
    assert.equal(first.status, 200);
    const retry = await call(base, path, { ...payload, answers: { [input.fields[0].id]: 'Исходный ответ' } });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.id, first.data.id);
    const changed = await call(base, path, { ...payload, answers: { [input.fields[0].id]: 'Изменённый ответ' } });
    assert.equal(changed.status, 409);
    assert.match(changed.data.error, /изменения не отправлены/);
    const invalid = await call(base, path, { ...payload, answers: { [input.fields[0].id]: 'a'.repeat(501) } });
    assert.equal(invalid.status, 422);
    form = (await call(base, `/api/admin/forms/${form.id}`, { ...draftPayload(form), title: 'Новая версия' }, 'PUT')).data;
    form = (await call(base, `/api/admin/forms/${form.id}/publish`, { revision: form.revision })).data;
    assert.equal(form.published.version, 2);
    assert.equal((await call(base, path, { ...payload, version: 2 })).status, 409);
    const saved = (await call(base, `/api/admin/forms/${form.id}/responses`)).data;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].answers[input.fields[0].id], 'Исходный ответ');
    assert.equal(saved[0].version, 1);
  });

  await t.test('максимальная опубликованная форма редактируется в пределах 1 МиБ без копии публикации', async () => {
    const options = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0') + '\u0001'.repeat(158));
    const input = { title: '\u0001'.repeat(160), description: '\u0001'.repeat(2000), fields: Array.from({ length: 30 }, () => q('radio', '\u0001'.repeat(240), true, options)) };
    const created = await call(base, '/api/admin/forms', input);
    assert.equal(created.status, 200);
    const published = await call(base, `/api/admin/forms/${created.data.id}/publish`, { revision: created.data.revision });
    assert.equal(published.status, 200);
    const current = published.data;
    assert.ok(Buffer.byteLength(JSON.stringify(current)) > LIMITS.jsonBytes, 'Обратная отправка всего admin-ответа превышала бы лимит');
    current.title = 'X' + current.title.slice(1);
    const payload = draftPayload(current);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < LIMITS.jsonBytes);
    assert.equal(payload.published, undefined);
    assert.equal(payload.stats, undefined);
    const saved = await call(base, `/api/admin/forms/${current.id}`, payload, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(saved.data.title, current.title);
    assert.equal(saved.data.published.title, input.title);
    assert.equal(saved.data.published.version, 1);
    const republished = await call(base, `/api/admin/forms/${current.id}/publish`, { revision: saved.data.revision });
    assert.equal(republished.status, 200);
    assert.equal(republished.data.published.version, 2);
    const unchanged = await call(base, `/api/admin/forms/${current.id}/publish`, { revision: republished.data.revision });
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.data.published.version, 2);
  });
});

test('старые публикации читаются и принимают исходный вариант после уточнения правил конструктора', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-legacy-'));
  const file = join(dir, 'store.json');
  const fields = [q('radio', 'Прежний\nвопрос', true, ['Старый\nвариант', 'Другой'])];
  const definition = { title: 'Прежняя\nформа', description: '', fields };
  const form = { id: id(), ...definition, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: [{ ...definition, version: 1, publishedAt: new Date().toISOString() }] };
  await writeFile(file, JSON.stringify({ schema: 1, forms: [form], responses: [], visits: [] }));
  const server = await boot(file);
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  const { base } = server;
  const admin = await call(base, `/api/admin/forms/${form.id}`);
  assert.equal(admin.status, 200);
  assert.equal(admin.data.dirty, false);
  const updated = { ...definition, title: 'Обновлённая форма', fields: [{ ...fields[0], label: 'Новый вопрос', options: ['Новый вариант', 'Другой'] }], revision: 1 };
  const saved = await call(base, `/api/admin/forms/${form.id}`, updated, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.dirty, true);
  assert.deepEqual(saved.data.published.fields, fields);
  const published = await call(base, `/api/admin/forms/${form.id}/publish`, { revision: saved.data.revision });
  assert.equal(published.status, 200);
  assert.equal(published.data.published.version, 2);
  const oldAnswers = { [fields[0].id]: fields[0].options[0] };
  assert.deepEqual(parseAnswers(fields, oldAnswers), oldAnswers);
  const response = await call(base, `/api/forms/${form.id}/responses`, { version: 1, sessionId: id(), requestId: id(), answers: oldAnswers });
  assert.equal(response.status, 200);
  const responses = (await call(base, `/api/admin/forms/${form.id}/responses`)).data;
  assert.deepEqual(responses[0].fields, fields);
  assert.deepEqual(responses[0].answers, oldAnswers);
});

test('повреждённый JSON не перезаписывается при запуске', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-corrupt-'));
  const file = join(dir, 'store.json');
  await writeFile(file, '{corrupt');
  try {
    await assert.rejects(boot(file), /Данные не перезаписаны/);
    assert.equal(await readFile(file, 'utf8'), '{corrupt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
