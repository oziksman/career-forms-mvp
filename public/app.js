import { LIMITS, answerLimit, parseAnswers, draftPayload } from '/validation.js';

const app = document.querySelector('#app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const uid = () => crypto.randomUUID();
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  forms: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/>',
  text: '<path d="M4 5h16M12 5v15M8 20h8"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  long: '<path d="M4 5h16M4 10h16M4 15h16M4 20h10"/>',
  radio: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="17" r="2"/><path d="M11 6h9M11 17h9"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.forms}</svg>`;
const types = { text: ['Короткий текст', 'text'], textarea: ['Длинный текст', 'long'], email: ['Email', 'mail'], radio: ['Один вариант', 'radio'] };
let current = null;
let dirty = false;
let busy = false;
let activeTab = 'questions';
let publicForm = null;
let student = null;
let toastTimer;
let previewTimer;

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос'), { fields: data.fields, status: response.status });
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Нет связи с сервером. Данные сохранены на этой странице. Попробуйте ещё раз.');
    throw error;
  } finally { clearTimeout(timer); }
}
const post = (url, body, method = 'POST') => request(url, { method, body: JSON.stringify(body) });
function notify(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}
function date(value) { return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function brand() { return `<a href="/admin" class="brand" data-nav><img src="/favicon.svg" width="36" height="36" alt="">отклик<span class="brand-dot">.</span></a>`; }
function shell(html) {
  app.innerHTML = `<div class="workspace"><aside class="sidebar">${brand()}<div class="workspace-label">КАРЬЕРНЫЙ ЦЕНТР</div><nav aria-label="Основная навигация"><a href="/admin" data-nav class="nav-item selected">${icon('forms')}<span>Мои формы</span><span class="nav-dot"></span></a></nav><div class="sidebar-bottom"><div class="local-label"><span></span> Локальное пространство</div><p>От первой возможности<br>до первого отклика.</p><div class="profile"><span class="avatar">КЦ</span><div><strong>Карьерный центр</strong><small>Рабочее пространство</small></div></div></div></aside><div class="main-wrap"><header class="topbar"><span>Пространство менеджера</span><span class="top-meta">Без авторизации <span class="avatar small">КЦ</span></span></header><main class="main" id="main">${html}</main><footer class="admin-footer">Отклик · Формы для новых возможностей<span>Сделано для карьерных центров</span></footer></div></div>`;
}
function loading(message = 'Загружаем формы…') { return `<div class="loading" role="status"><span class="spinner"></span>${esc(message)}</div>`; }
function errorBox(message, id = 'page-error') { return `<div class="error-banner" id="${id}" role="alert">${esc(message)}</div>`; }
function setError(message) {
  let node = document.querySelector('#page-error');
  if (!node) { document.querySelector('.page-heading')?.insertAdjacentHTML('afterend', errorBox(message)); node = document.querySelector('#page-error'); }
  else node.textContent = message;
  node?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function status(form) { return form.published ? '<span class="badge live"><span></span>Опубликована</span>' : '<span class="badge draft"><span></span>Черновик</span>'; }
function statCard(label, value, symbol, note = '') { return `<div class="stat-card"><div><span class="stat-label">${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div><span class="stat-icon">${icon(symbol)}</span></div>`; }

async function listPage() {
  current = null;
  dirty = false;
  document.title = 'Мои формы — Отклик';
  shell(loading());
  try {
    const forms = await request('/api/admin/forms');
    const live = forms.filter(f => f.published).length;
    const responses = forms.reduce((sum, f) => sum + f.stats.submissions, 0);
    shell(`<div class="eyebrow">ВОЗМОЖНОСТИ НАЧИНАЮТСЯ ЗДЕСЬ</div><div class="page-heading"><div><h1>Мои формы<span class="count">${forms.length}</span></h1><p>Собирайте отклики. Помогайте карьере начинаться.</p></div><button class="btn primary" data-action="create">${icon('plus')}Создать форму</button></div><section class="stats-grid" aria-label="Обзор">${statCard('Всего форм', forms.length, 'forms')}${statCard('Опубликовано', live, 'link')}${statCard('Получено откликов', responses, 'people')}</section><div class="section-heading"><h2>Все формы</h2><span>${forms.length ? 'Сначала новые' : 'Ваше пространство для идей'}</span></div>${forms.length ? `<div class="form-list">${forms.map(f => `<a class="form-row" href="/admin/forms/${f.id}" data-nav><span class="form-tile">${icon('forms')}</span><div class="row-info"><h3>${esc(f.title)}</h3><p>${f.fields.length} ${plural(f.fields.length, ['вопрос', 'вопроса', 'вопросов'])}<span>·</span>Изменена ${date(f.updatedAt)}</p></div>${status(f)}<div class="response-count"><strong>${f.stats.submissions}</strong><span>откликов</span></div><span class="row-arrow">${icon('arrow')}</span></a>`).join('')}</div>` : `<section class="empty-state"><div class="paper-illustration"><div class="paper"><i></i><i></i><i></i><b>${icon('check')}</b></div><span class="spark one">✳</span><span class="spark two">+</span></div><span class="eyebrow">С ЧЕГО НАЧНЁМ?</span><h2>Новая возможность — новая форма</h2><p>Откройте набор на стажировку или пригласите студентов<br class="desktop-only"> на мероприятие. Первую форму можно собрать за пару минут.</p><button class="btn primary" data-action="create">${icon('plus')}Создать первую форму</button><button class="btn text-btn" data-action="template">Начать с шаблона стажировки ${icon('arrow')}</button></section>`}<div class="tip-strip"><span class="tip-icon">✦</span><div><strong>Меньше вопросов — больше откликов</strong><p>Спрашивайте только то, что нужно для первого знакомства. Остальное можно узнать позже.</p></div><span class="tip-label">СОВЕТ</span></div>`);
  } catch (error) { shell(`${errorBox(error.message)}<button class="btn secondary" data-action="reload">Попробовать снова</button>`); }
}
function plural(n, words) { return words[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 1 : 2]; }
function question(type, label = '', required = false, options = []) { return { id: uid(), type, label, required, options }; }
async function createForm(template = false) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('[data-action="create"], [data-action="template"]').forEach(b => { b.disabled = true; });
  try {
    const form = await post('/api/admin/forms', template ? {
      title: 'Стажировка: первый шаг в профессию', description: 'Расскажите немного о себе. Мы свяжемся с вами по email и подскажем следующий шаг.',
      fields: [question('text', 'Как вас зовут?', true), question('email', 'Ваш email', true), question('radio', 'Какое направление вам интересно?', true, ['Разработка', 'Дизайн', 'Маркетинг']), question('textarea', 'Почему хотите пройти стажировку?')]
    } : { title: 'Новая форма', description: '', fields: [] });
    await navigate(`/admin/forms/${form.id}`, true);
    document.querySelector('#form-title')?.focus();
    document.querySelector('#form-title')?.select();
  } catch (error) { notify(error.message); }
  finally { busy = false; document.querySelectorAll('[data-action="create"], [data-action="template"]').forEach(b => { b.disabled = false; }); }
}
async function editorPage(id) {
  shell(loading('Загружаем конструктор…'));
  try {
    current = await request(`/api/admin/forms/${id}`);
    activeTab = 'questions';
    dirty = false;
    renderEditor();
  } catch (error) { shell(`${errorBox(error.message)}<a href="/admin" data-nav class="btn secondary">К списку форм</a>`); }
}
function editorHeader() {
  return `<a href="/admin" data-nav class="back-link">${icon('back')}Все формы</a><div class="page-heading editor-heading"><div><div class="title-line"><h1>${esc(current.title)}</h1>${status(current)}</div><p id="save-state" aria-live="polite">${dirty ? 'Есть несохранённые изменения' : `Сохранено · ${date(current.updatedAt)}`}</p></div><div class="actions"><button class="btn secondary" data-action="save">Сохранить</button><button class="btn primary" data-action="publish">${icon('arrow')}${current.published ? 'Опубликовать изменения' : 'Опубликовать'}</button></div></div><div class="tabs" role="tablist" aria-label="Раздел формы"><button role="tab" aria-selected="${activeTab === 'questions'}" data-action="questions" class="tab ${activeTab === 'questions' ? 'active' : ''}">${icon('forms')}Вопросы</button><button role="tab" aria-selected="${activeTab === 'responses'}" data-action="responses" class="tab ${activeTab === 'responses' ? 'active' : ''}">${icon('people')}Отклики <span class="tab-count">${current.stats.submissions}</span></button></div>`;
}
function shareCard() {
  if (!current.published) return '';
  const link = `${location.origin}/f/${current.id}`;
  return `<section class="share-card"><span class="share-icon">${icon('link')}</span><div><strong>Форма доступна по ссылке</strong><a href="/f/${current.id}" target="_blank" rel="noopener">${esc(link)}</a><small>Версия ${current.published.version}${current.dirty || dirty ? ' · Изменения появятся после публикации' : ''}</small></div><button class="btn secondary compact" data-action="copy">${icon('copy')}<span>Копировать</span></button><a class="icon-btn" href="/f/${current.id}" target="_blank" rel="noopener" aria-label="Открыть опубликованную форму">${icon('arrow')}</a></section>`;
}
function renderEditor() {
  document.title = `${current.title} — Отклик`;
  shell(`${editorHeader()}${shareCard()}<div class="builder-layout"><div class="builder-main"><section class="panel form-settings"><div class="panel-heading"><span class="step-label">01</span><div><h2>О форме</h2><p>Первое, что увидит студент</p></div></div><label for="form-title">Название <span class="required">*</span></label><input id="form-title" data-form="title" value="${esc(current.title)}" maxlength="${LIMITS.title}" placeholder="Например, летняя стажировка в дизайне"><label for="form-description">Описание <span class="optional">необязательно</span></label><textarea id="form-description" data-form="description" rows="3" maxlength="${LIMITS.description}" placeholder="Для кого эта возможность и что будет после отклика">${esc(current.description)}</textarea></section><section class="questions-section"><div class="section-heading"><div class="panel-heading"><span class="step-label">02</span><div><h2>Вопросы <span class="subtle-count">${current.fields.length}/${LIMITS.questions}</span></h2><p>Короткая форма — лёгкий первый шаг</p></div></div></div><div id="question-list">${current.fields.map(renderQuestion).join('') || '<div class="empty-questions">Добавьте первый вопрос с помощью кнопок ниже.</div>'}</div><div class="add-question"><span>Добавить вопрос</span><div class="type-buttons">${Object.entries(types).map(([type, [name, glyph]]) => `<button class="btn secondary" data-action="add" data-type="${type}" ${current.fields.length >= LIMITS.questions ? 'disabled' : ''}>${icon(glyph)}${name}${icon('plus')}</button>`).join('')}</div></div></section><p class="version-note">${icon('clock')}Изменения публикуются новой версией формы. Полученные отклики сохраняют вопросы, на которые отвечал студент.</p></div><aside class="preview-panel"><div class="preview-caption"><span>${icon('eye')}Вид для студента</span><span class="badge draft">Предпросмотр</span></div><div id="preview">${renderPreview()}</div><p class="preview-note">Это предпросмотр. Отправка станет доступна по опубликованной ссылке.</p></aside></div>`);
}
function renderQuestion(f, i) {
  return `<section class="panel question-card" data-field-id="${f.id}"><div class="question-toolbar"><span class="question-number">Вопрос ${String(i + 1).padStart(2, '0')}</span><div class="question-tools"><button class="icon-btn" data-action="up" data-id="${f.id}" aria-label="Вопрос ${i + 1}: переместить вверх" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="icon-btn" data-action="down" data-id="${f.id}" aria-label="Вопрос ${i + 1}: переместить вниз" ${i === current.fields.length - 1 ? 'disabled' : ''}>${icon('down')}</button><button class="icon-btn danger" data-action="delete" data-id="${f.id}" aria-label="Удалить вопрос ${i + 1}">${icon('trash')}</button></div></div><label class="sr-only" for="label-${f.id}">Текст вопроса ${i + 1}</label><input class="question-title" id="label-${f.id}" data-field="label" data-id="${f.id}" value="${esc(f.label)}" placeholder="Что хотите спросить?" maxlength="${LIMITS.label}"><div class="question-controls"><label class="type-select"><span class="sr-only">Тип вопроса ${i + 1}</span><select data-field="type" data-id="${f.id}">${Object.entries(types).map(([key, [name]]) => `<option value="${key}" ${f.type === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="switch-label"><input type="checkbox" role="switch" data-field="required" data-id="${f.id}" ${f.required ? 'checked' : ''}><span class="switch-track"></span>Обязательный</label></div>${f.type === 'radio' ? `<div class="options-editor"><label for="options-${f.id}">Варианты ответа <span class="optional">каждый с новой строки</span></label><textarea id="options-${f.id}" data-field="options" data-id="${f.id}" rows="3" placeholder="Первый вариант&#10;Второй вариант">${esc(f.options.join('\n'))}</textarea><small>От ${LIMITS.minOptions} до ${LIMITS.options} вариантов, до ${LIMITS.option} символов каждый. Пустые строки не учитываются.</small></div>` : `<div class="field-placeholder">${f.type === 'textarea' ? 'Развёрнутый ответ студента…' : f.type === 'email' ? 'name@example.ru' : 'Короткий ответ студента…'}</div>`}</section>`;
}
function renderPreview() {
  return `<div class="mini-form"><div class="mini-brand">✦ КАРЬЕРНЫЕ ВОЗМОЖНОСТИ</div><h2>${esc(current.title) || 'Название формы'}</h2><p class="preserve">${esc(current.description) || 'Здесь появится описание вашей возможности.'}</p><div class="mini-divider"></div>${current.fields.map((f, i) => `<div class="mini-question"><strong>${i + 1}. ${esc(f.label) || 'Новый вопрос'} ${f.required ? '<span class="required">*</span>' : ''}</strong>${f.type === 'radio' ? `<div class="mini-options">${f.options.map(o => o.trim()).filter(Boolean).map(o => `<span>○ ${esc(o)}</span>`).join('') || '<span>○ Варианты ответа</span>'}</div>` : `<div class="mini-input ${f.type === 'textarea' ? 'tall' : ''}">${f.type === 'email' ? 'name@example.ru' : 'Ваш ответ'}</div>`}</div>`).join('') || '<div class="preview-empty">Ваши вопросы появятся здесь</div>'}<div class="mini-submit">Отправить отклик ${icon('arrow')}</div><small>Начните свою следующую главу.</small></div>`;
}
function markDirty() {
  dirty = true;
  updateSaveState();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const preview = document.querySelector('#preview');
    if (preview) preview.innerHTML = renderPreview();
    const title = document.querySelector('.editor-heading h1');
    if (title) title.textContent = current.title || 'Новая форма';
  }, 160);
}
function updateSaveState() {
  const node = document.querySelector('#save-state');
  if (node) node.textContent = dirty ? 'Есть несохранённые изменения' : `Сохранено · ${date(current.updatedAt)}`;
}
function setBusy(value, action) {
  busy = value;
  document.querySelectorAll('[data-action="save"], [data-action="publish"]').forEach(b => {
    b.disabled = value;
    if (value && b.dataset.action === action) { b.dataset.original = b.innerHTML; b.innerHTML = `${icon('clock')}Сохраняем…`; }
    else if (!value && b.dataset.original) { b.innerHTML = b.dataset.original; delete b.dataset.original; }
  });
  // Freeze editing while a snapshot is saved, so later typing cannot be overwritten by the response.
  document.querySelectorAll('.builder-main input, .builder-main textarea, .builder-main select, .builder-main button, .tabs button').forEach(el => {
    if (value) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; }
    else if ('wasDisabled' in el.dataset) { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }
  });
}
async function save(publish = false) {
  if (busy || !current) return;
  let payload;
  try { payload = draftPayload(current, publish); }
  catch (error) { setError(error.message); return; }
  setBusy(true, publish ? 'publish' : 'save');
  document.querySelector('#page-error')?.remove();
  let draftSaved = false;
  try {
    if (dirty) {
      current = await post(`/api/admin/forms/${current.id}`, payload, 'PUT');
      dirty = false;
      draftSaved = true;
    }
    if (publish) current = await post(`/api/admin/forms/${current.id}/publish`, { revision: current.revision });
    if (activeTab === 'responses') await renderResponses(); else renderEditor();
    notify(publish ? 'Форма опубликована. Можно приглашать студентов!' : 'Черновик сохранён');
  } catch (error) {
    updateSaveState();
    setError(publish && draftSaved ? `Черновик сохранён. Не удалось подтвердить публикацию. ${error.message}` : error.message);
  }
  finally { setBusy(false); }
}
async function renderResponses() {
  activeTab = 'responses';
  const formId = current.id;
  shell(`${editorHeader()}${shareCard()}${loading('Загружаем отклики…')}`);
  try {
    const [responses, latest] = await Promise.all([request(`/api/admin/forms/${current.id}/responses`), request(`/api/admin/forms/${current.id}`)]);
    if (current?.id !== formId || activeTab !== 'responses') return;
    current.stats = latest.stats;
    const { opens, starts, submissions } = current.stats;
    shell(`${editorHeader()}${shareCard()}<section class="stats-grid analytics" aria-label="Аналитика формы">${statCard('Открытия', opens, 'eye', 'Сессии в этой форме')}${statCard('Начали заполнять', starts, 'text', 'Первое изменение ответа')}${statCard('Успешно отправили', submissions, 'check', 'Сохранённые отклики')}</section><details class="analytics-help"><summary>Как считаются показатели?</summary><p>Открытие — одна сессия вкладки браузера для этой формы. Начало — первое изменение любого ответа в этой сессии. Повторное открытие и редактирование в той же вкладке не увеличивают счётчики. Отправки — реально сохранённые отклики; повтор одного запроса не создаёт дубль. При успешной отправке сессия также считается открытой и начатой.</p><p>Это не уникальные люди: другая вкладка или браузер создают новую сессию. Без sessionStorage перезагрузка также создаст новую сессию. Блокировка запросов и сетевые ошибки могут занизить события. Боты не отфильтрованы. Данные суммируются по всем версиям формы.</p></details><div class="section-heading"><h2>Отклики <span class="subtle-count">${responses.length}</span></h2><button class="btn secondary compact" data-action="refresh">Обновить</button></div>${responses.length ? `<div class="responses-list">${responses.map((r, i) => `<details class="response-card"><summary><span class="response-avatar">${esc((Object.values(r.answers).find(Boolean) || 'С').slice(0, 1).toUpperCase())}</span><div><strong>${esc(r.fields.filter(f => ['text', 'email'].includes(f.type)).map(f => r.answers[f.id]).find(Boolean) || `Отклик ${responses.length - i}`)}</strong><small>${date(r.createdAt)} · Версия ${r.version}</small></div><span class="response-open">Посмотреть ${icon('down')}</span></summary><div class="response-body"><p class="response-form-title">${esc(r.title)} · вопросы на момент отправки</p>${r.fields.map(f => `<div class="answer"><dt>${esc(f.label)}</dt><dd>${esc(r.answers[f.id] || 'Нет ответа')}</dd></div>`).join('')}</div></details>`).join('')}</div>` : `<section class="empty-state small-empty"><span class="empty-round">${icon('people')}</span><h2>Первый отклик ещё впереди</h2><p>${current.published ? 'Поделитесь ссылкой со студентами. Новые ответы появятся здесь.' : 'Опубликуйте форму и поделитесь ссылкой со студентами.'}</p>${current.published ? '<button class="btn primary" data-action="copy">Скопировать ссылку</button>' : '<button class="btn primary" data-action="questions">Вернуться к вопросам</button>'}</section>`}`);
  } catch (error) {
    if (current?.id !== formId || activeTab !== 'responses') return;
    shell(`${editorHeader()}${errorBox(error.message)}<button class="btn secondary" data-action="refresh">Попробовать снова</button>`);
  }
}
function confirmDialog(title, message, confirmText = 'Удалить') {
  return new Promise(resolve => {
    const dialog = document.querySelector('#confirm-dialog');
    dialog.innerHTML = `<form method="dialog"><span class="eyebrow">ПОДТВЕРЖДЕНИЕ</span><h2 id="confirm-title">${esc(title)}</h2><p id="confirm-description">${esc(message)}</p><div class="dialog-actions"><button class="btn secondary" value="cancel" autofocus>Отмена</button><button class="btn primary" value="ok">${esc(confirmText)}</button></div></form>`;
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}
async function navigate(path, afterCreate = false) {
  if (busy && !afterCreate) return;
  if (dirty && !(await confirmDialog('Покинуть конструктор?', 'Несохранённые изменения будут потеряны. Сохраните черновик, чтобы вернуться к нему позже.', 'Выйти без сохранения'))) return;
  dirty = false;
  history.pushState({}, '', path);
  await route();
  window.scrollTo(0, 0);
}
function storageGet(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
function storageSet(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Form remains usable without storage. */ } }
function storageRemove(key) { try { sessionStorage.removeItem(key); } catch { /* Optional browser persistence. */ } }
let startSent = false;
async function sendEvent(event) {
  try {
    await post(`/api/forms/${publicForm.id}/events`, { event, version: publicForm.version, sessionId: student.sessionId });
    if (event === 'start') startSent = true;
  } catch { /* Analytics must never block the application flow. */ }
}
async function publicPage(id) {
  current = null;
  app.innerHTML = `<div class="student-shell">${loading('Готовим вашу следующую возможность…')}</div>`;
  try {
    publicForm = await request(`/api/forms/${id}`);
    document.title = `${publicForm.title} — Отклик`;
    const receipt = storageGet(`receipt:${id}`);
    if (receipt) { renderSuccess(receipt); return; }
    const key = `draft:${id}:${publicForm.version}`;
    const saved = storageGet(key);
    const session = storageGet(`session:${id}`) || uid();
    student = { answers: saved?.answers || {}, requestId: saved?.requestId || uid(), sessionId: session, key };
    storageSet(`session:${id}`, session);
    startSent = false;
    renderPublic();
    void sendEvent('open');
    if (Object.values(student.answers).some(Boolean)) void sendEvent('start');
  } catch (error) {
    app.innerHTML = `<div class="student-shell"><div class="student-nav">${brand()}</div><section class="student-card unavailable"><span class="empty-round">${icon('forms')}</span><h1>${error.status === 404 ? 'Форма недоступна' : 'Не удалось загрузить форму'}</h1><p>${esc(error.message)}</p><button class="btn primary" data-action="reload">Попробовать снова</button></section></div>`;
  }
}
function renderPublic() {
  app.innerHTML = `<div class="student-shell"><header class="student-nav">${brand()}<span>Ваша следующая возможность</span></header><main class="student-card"><div class="student-hero"><span class="eyebrow">КАРЬЕРА НАЧИНАЕТСЯ С ШАГА</span><span class="hero-spark" aria-hidden="true">✳</span><h1>${esc(publicForm.title)}</h1><p class="preserve">${esc(publicForm.description)}</p><div class="student-meta"><span>${icon('clock')}Около ${Math.max(1, Math.ceil(publicForm.fields.length * .4))} мин.</span><span>${publicForm.fields.length} ${plural(publicForm.fields.length, ['вопрос', 'вопроса', 'вопросов'])}</span></div></div><div class="progress-section"><div><span>Ваш прогресс</span><strong id="progress-label"></strong></div><progress id="progress" value="0" max="${publicForm.fields.length}" aria-label="Прогресс заполнения"></progress></div><form id="student-form" novalidate><p class="required-note"><span class="required">*</span> Обязательные вопросы</p>${publicForm.fields.map(studentField).join('')}<div id="submit-error" role="alert" class="error-banner" hidden></div><button class="btn primary submit-btn" type="submit">Отправить отклик ${icon('arrow')}</button><p class="student-footnote">Ответы получит команда карьерного центра.<br>При ошибке отправки введённые данные останутся в форме.</p></form></main><footer class="student-footer"><span>Создано в <strong>отклик.</strong></span><span>Большие истории начинаются с маленького шага</span></footer></div>`;
  updateProgress();
}
function studentField(f, i) {
  const val = student.answers[f.id] || '';
  const label = `<span class="field-index">${String(i + 1).padStart(2, '0')}</span>${esc(f.label)} ${f.required ? '<span class="required">*</span>' : '<span class="optional">необязательно</span>'}`;
  const attrs = `name="${f.id}" id="answer-${f.id}" aria-describedby="error-${f.id}" ${f.required ? 'required' : ''}`;
  return `<div class="student-question" id="group-${f.id}">${f.type === 'radio' ? `<fieldset><legend>${label}</legend><div class="radio-options">${f.options.map((o, j) => `<label class="radio-option"><input type="radio" name="${f.id}" value="${esc(o)}" ${o === val ? 'checked' : ''} ${f.required ? 'required' : ''} aria-describedby="error-${f.id}"><span>${esc(o)}</span></label>`).join('')}${!f.required ? `<label class="radio-option"><input type="radio" name="${f.id}" value="" ${!val ? 'checked' : ''}><span class="optional">Пропустить вопрос</span></label>` : ''}</div></fieldset>` : `<label for="answer-${f.id}">${label}</label>${f.type === 'textarea' ? `<textarea ${attrs} rows="4" maxlength="${LIMITS.textarea}" placeholder="Расскажите своими словами…">${esc(val)}</textarea>` : `<input ${attrs} type="${f.type === 'email' ? 'email' : 'text'}" maxlength="${answerLimit(f.type)}" ${f.type === 'email' ? 'autocomplete="email" inputmode="email"' : ''} value="${esc(val)}" placeholder="${f.type === 'email' ? 'name@example.ru' : 'Ваш ответ'}">`}`}<span class="field-error" id="error-${f.id}" aria-live="polite"></span></div>`;
}
function updateProgress() {
  const filled = publicForm.fields.filter(f => String(student.answers[f.id] || '').trim()).length;
  document.querySelector('#progress-label').textContent = `${filled} из ${publicForm.fields.length}`;
  document.querySelector('#progress').value = filled;
}
function showFieldErrors(errors) {
  for (const f of publicForm.fields) {
    const group = document.querySelector(`#group-${f.id}`);
    const message = errors[f.id] || '';
    group.classList.toggle('invalid', Boolean(message));
    group.querySelector('.field-error').textContent = message;
    group.querySelectorAll('input, textarea').forEach(el => { el.setAttribute('aria-invalid', String(Boolean(message))); });
  }
  const first = Object.keys(errors)[0];
  if (first) {
    const group = document.querySelector(`#group-${first}`);
    group.scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.querySelector('input,textarea')?.focus({ preventScroll: true });
  }
}
async function submitStudent(event) {
  event.preventDefault();
  if (busy) return;
  let answers;
  try { answers = parseAnswers(publicForm.fields, student.answers); }
  catch (error) { showFieldErrors(error.fields || {}); return; }
  showFieldErrors({});
  busy = true;
  const formNode = document.querySelector('#student-form');
  const button = formNode.querySelector('[type="submit"]');
  formNode.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true; });
  button.innerHTML = '<span class="spinner"></span>Отправляем…';
  document.querySelector('#submit-error').hidden = true;
  try {
    const result = await post(`/api/forms/${publicForm.id}/responses`, { answers, sessionId: student.sessionId, requestId: student.requestId, version: publicForm.version });
    storageRemove(student.key);
    const receipt = { ...result, title: publicForm.title };
    storageSet(`receipt:${publicForm.id}`, receipt);
    renderSuccess(receipt);
  } catch (error) {
    showFieldErrors(error.fields || {});
    const node = document.querySelector('#submit-error');
    node.hidden = false;
    node.textContent = error.message;
    storageSet(student.key, student);
  } finally {
    busy = false;
    if (formNode.isConnected) {
      formNode.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = false; });
      button.innerHTML = `Отправить отклик ${icon('arrow')}`;
    }
  }
}
function renderSuccess(receipt) {
  app.innerHTML = `<div class="student-shell"><div class="student-nav">${brand()}<span>Ваша следующая возможность</span></div><main class="student-card success-card"><div class="success-check">${icon('check')}</div><span class="eyebrow">ПЕРВЫЙ ШАГ СДЕЛАН</span><h1>Ваш отклик отправлен!</h1><p>Спасибо, что рассказали о себе.<br>Команда карьерного центра получила ваши ответы.</p><div class="receipt"><span>Форма</span><strong>${esc(receipt.title)}</strong><small>${date(receipt.createdAt)}</small></div><p class="success-note">Теперь можно закрыть эту страницу.<br>Удачи в вашей следующей главе ✦</p></main><footer class="student-footer"><span>Создано в <strong>отклик.</strong></span></footer></div>`;
  window.scrollTo(0, 0);
}

