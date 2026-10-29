// Зареждане и проверка на въпросите от data/questions.json.
window.QuestionBank = (function () {
  'use strict';
  const CACHE_KEY = 'budna.questions.v1';
  const DEFAULT_URL = 'data/questions.json';

  function validate(data) {
    if (!data || !Array.isArray(data.questions)) throw new Error('Във файла липсва списък „questions“.');
    const questions = [];
    const numeric = [];
    const seen = new Set();
    data.questions.forEach((q, i) => {
      const ok = q && q.id != null && typeof q.question === 'string' && typeof q.correct === 'string'
        && Array.isArray(q.wrong) && q.wrong.length >= 1 && !q.wrong.includes(q.correct);
      const id = 'q' + (q && q.id);
      if (!ok || seen.has(id)) {
        console.warn('Пропуснат невалиден въпрос №' + (i + 1), q);
        return;
      }
      seen.add(id);
      questions.push({
        id,
        level: [1, 2, 3].includes(q.level) ? q.level : 2,
        category: q.category || '',
        question: q.question,
        correct: q.correct,
        wrong: q.wrong.slice(0, 3).map(String),
        info: q.info || ''
      });
    });
    (Array.isArray(data.numeric) ? data.numeric : []).forEach((q, i) => {
      if (!q || q.id == null || typeof q.question !== 'string' || typeof q.answer !== 'number') {
        console.warn('Пропуснат невалиден въпрос с число №' + (i + 1), q);
        return;
      }
      numeric.push({ id: 'n' + q.id, question: q.question, answer: q.answer, unit: q.unit || '', info: q.info || '' });
    });
    if (!questions.length) throw new Error('Във файла няма нито един валиден въпрос.');
    return { title: data.title || '', questions, numeric };
  }

  function fromText(text) {
    return validate(JSON.parse(text));
  }

  function remember(text) {
    try { localStorage.setItem(CACHE_KEY, text); } catch (e) { /* няма място — не е критично */ }
  }

  function cached() {
    try {
      const text = localStorage.getItem(CACHE_KEY);
      return text ? fromText(text) : null;
    } catch (e) {
      return null;
    }
  }

  // Опитва data/questions.json (работи през уеб сървър); при file:// браузърът обикновено го блокира.
  async function loadDefault() {
    const res = await fetch(DEFAULT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const bank = fromText(text);
    remember(text);
    return bank;
  }

  function loadFile(file) {
    return file.text().then(text => {
      const bank = fromText(text);
      remember(text);
      return bank;
    });
  }

  return { loadDefault, loadFile, cached };
})();
