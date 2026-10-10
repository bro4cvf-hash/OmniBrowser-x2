/* Structured user input: no default answer, timeout, or implied consent. */
(function (root) {
  const schema = {
    questions: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Unique short identifier' },
        question: { type: 'string', description: 'Self-contained question' },
        reason: { type: 'string', description: 'Why this answer is needed' },
        options: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } }
      }, required: ['id', 'question']
    } }
  };
  function validate(args) {
    if (!args || !Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) throw new Error('Ask 1 to 3 questions.');
    const ids = new Set();
    const bounded = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
    return { questions: args.questions.map(q => {
      if (!q || !bounded(q.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(q.id) || ids.has(q.id) || !bounded(q.question, 500)) throw new Error('Questions need unique IDs and clear question text.');
      ids.add(q.id);
      if (q.reason !== undefined && !bounded(q.reason, 600)) throw new Error('Invalid question reason.');
      if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 6)) throw new Error('Provide at most 6 options.');
      const labels = new Set();
      const options = (q.options || []).map(option => {
        if (!option || !bounded(option.label, 100) || labels.has(option.label.trim()) || (option.description !== undefined && !bounded(option.description, 300))) throw new Error('Options need unique labels and short descriptions.');
        labels.add(option.label.trim());
        return { label: option.label.trim(), ...(option.description ? { description: option.description.trim() } : {}) };
      });
      return { id: q.id, question: q.question.trim(), ...(q.reason ? { reason: q.reason.trim() } : {}), options };
    }) };
  }
  function validateAnswers(args, result) {
    const request = validate(args);
    if (result?.status !== 'answered' || !result.answers || typeof result.answers !== 'object') throw new Error('User input was not answered.');
    const answers = Object.create(null);
    for (const q of request.questions) {
      const answer = result.answers[q.id];
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000) throw new Error('Every question needs an explicit answer.');
      answers[q.id] = answer.trim();
    }
    return { status: 'answered', answers };
  }
  function answerText(args, result) {
    return validate(args).questions.map(q => `${q.question}\nMy answer: ${result.answers[q.id]}`).join('\n\n');
  }
  function request(args, { container, signal, onAnswered = () => {} } = {}) {
    const data = validate(args);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const doc = container.ownerDocument;
      const form = doc.createElement('form'); form.className = 'questionCard';
      form.setAttribute('aria-label', 'Questions from your assistant');
      const heading = doc.createElement('h3'); heading.textContent = 'Your input is needed'; form.append(heading);
      const controls = [];
      const prefix = 'question-' + (root.crypto?.randomUUID?.() || Date.now());
      for (const q of data.questions) {
        const group = doc.createElement('fieldset');
        const legend = doc.createElement('legend'); legend.textContent = q.question; group.append(legend);
        if (q.reason) { const reason = doc.createElement('p'); reason.className = 'hint'; reason.textContent = q.reason; group.append(reason); }
        const radios = [];
        q.options.forEach((option, index) => {
          const label = doc.createElement('label'); label.className = 'questionOption';
          const radio = doc.createElement('input'); radio.type = 'radio'; radio.name = `${prefix}-${q.id}`; radio.value = option.label;
          const text = doc.createElement('span'); text.textContent = option.label;
          if (option.description) { const small = doc.createElement('small'); small.textContent = option.description; text.append(small); }
          label.append(radio, text); group.append(label); radios.push(radio);
        });
        const label = doc.createElement('label'); label.className = 'questionTextLabel';
        label.textContent = q.options.length ? 'Or write your own answer' : 'Your answer';
        const input = doc.createElement('textarea'); input.rows = 2; input.maxLength = 4000;
        label.append(input); group.append(label); form.append(group);
        input.addEventListener('input', () => { if (input.value.trim()) radios.forEach(radio => { radio.checked = false; }); update(); });
        radios.forEach(radio => radio.addEventListener('change', () => { input.value = ''; update(); }));
        controls.push({ q, input, radios });
      }
      const status = doc.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status'); status.textContent = 'Choose an option or type an answer for each question.';
      const submit = doc.createElement('button'); submit.type = 'submit'; submit.textContent = 'Send answers'; submit.disabled = true;
      form.append(status, submit); container.append(form);
      const value = row => row.input.value.trim() || row.radios.find(radio => radio.checked)?.value || '';
      function update() { submit.disabled = controls.some(row => !value(row)); }
      let settled = false;
      function finish() { settled = true; signal?.removeEventListener('abort', abort); form.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true; }); }
      function abort() { if (settled) return; finish(); status.textContent = 'Question interrupted. No answer was sent.'; reject(new DOMException('Stopped', 'AbortError')); }
      signal?.addEventListener('abort', abort, { once: true });
      form.addEventListener('submit', event => {
        event.preventDefault(); if (settled || controls.some(row => !value(row))) return;
        const answers = Object.fromEntries(controls.map(row => [row.q.id, value(row)]));
        const result = validateAnswers(data, { status: 'answered', answers });
        finish(); status.textContent = 'Answers sent. Continuing…';
        onAnswered(answerText(data, result)); resolve(result);
      });
      (controls[0].radios[0] || controls[0].input).focus();
      form.scrollIntoView({ block: 'nearest' });
    });
  }
  const api = { schema, validate, validateAnswers, answerText, request };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmniQuestions = api;
})(globalThis);