app.addEventListener('input', event => {
  const el = event.target;
  if (el.dataset.form && current) { current[el.dataset.form] = el.value; markDirty(); }
  if (el.dataset.field && current) {
    const field = current.fields.find(f => f.id === el.dataset.id);
    if (!field) return;
    const key = el.dataset.field;
    field[key] = key === 'required' ? el.checked : key === 'options' ? el.value.split('\n') : el.value;
    markDirty();
    if (key === 'type') {
      if (field.type === 'radio' && !field.options.length) field.options = ['Первый вариант', 'Второй вариант'];
      const card = el.closest('.question-card');
      card.outerHTML = renderQuestion(field, current.fields.indexOf(field));
      document.querySelector(`[data-field="type"][data-id="${field.id}"]`)?.focus();
    }
  }
  if (el.closest('#student-form') && el.name) {
    student.answers[el.name] = el.value;
    storageSet(student.key, student);
    updateProgress();
    const group = el.closest('.student-question');
    group.classList.remove('invalid');
    group.querySelector('.field-error').textContent = '';
    group.querySelectorAll('input,textarea').forEach(node => { node.removeAttribute('aria-invalid'); });
    if (!startSent) void sendEvent('start');
  }
});
app.addEventListener('submit', event => { if (event.target.id === 'student-form') void submitStudent(event); });
app.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]');
  if (nav && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); await navigate(nav.getAttribute('href')); return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'create' || action === 'template') return createForm(action === 'template');
  if (action === 'reload') return route();
  if (action === 'save' || action === 'publish') return save(action === 'publish');
  if (action === 'questions') { activeTab = 'questions'; renderEditor(); return; }
  if (action === 'responses' || action === 'refresh') return renderResponses();
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(`${location.origin}/f/${current.id}`); notify('Ссылка скопирована'); }
    catch { notify('Не удалось скопировать. Выделите ссылку в блоке публикации.'); }
    return;
  }
  if (action === 'add') {
    if (current.fields.length >= LIMITS.questions) return;
    const type = button.dataset.type;
    const field = question(type, '', false, type === 'radio' ? ['Первый вариант', 'Второй вариант'] : []);
    current.fields.push(field);
    markDirty();
    renderEditor();
    document.querySelector(`#label-${field.id}`)?.focus();
    return;
  }
  if (['up', 'down', 'delete'].includes(action)) {
    const i = current.fields.findIndex(f => f.id === button.dataset.id);
    if (action === 'delete') {
      if (!(await confirmDialog('Удалить вопрос?', 'Вопрос исчезнет из черновика. Уже полученные отклики сохранят его вместе с ответом.'))) return;
      current.fields.splice(i, 1);
    } else {
      const next = i + (action === 'up' ? -1 : 1);
      if (next < 0 || next >= current.fields.length) return;
      [current.fields[i], current.fields[next]] = [current.fields[next], current.fields[i]];
    }
    markDirty();
    renderEditor();
    document.querySelector(`[data-action="${action}"][data-id="${button.dataset.id}"]`)?.focus();
  }
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
let acceptedPath = location.pathname;
window.addEventListener('popstate', async () => {
  if (busy) { history.pushState({}, '', acceptedPath); return; }
  if (dirty && !(await confirmDialog('Покинуть конструктор?', 'Несохранённые изменения будут потеряны.', 'Выйти без сохранения'))) { history.pushState({}, '', acceptedPath); return; }
  dirty = false;
  await route();
});
async function route() {
  acceptedPath = location.pathname;
  const path = location.pathname.replace(/\/$/, '');
  if (path.startsWith('/f/')) return publicPage(path.split('/')[2]);
  if (path.startsWith('/admin/forms/')) return editorPage(path.split('/')[3]);
  return listPage();
}
void route();
