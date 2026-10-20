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

test('повреждённый JSON не перезаписывается при запуске', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'career-forms-corrupt-'));
  const file = join(dir, 'store.json');
  await writeFile(file, '{corrupt');
  try {
    await assert.rejects(boot(file), /Данные не перезаписаны/);
    assert.equal(await readFile(file, 'utf8'), '{corrupt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
