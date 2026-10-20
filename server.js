import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LIMITS, parseForm as schema, parseAnswers as answersFor } from './public/validation.js';

const root = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.env.DATA_FILE || join(root, 'data/store.json'));
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT должен быть числом от 0 до 65535');
mkdirSync(dirname(file), { recursive: true });
let db;
try {
  db = JSON.parse(readFileSync(file, 'utf8'));
  if (db.schema !== 1 || !Array.isArray(db.forms) || !Array.isArray(db.responses) || !Array.isArray(db.visits)) throw new Error('Неверный формат хранилища');
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${file}. Данные не перезаписаны. ${error.message}`);
  db = { schema: 1, forms: [], responses: [], visits: [] };
  persist(db);
}

function persist(next) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
// Synchronous, atomic transactions: acknowledge only after the file is on disk.
function transaction(fn) {
  const next = structuredClone(db);
  const result = fn(next);
  persist(next);
  db = next;
  return result;
}
function fail(status, message, fields) { throw Object.assign(new Error(message), { status, fields }); }
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function getForm(id) {
  const form = db.forms.find(f => f.id === id);
  if (!form) fail(404, 'Форма не найдена');
  return form;
}
function adminForm(form) {
  const { versions, ...draft } = form;
  const published = versions.at(-1) || null;
  const views = db.visits.filter(v => v.formId === form.id);
  const responses = db.responses.filter(r => r.formId === form.id);
  const starts = views.filter(v => v.started).length;
  return { ...draft, published, dirty: !published || JSON.stringify(schema(form)) !== JSON.stringify(schema(published)),
    stats: { opens: views.length, starts, submissions: responses.length } };
}
function versionOf(form, number) {
  const version = form.versions.find(v => v.version === number);
  if (!version) fail(409, 'Версия формы недоступна. Обновите страницу.');
  return version;
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.jsonBytes) fail(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail(400, 'Некорректный JSON'); }
}
async function api(req, path) {
  const method = req.method;
  if (path === '/api/admin/forms' && method === 'GET') return db.forms.map(adminForm).reverse();
  if (path === '/api/admin/forms' && method === 'POST') {
    const draft = schema(await body(req));
    const form = { id: randomUUID(), ...draft, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: [] };
    transaction(next => next.forms.push(form));
    return adminForm(form);
  }
  let match = path.match(/^\/api\/admin\/forms\/([\w-]+)(?:\/(publish|responses))?$/);
  if (match) {
    let form = getForm(match[1]);
    if (!match[2] && method === 'GET') return adminForm(form);
    if (match[2] === 'responses' && method === 'GET') return db.responses.filter(r => r.formId === form.id).reverse();
    if ((!match[2] && method === 'PUT') || (match[2] === 'publish' && method === 'POST')) {
      const input = await body(req);
      form = getForm(match[1]);
      if (input.revision !== form.revision) fail(409, 'Форма изменена в другой вкладке. Сохраните свой текст отдельно и обновите страницу.');
      const draft = schema(match[2] ? form : input, Boolean(match[2]));
      transaction(next => {
        const target = next.forms.find(f => f.id === form.id);
        if (!match[2]) Object.assign(target, draft);
        else if (adminForm(form).dirty) target.versions.push({ ...draft, version: target.versions.length + 1, publishedAt: new Date().toISOString() });
        target.revision++;
        target.updatedAt = new Date().toISOString();
      });
      return adminForm(getForm(form.id));
    }
  }
  match = path.match(/^\/api\/forms\/([\w-]+)(?:\/(events|responses))?$/);
  if (match) {
    const form = getForm(match[1]);
    if (!form.versions.length) fail(404, 'Эта форма ещё не опубликована');
    if (!match[2] && method === 'GET') return { id: form.id, ...form.versions.at(-1) };
    if (method === 'POST' && match[2]) {
      const input = await body(req);
      if (!uuid(input.sessionId)) fail(422, 'Некорректный идентификатор сессии');
      const version = versionOf(form, input.version);
      if (match[2] === 'events') {
        if (!['open', 'start'].includes(input.event)) fail(422, 'Неизвестное событие');
        const visit = db.visits.find(v => v.formId === form.id && v.sessionId === input.sessionId);
        if (!visit || (input.event === 'start' && !visit.started)) transaction(next => {
          let target = next.visits.find(v => v.formId === form.id && v.sessionId === input.sessionId);
          if (!target) { target = { formId: form.id, sessionId: input.sessionId, started: false }; next.visits.push(target); }
          if (input.event === 'start') target.started = true;
        });
        return { ok: true };
      }
      if (!uuid(input.requestId)) fail(422, 'Некорректный идентификатор отправки');
      const existing = db.responses.find(r => r.formId === form.id && r.requestId === input.requestId);
      if (existing) return { id: existing.id, createdAt: existing.createdAt };
      const answers = answersFor(version.fields, input.answers);
      const response = { id: randomUUID(), requestId: input.requestId, formId: form.id, version: version.version, createdAt: new Date().toISOString(), title: version.title, fields: structuredClone(version.fields), answers };
      transaction(next => {
        let visit = next.visits.find(v => v.formId === form.id && v.sessionId === input.sessionId);
        if (!visit) { visit = { formId: form.id, sessionId: input.sessionId }; next.visits.push(visit); }
        visit.started = true;
        next.responses.push(response);
      });
      return { id: response.id, createdAt: response.createdAt };
    }
  }
  fail(404, 'Адрес не найден');
}

const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/validation.js', ['validation.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      // Disallow cross-origin browser writes. No CORS; admin is intentionally unauthenticated.
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) fail(403, 'Запрос с другого сайта запрещён');
      const result = await api(req, path);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } else if (['GET', 'HEAD'].includes(req.method)) {
      if (path === '/') { res.writeHead(302, { Location: '/admin' }); res.end(); return; }
      const asset = assets.get(path);
      if (!asset && !/^\/admin(?:\/forms\/[\w-]+)?\/?$/.test(path) && !/^\/f\/[\w-]+\/?$/.test(path)) fail(404, 'Страница не найдена');
      res.writeHead(200, { 'Content-Type': asset?.[1] || 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', asset?.[0] || 'index.html')));
    } else fail(405, 'Метод не поддерживается');
  } catch (error) {
    if (!error.status) console.error(error);
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.status ? error.message : 'Не удалось сохранить данные. Попробуйте ещё раз.', fields: error.fields }));
  }
});
server.on('error', error => { console.error(`Ошибка запуска: ${error.message}`); process.exit(1); });
server.listen(port, () => console.log(`Отклик: http://localhost:${server.address().port}\nАдминка: /admin`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
