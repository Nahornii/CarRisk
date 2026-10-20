/* CarRisk Lab — оцінювання автомобільних оголошень через Jev API. */
(() => {
  'use strict';

  const JEV_MODEL = 'jev-latest';
  const API_URL = '/api/jev/analyze';
  const MODELS_URL = '/api/jev/models';
  const MIN_DESCRIPTION_LENGTH = 30;
  const MAX_HISTORY = 12;
  const $ = (id) => document.getElementById(id);
  const appState = { history: [], latest: null, timer: null, busy: false, toastTimer: null };

  const EXAMPLES = {
    contradictory: {
      name: 'Jaguar XE 2.0D', year: '2016', mileage: '210000', price: '12 500 USD',
      description: 'Автомобіль у відмінному стані. Весь у заводській фарбі, жоден елемент не фарбувався. Переднє крило фарбували минулого року. ДТП ніколи не було, хоча після невеликої аварії замінили бампер. Повністю обслужений, вкладень не потребує. Водночас чути стук у передній підвісці, ремонт поки не робив. Сервісної історії немає. VIN надам лише після завдатку.'
    },
    transparent: {
      name: 'Volvo S60 T5', year: '2018', mileage: '142000', price: '18 200 USD',
      description: 'Автомобіль 2018 року, пробіг 142 000 км. Другий власник, придбаний в Україні в 2021 році. ТО проводили кожні 10 000 км, є рахунки та акти за 2022–2026 роки. На 138 000 км замінено передні гальмівні диски та колодки, на 140 000 км — моторну оливу і фільтри. Після подряпини пофарбовано задні праві двері, фото до ремонту збережено. Інших кузовних робіт за моєю інформацією не було. Помилок на панелі немає, сторонніх шумів не помічаю. Готовий надати VIN та пройти незалежну перевірку на будь-якому СТО за рахунок покупця.'
    },
    vague: {
      name: 'Infiniti QX50', year: '2017', mileage: '185000', price: '15 900 USD',
      description: 'Терміново! Ідеальний автомобіль, кращого на ринку не знайдете. Стан як із салону, все супер, їде дуже добре, повністю без проблем. Усе зроблено для себе. Ніхто не пошкодує, хто перший приїде — забере. Реальному покупцю при зустрічі все розповім. Без зайвих питань, на повідомлення про VIN не відповідаю.'
    }
  };

  // Seven binary decisions, two score scales and one categorical choice.
  // Instructions intentionally focus on evidence in the PROVIDED AD, not actual vehicle condition.
  const QUESTIONS = {
    paint_conflict: {
      type: 'noul',
      instructions: 'Does the provided car advertisement DIRECTLY contradict itself about factory/original paint, repainting, or body paint repairs? Judge only the supplied wording, not assumptions about the actual car.'
    },
    maintenance_conflict: {
      type: 'noul',
      instructions: 'Does the description claim that the vehicle needs no investment/repairs or is mechanically flawless while also acknowledging an unresolved fault or a repair still needed? Answer about explicit contradictions only.'
    },
    accident_conflict: {
      type: 'noul',
      instructions: 'Are there directly incompatible claims about no accidents/no damage and an accident or damage repair in the same advertisement? Distinguish repainting for cosmetic reasons from an accident.'
    },
    mechanical_issue: {
      type: 'noul',
      instructions: 'Does the description explicitly mention an existing unresolved mechanical issue (such as knocking, oil leak, warning light, gearbox fault, or repair needed)? Do not infer hidden faults from the car make or mileage.'
    },
    vague_claims: {
      type: 'noul',
      instructions: 'Does the description rely heavily on subjective superlatives, sweeping promises, or non-verifiable claims in place of concrete evidence about condition and maintenance?'
    },
    service_gap: {
      type: 'noul',
      instructions: 'Is specific, verifiable maintenance or service history missing from the entire provided advertisement? Judge information completeness only. Missing data is not proof of poor maintenance.'
    },
    vin_gap: {
      type: 'noul',
      instructions: 'Is a VIN missing from all supplied information, or does the seller explicitly refuse or condition access to VIN? Answer yes when VIN has not been provided. This measures information completeness, not fraud.'
    },
    transparency: {
      type: 'score',
      instructions: 'Rate how transparent and factually specific this advertisement is, judging only the supplied information. Higher = more transparent. No claims about true vehicle condition.',
      criteria: [
        '0 — Opaque: evasive, mostly marketing language, critical details absent',
        '1 — Limited: some facts but major omissions and weak supporting details',
        '2 — Reasonably clear: useful details, a few omissions or uncertainties',
        '3 — Transparent: specific disclosures, history, and willingness to verify'
      ]
    },
    inspection_priority: {
      type: 'score',
      instructions: 'Based only on the claims and information gaps, how strongly should the buyer prioritize extra questions and an independent inspection BEFORE taking further steps? Higher = stronger priority. This is not a mechanical diagnosis.',
      criteria: [
        '0 — No additional text-based warning signals beyond normal used-car checks',
        '1 — Some missing information; ask routine clarifying questions',
        '2 — Multiple gaps or warning claims; detailed inspection advised',
        '3 — Explicit contradictions or unresolved faults; inspect and verify first'
      ]
    },
    overall: {
      type: 'choice',
      instructions: 'Classify the preliminary INFORMATION AND CONSISTENCY risk of this car advertisement only. Do not claim to know the actual technical condition of the car. Treat uncertainty explicitly.',
      criteria: {
        low: 'Mostly specific, internally consistent and transparent about condition and maintenance',
        medium: 'Noticeable ambiguities or missing information requiring clarification, without many serious direct contradictions',
        high: 'Clear contradictory statements, known unresolved issues, or major evasiveness in the supplied advertisement',
        insufficient_data: 'Not enough substantive information to reliably classify the advertisement'
      }
    }
  };

  const SIGNALS = [
    { id: 'paint_conflict', label: 'Суперечності щодо фарбування', note: 'Взаємовиключні твердження про заводське ЛФП та перефарбування.', ask: 'Які елементи кузова фарбувалися і чи є фото до ремонту?' },
    { id: 'maintenance_conflict', label: '«Без вкладень» vs наявні проблеми', note: 'Одночасні твердження про відсутність вкладень і невирішені ремонти.', ask: 'Які недоліки залишилися і скільки коштує їх усунення?' },
    { id: 'accident_conflict', label: 'Суперечності щодо ДТП', note: 'Несумісні твердження про ДТП, пошкодження або кузовний ремонт.', ask: 'Чи були ДТП та чи можна побачити історію кузовних ремонтів?' },
    { id: 'mechanical_issue', label: 'Згадані технічні несправності', note: 'Імовірність, що продавець сам зазначає невирішену несправність.', ask: 'Які технічні несправності залишаються зараз?' },
    { id: 'vague_claims', label: 'Розмиті рекламні формулювання', note: 'Наявність загальних обіцянок замість перевірюваних фактів.', ask: 'Якими документами можна підтвердити заявлений стан?' },
    { id: 'service_gap', label: 'Брак сервісної історії в описі', note: 'В описі немає конкретних даних про обслуговування.', ask: 'Чи є рахунки, акти та записи про ТО?' },
    { id: 'vin_gap', label: 'VIN відсутній у наданих даних', note: 'Перевірка наявності VIN у введених матеріалах, а не на сайті загалом.', ask: 'Чи можна отримати VIN перед оглядом?' }
  ];

  const SCORE_LEVELS = {
    transparency: [
      '0 — Майже немає конкретних фактів',
      '1 — Є загальні відомості, але багато прогалин',
      '2 — Опис переважно інформативний',
      '3 — Детальні відомості та можливість перевірки'
    ],
    inspection_priority: [
      '0 — Немає додаткових застережень у тексті',
      '1 — Потрібно уточнити окремі деталі',
      '2 — Потрібна ретельна додаткова перевірка',
      '3 — Спочатку з’ясувати суперечності або несправності'
    ]
  };

  const CHOICES = {
    low: { label: 'Низький', theme: 'low', description: 'У тексті переважають конкретні й узгоджені дані. Це не гарантія стану автомобіля.' },
    medium: { label: 'Помірний', theme: 'medium', description: 'Є неоднозначності або інформаційні прогалини — потрібні уточнення.' },
    high: { label: 'Підвищений', theme: 'high', description: 'Модель вбачає суперечності, невирішені проблеми або ухиляння від деталей.' },
    insufficient_data: { label: 'Недостатньо даних', theme: 'unknown', description: 'Опис не дає достатніх підстав для надійної попередньої класифікації.' }
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function formatPercent(value) { return Number.isFinite(value) ? `${Math.round(clamp(value, 0, 1) * 100)}%` : '—'; }
  function formatDecimal(value, digits = 2) { return Number.isFinite(value) ? value.toLocaleString('uk-UA', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'; }
  function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function probability(value) { const num = finiteNumber(value); return num === null ? null : clamp(num, 0, 1); }
  function sourceLabel() { return 'Jev API'; }
  function answerFrom(run, id) { return run?.response?.answers?.[id] || null; }
  function binaryValue(run, id) { return probability(answerFrom(run, id)?.noul); }
  function scoreValue(run, id) { return finiteNumber(answerFrom(run, id)?.score); }

  function getInputs() {
    return {
      name: $('car-name').value.trim(), year: $('car-year').value.trim(),
      mileage: $('car-mileage').value.trim(), price: $('car-price').value.trim(),
      description: $('car-description').value.trim()
    };
  }
  function buildPayload() {
    const info = getInputs();
    const vehicle = {};
    if (info.name) vehicle.make_and_model = info.name;
    if (info.year) vehicle.year = Number(info.year);
    if (info.mileage) vehicle.mileage_km = Number(info.mileage);
    if (info.price) vehicle.asking_price_as_listed = info.price;
    return {
      model: JEV_MODEL,
      state: {
        evaluation_scope: 'Evaluate ONLY the content and consistency of this used-car ad. Do not infer actual mechanical condition, fair price, accident history, or VIN history. Text may be in Ukrainian.',
        vehicle,
        description: info.description
      },
      questions: QUESTIONS
    };
  }
  function setError(message) {
    $('error-box').hidden = !message;
    $('error-message').textContent = message || '';
    if (message) $('error-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('visible');
    clearTimeout(appState.toastTimer);
    appState.toastTimer = setTimeout(() => el.classList.remove('visible'), 3300);
  }
  function setStatus(label, mode = '') {
    $('api-status').className = `status-indicator ${mode}`;
    $('api-status').innerHTML = `<span class="dot"></span>${escapeHtml(label)}`;
  }
  function setBusy(busy) {
    appState.busy = busy;
    $('analyze-button').disabled = busy;
    $('check-connection').disabled = busy;
    $('analyze-text').textContent = busy ? 'Аналіз триває…' : 'Аналізувати через Jev';
  }
  function updateCharCount() { $('char-count').textContent = `${$('car-description').value.length} / 6500`; }
  function markStale() {
    if (!appState.latest) return;
    $('result-status').className = 'result-status';
    $('result-status').textContent = 'Попередній текст';
    const label = $('result-context-notice');
    if (label) label.hidden = false;
  }
  function loadPreset(name) {
    const p = EXAMPLES[name];
    if (!p) return;
    $('car-name').value = p.name;
    $('car-year').value = p.year;
    $('car-mileage').value = p.mileage;
    $('car-price').value = p.price;
    $('car-description').value = p.description;
    document.querySelectorAll('[data-preset]').forEach((button) => button.classList.toggle('selected', button.dataset.preset === name));
    updateCharCount(); markStale(); setError('');
  }
  function switchView(name) {
    const viewNames = { analysis: 'Аналіз оголошення', compare: 'Порівняння A / B' };
    if (!(name in viewNames)) return;
    document.querySelectorAll('.view').forEach((el) => { el.classList.toggle('active', el.id === `view-${name}`); el.hidden = el.id !== `view-${name}`; });
    document.querySelectorAll('.nav-item').forEach((el) => {
      const active = el.dataset.view === name;
      el.classList.toggle('active', active);
      if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    // Навігація між аналізом і порівнянням.
    if (name === 'compare') renderComparison();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validateInputs() {
    const info = getInputs();
    if (info.description.length < MIN_DESCRIPTION_LENGTH) throw new Error(`Опишіть автомобіль хоча б ${MIN_DESCRIPTION_LENGTH} символами.`);
    if (info.year && (!Number.isInteger(Number(info.year)) || Number(info.year) < 1950 || Number(info.year) > 2030)) throw new Error('Перевірте рік випуску (1950–2030).');
    if (info.mileage && (!Number.isInteger(Number(info.mileage)) || Number(info.mileage) < 0 || Number(info.mileage) > 2500000)) throw new Error('Перевірте пробіг: потрібне невід’ємне ціле число.');
  }
  function validateAnswerShape(data) {
    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') throw new Error('Відповідь не містить об’єкта answers. Перевірте формат Jev API.');
    const missing = Object.keys(QUESTIONS).filter((id) => !data.answers[id]);
    if (missing.length) throw new Error(`У відповіді відсутні оцінки: ${missing.join(', ')}. Потрібна відповідь на всі 10 запитань.`);
    for (const [id, definition] of Object.entries(QUESTIONS)) {
      const answer = data.answers[id];
      if (definition.type === 'noul' && probability(answer?.noul) === null) throw new Error(`Поле answers.${id}.noul повинно бути числом від 0 до 1.`);
      if (definition.type === 'score' && finiteNumber(answer?.score) === null) throw new Error(`Поле answers.${id}.score повинно бути числом.`);
      if (definition.type === 'choice' && !CHOICES[answer?.choice]) throw new Error(`Поле answers.${id}.choice має невідомий варіант.`);
    }
    return data;
  }
  async function fetchWithTimeout(url, options, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  async function parseApiResponse(res) {
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { throw new Error(`Сервер повернув не JSON (HTTP ${res.status}).`); }
    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
      const human = {
        403: 'Доступ до Jev API заборонено.',
        401: 'Недійсний або відкликаний API-ключ.',
        402: 'Недостатньо кредитів чи токенів на балансі.',
        404: 'Не знайдено API endpoint.',
        422: 'API відхилив запит. Перевірте вхідні дані або формат запиту.',
        429: 'Перевищено ліміт запитів.',
        503: 'Модель тимчасово недоступна.'
      }[res.status] || 'Помилка Jev API.';
      throw new Error(`${human} ${String(detail).slice(0, 300)}`);
    }
    return parsed;
  }
  function showApiError(error) {
    const message = error?.name === 'AbortError'
      ? 'Час очікування сервера вичерпано.'
      : error instanceof TypeError
        ? 'Немає з’єднання з бекендом. Відкрийте проєкт через http://127.0.0.1:8787 після запуску python3 server.py.'
        : error.message;
    setError(message);
    setStatus('Помилка підключення', 'error');
  }
  function apiHeaders() {
    return { 'Content-Type': 'application/json', Accept: 'application/json' };
  }
  async function analyze(event) {
    event.preventDefault();
    if (appState.busy) return;
    setError('');
    try {
      validateInputs();
      const payload = buildPayload();
      setBusy(true);
      const started = performance.now();
      const res = await fetchWithTimeout(API_URL, {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify(payload)
      }, 60000);
      const result = validateAnswerShape(await parseApiResponse(res));
      addRun(result, payload, 'api', Math.round(performance.now() - started));
      setStatus('Підключено до Jev', 'ready');
      toast('Аналіз завершено.');
    } catch (error) { showApiError(error); }
    finally { setBusy(false); }
  }
  async function checkConnection() {
    setError(''); setBusy(true);
    try {
      const res = await fetchWithTimeout(MODELS_URL, { headers: apiHeaders() }, 18000);
      await parseApiResponse(res);
      setStatus('Підключено до Jev', 'ready');
      toast('Підключення працює.');
    } catch (error) { showApiError(error); }
    finally { setBusy(false); }
  }
  function addRun(response, request, source, elapsedMs = null) {
    const run = {
      id: `run_${Date.now()}_${appState.history.length}`,
      timestamp: new Date().toISOString(),
      source, elapsedMs,
      info: getInputs(), request, response
    };
    appState.history.push(run);
    if (appState.history.length > MAX_HISTORY) appState.history.shift();
    appState.latest = run;
    $('history-count').textContent = String(appState.history.length);
    $('result-status').textContent = 'Готово';
    $('result-status').className = 'result-status live';
    renderReport(run);
    renderComparison();
  }
  function signalTheme(value) {
    if (value === null) return 'low';
    if (value >= 0.7) return 'high';
    if (value >= 0.35) return 'medium';
    return 'low';
  }
  function renderReport(run) {
    const overall = answerFrom(run, 'overall');
    const classified = CHOICES[overall?.choice] || CHOICES.insufficient_data;
    const classificationProbability = probability(overall?.probabilities?.[overall?.choice]) ?? probability(overall?.confidence);
    const highSignals = SIGNALS.filter((signal) => (binaryValue(run, signal.id) ?? 0) >= 0.7);
    const mediumSignals = SIGNALS.filter((signal) => {
      const p = binaryValue(run, signal.id) ?? 0;
      return p >= 0.35 && p < 0.7;
    });
    const transparency = scoreValue(run, 'transparency');
    const priority = scoreValue(run, 'inspection_priority');
    const usage = run.response.usage || {};
    const validUsage = Number.isFinite(usage.input_tokens) ? usage.input_tokens.toLocaleString('uk-UA') : '—';
    const metadata = [
      `<span>Модель: <strong>${escapeHtml(run.response.model || run.request.model || 'невідома')}</strong></span>`,
      `<span>API: <strong>Jev</strong></span>`,
      `<span>Вхідні токени: <strong>${escapeHtml(validUsage)}</strong></span>`
    ];
    if (Number.isFinite(run.elapsedMs)) metadata.push(`<span>Час: <strong>${run.elapsedMs} мс</strong></span>`);
    const signalHtml = SIGNALS.map((signal) => {
      const p = binaryValue(run, signal.id);
      const theme = signalTheme(p);
      const percent = p === null ? 0 : Math.round(p * 100);
      return `<div class="risk-item"><div class="risk-item-head"><div class="risk-item-title">${escapeHtml(signal.label)}</div><strong class="risk-item-number ${theme}">${formatPercent(p)}</strong></div><div class="probability-track" role="progressbar" aria-label="${escapeHtml(signal.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="probability-fill ${theme}" style="width:${percent}%"></div></div><p class="risk-item-note">${escapeHtml(signal.note)}</p></div>`;
    }).join('');
    const scoreTile = (id, name, direction) => {
      const score = scoreValue(run, id);
      const normalized = score === null ? 0 : clamp(score / 3, 0, 1);
      const confidence = probability(answerFrom(run, id)?.confidence);
      const scale = SCORE_LEVELS[id].map((level) => `<li>${escapeHtml(level)}</li>`).join('');
      return `<div class="score-tile"><p class="score-tile-title">${escapeHtml(name)}</p><div class="score-value">${formatDecimal(score)} <small>/ 3</small></div><div class="score-track"><span style="width:${Math.round(normalized * 100)}%"></span></div><p class="score-legend">${escapeHtml(direction)}</p><ul class="score-levels">${scale}</ul>${confidence === null ? '' : `<p class="score-confidence">Впевненість Jev в оцінці: ${formatPercent(confidence)}</p>`}</div>`;
    };
    const probabilityChoices = overall?.probabilities && typeof overall.probabilities === 'object' ? overall.probabilities : {};
    const choiceRows = Object.entries(CHOICES).map(([key, value]) => {
      const p = probability(probabilityChoices[key]);
      const percent = p === null ? 0 : Math.round(p * 100);
      return `<div class="choice-row ${overall?.choice === key ? 'selected' : ''}"><span>${escapeHtml(value.label)}</span><div class="choice-bar"><span style="width:${percent}%"></span></div><strong>${formatPercent(p)}</strong></div>`;
    }).join('');
    const questions = highSignals.map((signal) => signal.ask);
    if (questions.length === 0) questions.push('Чи можна отримати VIN, сервісну історію та пройти незалежну діагностику?');
    if (questions.length > 5) questions.length = 5;
    $('result-content').innerHTML = `
      <p id="result-context-notice" class="results-notice" hidden><strong>Увага:</strong> текст у формі змінено. Ці оцінки стосуються попередньої версії оголошення.</p>
      <div class="result-overview">
        <div class="result-overview-top"><div><div class="risk-title">РІВЕНЬ РИЗИКУ ЗА ТЕКСТОМ ОГОЛОШЕННЯ</div><div class="risk-label ${classified.theme}">${escapeHtml(classified.label)}</div><p class="risk-microcopy">${escapeHtml(classified.description)}</p></div><div class="risk-visual" style="background:conic-gradient(#4b83ec ${Math.round((classificationProbability ?? 0) * 100)}%,#e3eafa 0)"><span>${formatPercent(classificationProbability)}</span></div></div>
        <div class="model-meta">${metadata.join('')}</div>
        <div class="model-source">Відсоток показує впевненість Jev у класифікації тексту, а не ймовірність несправності автомобіля.</div>
      </div>
      <div class="metric-stats"><div class="metric-stat"><small>Ознак з імовірністю ≥70%</small><strong>${highSignals.length}</strong></div><div class="metric-stat"><small>Ознак з імовірністю 35–69%</small><strong>${mediumSignals.length}</strong></div><div class="metric-stat"><small>Усього критеріїв</small><strong>${Object.keys(QUESTIONS).length}</strong></div></div>
      <h3 class="results-subheading">Ознаки та прогалини в описі <small>Noul · імовірність «Так»</small></h3>
      <div class="risk-list">${signalHtml}</div>
      <h3 class="results-subheading">Оцінки характеристик опису <small>Score · шкала 0–3</small></h3>
      <div class="score-grid">${scoreTile('transparency', 'Прозорість опису', 'Більше = докладніший і конкретніший опис')}${scoreTile('inspection_priority', 'Потреба в додатковій перевірці', 'Більше = більше підстав перевіряти твердження продавця')}</div>
      <div class="choice-breakdown"><h3 class="results-subheading">Ймовірності рівнів ризику за описом оголошення <small>choice</small></h3>${choiceRows}</div>
      <div class="suggestion-box"><h4>Уточнення для продавця</h4><ul>${questions.map((question) => `<li>${escapeHtml(question)}</li>`).join('')}</ul></div>
      <p class="results-notice">Результати ґрунтуються лише на тексті оголошення та не є технічною діагностикою автомобіля.</p>
    `;
  }

  function displayDate(date) {
    const dt = new Date(date);
    return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function runOptions(selectedId) {
    return [...appState.history].reverse().map((run, index) => {
      const label = `${displayDate(run.timestamp)} · ${run.info.name || 'Автомобіль'} · ${sourceLabel(run)}`;
      return `<option value="${escapeHtml(run.id)}" ${run.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }
  function comparisonSummary(run, label) {
    const category = CHOICES[answerFrom(run, 'overall')?.choice] || CHOICES.insufficient_data;
    const p = probability(answerFrom(run, 'overall')?.probabilities?.[answerFrom(run, 'overall')?.choice]);
    return `<section class="card"><div class="compare-tag">АНАЛІЗ ${label}</div><h3>${escapeHtml(run.info.name || 'Автомобіль')}</h3><p>${displayDate(run.timestamp)} · ${escapeHtml(run.response.model || run.request.model)}</p><div class="compare-risk-label ${category.theme}">${escapeHtml(category.label)} ${p === null ? '' : `· ${formatPercent(p)}`}</div><p>${escapeHtml(run.info.description.slice(0, 195))}${run.info.description.length > 195 ? '…' : ''}</p></section>`;
  }
  function renderComparison(selectedA = null, selectedB = null) {
    const container = $('comparison-content');
    if (appState.history.length < 2) {
      container.innerHTML = `<div class="card compare-placeholder"><div class="compare-empty-icon"><svg class="icon"><use href="#i-compare"/></svg></div><h2>Потрібно щонайменше два аналізи</h2><p>Проаналізуйте оголошення, змініть формулювання та запустіть Jev ще раз. Історія зберігається тільки до закриття вкладки.</p><button type="button" class="btn btn-primary" data-view="analysis">Перейти до аналізу <svg class="icon icon-sm"><use href="#i-arrow"/></svg></button></div>`;
      return;
    }
    const older = appState.history[appState.history.length - 2];
    const newer = appState.history[appState.history.length - 1];
    const a = appState.history.find((run) => run.id === selectedA) || older;
    const b = appState.history.find((run) => run.id === selectedB) || newer;
    const metrics = [
      ...SIGNALS.map((signal) => ({ id: signal.id, title: signal.label, type: 'noul', highIsConcern: true })),
      { id: 'transparency', title: 'Прозорість опису', type: 'score', highIsConcern: false },
      { id: 'inspection_priority', title: 'Потреба в додатковій перевірці', type: 'score', highIsConcern: true }
    ];
    const rows = metrics.map((metric) => {
      const x = metric.type === 'score' ? scoreValue(a, metric.id) : binaryValue(a, metric.id);
      const y = metric.type === 'score' ? scoreValue(b, metric.id) : binaryValue(b, metric.id);
      const difference = x !== null && y !== null ? y - x : null;
      const direction = difference === null || Math.abs(difference) < 0.005 ? 'flat' : ((difference > 0) === metric.highIsConcern ? 'up' : 'down');
      const number = (n) => metric.type === 'score' ? formatDecimal(n) : formatPercent(n);
      const delta = difference === null ? '—' : (metric.type === 'score' ? `${difference >= 0 ? '+' : ''}${formatDecimal(difference)}` : `${difference >= 0 ? '+' : ''}${Math.round(difference * 100)} п.п.`);
      return `<tr><td>${escapeHtml(metric.title)}</td><td>${number(x)}</td><td>${number(y)}</td><td class="compare-delta ${direction}">${delta}</td></tr>`;
    }).join('');
    container.innerHTML = `<div class="compare-controls"><label class="form-field"><span>Варіант A — вихідний</span><select id="comparison-select-a">${runOptions(a.id)}</select></label><label class="form-field"><span>Варіант B — змінений</span><select id="comparison-select-b">${runOptions(b.id)}</select></label></div><div class="compare-summary">${comparisonSummary(a, 'A')}${comparisonSummary(b, 'B')}</div><section class="card compare-report"><h2>Зміна результатів моделі</h2><p>Червоний колір — зростання ймовірності небажаної ознаки, зелений — зниження. Для прозорості зростання оцінки є позитивним.</p><table class="compare-table"><thead><tr><th>Показник</th><th>A</th><th>B</th><th>Зміна B − A</th></tr></thead><tbody>${rows}</tbody></table><p class="comparison-hint">п.п. — процентні пункти. Числа взято з двох відповідей Jev. Для точнішого порівняння змінюйте по одному реченню.</p></section>`;
    $('comparison-select-a').addEventListener('change', () => renderComparison($('comparison-select-a').value, $('comparison-select-b').value));
    $('comparison-select-b').addEventListener('change', () => renderComparison($('comparison-select-a').value, $('comparison-select-b').value));
  }

  function init() {
    // Event delegation also handles navigation buttons rendered later in A/B placeholder.
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button) return;
      event.preventDefault();
      switchView(button.dataset.view);
    });
    document.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => loadPreset(button.dataset.preset)));
    document.querySelectorAll('#analysis-form input,#analysis-form textarea').forEach((el) => el.addEventListener('input', () => {
      document.querySelectorAll('[data-preset]').forEach((button) => button.classList.remove('selected'));
      updateCharCount(); markStale();
    }));
    $('analysis-form').addEventListener('submit', analyze);
    $('check-connection').addEventListener('click', checkConnection);
    loadPreset('contradictory');
    if (location.hash === '#compare') switchView('compare');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
