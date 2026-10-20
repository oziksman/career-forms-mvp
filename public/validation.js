// One contract for browser controls, client validation and the HTTP API.
export const LIMITS = Object.freeze({
  questions: 30, title: 160, description: 2000, label: 240,
  options: 20, minOptions: 2, option: 160,
  text: 500, email: 254, textarea: 5000,
  // At most 30 × 5000 × 6 = 900,000 bytes of escaped answers, plus metadata.
  jsonBytes: 1024 * 1024,
});
const TYPES = new Set(['text', 'textarea', 'email', 'radio']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export class ValidationError extends Error {
  constructor(message, fields) { super(message); this.status = 422; this.fields = fields; }
}
const fail = (message, fields) => { throw new ValidationError(message, fields); };
function clean(value, max, name, singleLine = false) {
  if (typeof value !== 'string' || value.length > max) fail(`${name}: ожидается текст до ${max} символов`);
  if (singleLine && /[\r\n]/.test(value)) fail(`${name}: используйте одну строку`);
  return value.trim();
}
export function parseForm(input, publish = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Проверьте данные формы');
  const title = clean(input.title, LIMITS.title, 'Название', true);
  const description = clean(input.description, LIMITS.description, 'Описание');
  if (!title) fail('Добавьте название формы');
  if (!Array.isArray(input.fields) || input.fields.length > LIMITS.questions || (publish && !input.fields.length)) fail(`Добавьте от 1 до ${LIMITS.questions} вопросов`);
  const seen = new Set();
  const fields = input.fields.map((f, i) => {
    if (!f || !uuid(f.id) || seen.has(f.id) || !TYPES.has(f.type) || typeof f.required !== 'boolean') fail(`Проверьте вопрос ${i + 1}`);
    seen.add(f.id);
    const label = clean(f.label, LIMITS.label, `Вопрос ${i + 1}`, true);
    if (publish && !label) fail(`Добавьте название вопроса ${i + 1}`);
    let options = [];
    if (f.type === 'radio') {
      if (!Array.isArray(f.options)) fail(`Вопрос ${i + 1}: добавьте варианты ответа`);
      // Blank editor lines do not count as options, including a trailing newline.
      const nonempty = f.options.filter(o => typeof o !== 'string' || o.trim());
      if (nonempty.length > LIMITS.options) fail(`Вопрос ${i + 1}: не более ${LIMITS.options} вариантов`);
      options = nonempty.map((o, j) => clean(o, LIMITS.option, `Вопрос ${i + 1}, вариант ${j + 1}`, true));
      if (new Set(options).size !== options.length || (publish && options.length < LIMITS.minOptions)) fail(`Вопрос ${i + 1}: добавьте ${LIMITS.minOptions}–${LIMITS.options} неповторяющихся вариантов`);
    }
    return { id: f.id, type: f.type, label, required: f.required, options };
  });
  return { title, description, fields };
}
export function draftPayload(input, publish = false) {
  return { ...parseForm(input, publish), revision: input.revision };
}
export const answerLimit = type => type === 'radio' ? LIMITS.option : LIMITS[type];
export function parseAnswers(fields, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Проверьте ответы');
  const errors = {};
  const answers = {};
  for (const f of fields) {
    const val = raw[f.id] === undefined ? '' : raw[f.id];
    const max = answerLimit(f.type);
    if (typeof val !== 'string' || val.length > max) { errors[f.id] = `Не более ${max} символов`; continue; }
    const value = val.trim();
    if (f.type !== 'textarea' && /[\r\n]/.test(val)) errors[f.id] = 'Используйте одну строку';
    else if (!value && f.required) errors[f.id] = 'Ответьте на обязательный вопрос';
    else if (value && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[f.id] = 'Введите email в формате name@example.ru';
    else if (value && f.type === 'radio' && !f.options.includes(value)) errors[f.id] = 'Выберите один из предложенных вариантов';
    answers[f.id] = value;
  }
  if (Object.keys(errors).length) fail('Проверьте отмеченные поля', errors);
  return answers;
}
