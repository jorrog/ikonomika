// Будна България — игрова логика и интерфейс.
// Цялото състояние на играта е в обекта S; всяко действие минава през act(), което
// пази предишното състояние (за „Назад“), записва играта и прерисува екрана.
(function () {
  'use strict';

  const SAVE_KEY = 'budna.game.v1';
  const SETUP_KEY = 'budna.setup.v1';
  const USED_KEY = 'budna.used.v1';
  const CLAIM_VALUE = 200;     // точки за област, завладяна във фаза 1
  const CONQUER_BONUS = 100;   // с толкова расте стойността на превзета във фаза 2 област
  const LETTERS = ['А', 'Б', 'В', 'Г'];
  const LEVELS = { 1: 'Лесно', 2: 'Средно', 3: 'Трудно' };
  const PALETTE = ['#c62828', '#1e56b8', '#2e7d32', '#e67700', '#6a3fb5', '#00838f', '#a07900', '#c2185b'];
  const DEFAULT_SETUP = {
    teamCount: 3,
    teams: [
      { name: 'Паисиевци', color: '#c62828' },
      { name: 'Левскари', color: '#1e56b8' },
      { name: 'Ботевци', color: '#2e7d32' },
      { name: 'Вазовци', color: '#e67700' }
    ],
    // phase1: брой въпроси на отбор във фаза 1; 0 = максимумът (области ÷ отбори)
    settings: { levels: [1, 2, 3], timer: 30, rounds: 3, phase1: 0, showOptions: true, adjacency: false, avoidRepeats: true, sound: true }
  };

  const MAP = window.BG_MAP;
  const MERGED = MAP.merged || [];
  const PROV = {};
  MAP.provinces.concat(MERGED).forEach(p => { PROV[p.id] = p; });

  // При 3 отбора София-град и София-област са една област: 27 области = 3 × 9.
  function regionsFor(teamCount) {
    const ids = MAP.provinces.map(p => p.id);
    if (teamCount !== 3) return ids;
    const parts = new Set(MERGED.flatMap(m => m.parts));
    return ids.filter(id => !parts.has(id)).concat(MERGED.map(m => m.id));
  }
  const perTeamMax = teamCount => Math.floor(regionsFor(teamCount).length / teamCount);
  const NS = 'http://www.w3.org/2000/svg';

  let bank = null;
  let bankById = {};
  let numericById = {};
  let S = null;
  let undoStack = [];
  let setup = loadSetup();
  let uiModal = null;          // меню, правила и др. — извън състоянието на играта
  let finalHidden = false;     // учителят разглежда картата след края
  let animatedClaim = null;
  let confettiDone = false;
  const timer = { id: null, token: null, left: 0, last: 0, paused: false, lastSecond: null };

  // ---------- Помощни ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rand = n => Math.floor(Math.random() * n);
  const plural = (n, one, many) => (n === 1 ? one : many);
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function readJSON(key, fallback) {
    try {
      const t = localStorage.getItem(key);
      return t ? JSON.parse(t) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* пълно хранилище */ }
  }
  function loadSetup() {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETUP));
    const saved = readJSON(SETUP_KEY, null);
    if (!saved) return s;
    if ([2, 3, 4].includes(saved.teamCount)) s.teamCount = saved.teamCount;
    (saved.teams || []).forEach((t, i) => {
      if (!s.teams[i] || !t) return;
      if (typeof t.name === 'string') s.teams[i].name = t.name;
      if (PALETTE.includes(t.color)) s.teams[i].color = t.color;
    });
    Object.assign(s.settings, saved.settings || {});
    if (!Array.isArray(s.settings.levels)) s.settings.levels = [1, 2, 3];
    return s;
  }
  const saveSetup = () => writeJSON(SETUP_KEY, setup);
  const save = () => { if (S) writeJSON(SAVE_KEY, S); };
  const loadUsed = () => new Set(readJSON(USED_KEY, []));
  const saveUsed = set => writeJSON(USED_KEY, Array.from(set));

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- Справки за състоянието ----------
  const tn = i => S.teams[i].name;
  const tc = i => S.teams[i].color;
  const score = i => S.regions.reduce((sum, id) => sum + (S.owner[id] === i ? S.value[id] : 0), 0);
  const countOf = i => S.regions.filter(id => S.owner[id] === i).length;
  const freeIds = () => S.regions.filter(id => S.owner[id] === null);
  const phase1Round = () => Math.min(S.perTeam, Math.min(...S.asked) + 1);

  // Съседите в текущата игра — с обединените области на мястото на частите им.
  function neighborsOf(id) {
    const alias = {};
    MERGED.forEach(m => {
      if (S.regions.includes(m.id)) m.parts.forEach(part => { alias[part] = m.id; });
    });
    return [...new Set(PROV[id].neighbors.map(n => alias[n] || n))].filter(n => n !== id);
  }

  function currentTeam() {
    if (!S) return null;
    if (S.phase === 'conquest') return S.turn;
    if (S.phase === 'challenge' && S.orderPos < S.order.length) return S.order[S.orderPos];
    return null;
  }
  // При правилото „само съседни“: ако отборът няма съседна подходяща област, може да избира всяка.
  function nearOwn(ids, team) {
    if (!S.settings.adjacency) return ids;
    const near = ids.filter(id => neighborsOf(id).some(n => S.owner[n] === team));
    return near.length ? near : ids;
  }
  const claimTargets = team => nearOwn(freeIds(), team);
  // Във фаза 2 може да се атакува и останала свободна област.
  const attackTargets = team => nearOwn(S.regions.filter(id => S.owner[id] !== team), team);
  function selectable() {
    if (!S) return [];
    if (S.step === 'pick') return claimTargets(S.turn);
    if (S.step === 'attack') return attackTargets(currentTeam());
    return [];
  }
  function ranking() {
    return S.teams.map((_, i) => i).sort((a, b) =>
      score(b) - score(a) || (b === S.winner) - (a === S.winner) || countOf(b) - countOf(a) || a - b);
  }
  function addLog(text, team = null) {
    S.log.push({ text, team });
    if (S.log.length > 80) S.log.shift();
  }

  // ---------- Действия ----------
  function act(fn) {
    undoStack.push(JSON.stringify(S));
    if (undoStack.length > 80) undoStack.shift();
    fn();
    save();
    render();
  }

  function undo() {
    if (!S || !undoStack.length || $('#game').hidden) return;
    S = JSON.parse(undoStack.pop());
    finalHidden = false;
    animatedClaim = S.lastClaim ? S.lastClaim.t : null;
    if (S.step !== 'final') confettiDone = false;
    save();
    render();
    toast('Последното действие е отменено.');
  }

  function startGame() {
    if (!bank) { toast('Първо заредете въпросите.'); return; }
    const st = setup.settings;
    if (!st.levels.length) { toast('Изберете поне едно ниво на въпросите.'); return; }
    const teams = setup.teams.slice(0, setup.teamCount)
      .map((t, i) => ({ name: t.name.trim() || `Отбор ${i + 1}`, color: t.color }));
    const max = perTeamMax(teams.length);
    S = {
      v: 2,
      settings: JSON.parse(JSON.stringify(st)),
      teams,
      stats: teams.map(() => ({ correct: 0, wrong: 0, conquered: 0 })),
      regions: regionsFor(teams.length),
      perTeam: st.phase1 > 0 ? Math.min(st.phase1, max) : max,
      asked: teams.map(() => 0),
      owner: {},
      value: {},
      phase: 'conquest',
      step: 'turn',
      turn: 0,
      round: 0,
      order: [],
      orderPos: 0,
      q: null,
      target: null,
      tb: null,
      winner: null,
      used: [],
      usedNumeric: [],
      log: [],
      lastClaim: null,
      finished: false
    };
    S.regions.forEach(id => { S.owner[id] = null; S.value[id] = 0; });
    addLog(`Играта започва! Фаза 1: Завладяване — по ${S.perTeam} въпроса на отбор.`);
    undoStack = [];
    finalHidden = false;
    confettiDone = false;
    animatedClaim = null;
    Sound.enabled = S.settings.sound;
    save();
    showScreen('game');
  }

  function resumeGame() {
    const saved = readJSON(SAVE_KEY, null);
    if (!saved || !bank) return;
    S = saved;
    if (!S.regions) {
      // игра, запазена от версия без ограничение на въпросите във фаза 1
      S.regions = MAP.provinces.map(p => p.id);
      S.asked = S.stats.map(st => st.correct + st.wrong);
      S.perTeam = Math.max(Math.ceil(S.regions.length / S.teams.length), ...S.asked);
    }
    undoStack = [];
    finalHidden = false;
    confettiDone = S.finished;
    animatedClaim = S.lastClaim ? S.lastClaim.t : null;
    // ако междувременно е зареден друг файл с въпроси
    if (S.q && !bankById[S.q.id]) drawQuestion();
    if (S.tb && !numericById[S.tb.id]) newTiebreak(S.tb.teams);
    Sound.enabled = S.settings.sound;
    showScreen('game');
  }

  function newGame() {
    S = null;
    undoStack = [];
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* няма значение */ }
    showScreen('setup');
  }

  function drawQuestion() {
    const levels = S.settings.levels;
    const inGame = new Set(S.used);
    const globalUsed = S.settings.avoidRepeats ? loadUsed() : new Set();
    const fresh = q => levels.includes(q.level) && !inGame.has(q.id);
    let pool = bank.questions.filter(q => fresh(q) && !globalUsed.has(q.id));
    if (!pool.length && S.settings.avoidRepeats) {
      // всички въпроси от избраните нива вече са задавани в минали игри — започва нов цикъл
      bank.questions.forEach(q => { if (levels.includes(q.level)) globalUsed.delete(q.id); });
      pool = bank.questions.filter(fresh);
    }
    if (!pool.length) pool = bank.questions.filter(q => !inGame.has(q.id));
    if (!pool.length) {
      toast('Всички въпроси са използвани — започваме отначало.');
      S.used = [];
      pool = bank.questions.slice();
    }
    const q = pool[rand(pool.length)];
    S.used.push(q.id);
    if (S.settings.avoidRepeats) {
      globalUsed.add(q.id);
      saveUsed(globalUsed);
    }
    const options = shuffle([q.correct, ...q.wrong]);
    S.q = {
      id: q.id,
      options,
      correct: options.indexOf(q.correct),
      chosen: null,
      result: null,
      shown: false,
      token: Date.now().toString(36) + rand(1e6)
    };
  }

  function showQuestion() {
    act(() => { drawQuestion(); S.step = 'question'; });
  }

  function chooseAnswer(i) {
    if (!S || S.step !== 'question' || !S.q || S.q.result || i >= S.q.options.length) return;
    act(() => {
      S.q.chosen = i;
      resolve(i === S.q.correct ? 'correct' : 'wrong');
    });
  }

  function timeUp() {
    if (!S || S.step !== 'question' || S.q.result) return;
    act(() => resolve('timeout'));
  }

  function resolve(result) {
    const t = currentTeam();
    S.q.result = result;
    S.q.shown = true;
    if (result === 'correct') S.stats[t].correct++;
    else S.stats[t].wrong++;
    if (S.phase === 'conquest') S.asked[t]++;
    S.step = 'reveal';
    Sound.play(result === 'correct' ? 'correct' : result === 'timeout' ? 'timeout' : 'wrong');
  }

  function continueAfterReveal() {
    act(() => {
      const ok = S.q.result === 'correct';
      const t = currentTeam();
      S.q = null;
      if (S.phase === 'conquest') {
        if (ok) {
          S.step = 'pick';
        } else {
          addLog(`${tn(t)} не позна и пропуска хода.`, t);
          endConquestTurn();
        }
        return;
      }
      const id = S.target;
      const def = S.owner[id];
      if (ok) {
        S.owner[id] = t;
        S.value[id] = def === null ? CLAIM_VALUE : S.value[id] + CONQUER_BONUS;
        S.stats[t].conquered++;
        S.lastClaim = { id, t: Date.now() };
        addLog(def === null ? `${tn(t)} завладя свободната област ${PROV[id].name}.`
          : `${tn(t)} превзе ${PROV[id].name} от ${tn(def)}!`, t);
        Sound.play('claim');
      } else if (def === null) {
        addLog(`${tn(t)} не успя да завладее ${PROV[id].name}.`, t);
      } else {
        addLog(`${tn(def)} удържа ${PROV[id].name}.`, def);
      }
      S.target = null;
      S.orderPos++;
      nextAttack();
    });
  }

  function claim(id) {
    act(() => {
      const t = S.turn;
      S.owner[id] = t;
      S.value[id] = CLAIM_VALUE;
      S.lastClaim = { id, t: Date.now() };
      addLog(`${tn(t)} завладя ${PROV[id].name}.`, t);
      Sound.play('claim');
      endConquestTurn();
    });
  }

  // Фаза 1 свършва, когато всеки отбор е отговорил на своите въпроси (или картата се запълни).
  const phase1Over = () => !freeIds().length || S.asked.every(n => n >= S.perTeam);

  function endConquestTurn() {
    if (!phase1Over()) { nextTurn(); return; }
    const free = freeIds().length;
    S.phase = 'challenge';
    S.step = 'phase2';
    addLog(free ? `Фаза 1 приключи. Свободни остават ${free} ${plural(free, 'област', 'области')}.`
      : 'Всички области са завладени! Започват предизвикателствата.');
  }

  function nextTurn() {
    S.turn = (S.turn + 1) % S.teams.length;
    S.step = 'turn';
  }

  // Първи атакува отборът с най-малко точки.
  function roundOrder() {
    return S.teams.map((_, i) => i).sort((a, b) => score(a) - score(b) || a - b);
  }

  function beginRound() {
    S.round++;
    S.order = roundOrder();
    S.orderPos = 0;
    S.step = 'round';
    addLog(`Рунд ${S.round} от ${S.settings.rounds}.`);
  }

  function nextAttack() {
    while (S.orderPos < S.order.length && !attackTargets(S.order[S.orderPos]).length) {
      addLog(`${tn(S.order[S.orderPos])} няма кого да атакува.`, S.order[S.orderPos]);
      S.orderPos++;
    }
    if (S.orderPos < S.order.length) S.step = 'attack';
    else if (S.round < S.settings.rounds) beginRound();
    else endGame();
  }

  function selectTarget(id) {
    act(() => {
      S.target = id;
      drawQuestion();
      S.step = 'question';
    });
  }

  function endGame() {
    const scores = S.teams.map((_, i) => score(i));
    const best = Math.max(...scores);
    const tied = scores.map((s, i) => (s === best ? i : -1)).filter(i => i >= 0);
    if (tied.length > 1 && bank.numeric.length) {
      S.phase = 'tiebreak';
      S.step = 'tiebreak';
      newTiebreak(tied);
      addLog('Равенство за първото място! Следва въпрос с число.');
    } else {
      finish(tied.length === 1 ? tied[0] : null);
    }
  }

  function newTiebreak(teams) {
    const used = new Set(S.usedNumeric);
    let pool = bank.numeric.filter(q => !used.has(q.id));
    if (!pool.length) {
      S.usedNumeric = [];
      pool = bank.numeric.slice();
    }
    const q = pool[rand(pool.length)];
    S.usedNumeric.push(q.id);
    S.tb = { teams, id: q.id, answers: null, winners: null };
  }

  function revealTiebreak() {
    const values = {};
    for (const t of S.tb.teams) {
      const raw = $(`#tb-${t}`).value.trim().replace(',', '.');
      if (raw === '' || isNaN(Number(raw))) {
        toast('Въведете отговорите на всички отбори.');
        $(`#tb-${t}`).focus();
        return;
      }
      values[t] = Number(raw);
    }
    act(() => {
      const answer = numericById[S.tb.id].answer;
      const diffs = S.tb.teams.map(t => Math.abs(values[t] - answer));
      const min = Math.min(...diffs);
      S.tb.answers = values;
      S.tb.winners = S.tb.teams.filter((t, k) => diffs[k] === min);
      Sound.play(S.tb.winners.length === 1 ? 'correct' : 'wrong');
    });
  }

  function finish(winner) {
    S.phase = 'final';
    S.step = 'final';
    S.winner = winner;
    S.finished = true;
    addLog(winner === null ? 'Играта завърши наравно!' : `Победител: ${tn(winner)}!`, winner);
    Sound.play('fanfare');
  }

  // ---------- Карта ----------
  function splitName(name) {
    if (name.includes('-')) {
      const [a, b] = name.split('-');
      return [a + '-', b];
    }
    return name.includes(' ') ? name.split(' ') : [name];
  }

  function buildMap() {
    const svg = $('#map');
    svg.setAttribute('viewBox', `-8 -8 ${MAP.width + 16} ${MAP.height + 16}`);
    const gP = document.createElementNS(NS, 'g');
    gP.setAttribute('class', 'provinces');
    const gL = document.createElementNS(NS, 'g');
    gL.setAttribute('class', 'labels');
    const gFx = document.createElementNS(NS, 'g');
    gFx.setAttribute('id', 'fx');
    MAP.provinces.concat(MERGED).forEach(p => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('class', 'prov');
      path.dataset.id = p.id;
      path.addEventListener('click', () => onProvince(p.id));
      path.addEventListener('mousemove', e => showTip(p.id, e));
      path.addEventListener('mouseleave', hideTip);
      gP.appendChild(path);

      const fs = Math.max(10, Math.min(17, p.r * 0.36));
      const lh = fs * 1.05;
      const lines = splitName(p.name);
      const top = p.label[1] - (lines.length * lh) / 2;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'plabel');
      g.dataset.id = p.id;
      lines.forEach((line, k) => {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', p.label[0]);
        t.setAttribute('y', (top + k * lh).toFixed(1));
        t.setAttribute('font-size', fs.toFixed(1));
        t.textContent = line;
        g.appendChild(t);
      });
      const v = document.createElementNS(NS, 'text');
      v.setAttribute('class', 'pvalue');
      v.setAttribute('x', p.label[0]);
      v.setAttribute('y', (top + lines.length * lh + fs * 0.1).toFixed(1));
      v.setAttribute('font-size', (fs * 1.1).toFixed(1));
      g.appendChild(v);
      gL.appendChild(g);
    });
    svg.append(gP, gL, gFx);
  }

  function renderMap() {
    const sel = new Set(selectable());
    const picking = S.step === 'pick' || S.step === 'attack';
    const cur = currentTeam();
    $('#map').style.setProperty('--sel', cur !== null ? tc(cur) : '#2a1c0e');
    const active = new Set(S.regions);
    $$('#map .prov, #map .plabel').forEach(node => {
      node.style.display = active.has(node.dataset.id) ? '' : 'none';
    });
    $$('#map .prov').forEach(path => {
      const id = path.dataset.id;
      if (!active.has(id)) return;
      const o = S.owner[id];
      path.style.fill = o === null ? '' : tc(o);
      path.classList.toggle('owned', o !== null);
      path.classList.toggle('can', picking && sel.has(id));
      path.classList.toggle('dim', picking && !sel.has(id));
      const isTarget = S.phase === 'challenge' && S.target === id;
      path.classList.toggle('target', isTarget);
      if (isTarget) path.parentNode.appendChild(path); // контурът да не се скрива под съседите
    });
    $$('#map .plabel').forEach(g => {
      const id = g.dataset.id;
      if (!active.has(id)) return;
      const o = S.owner[id];
      g.classList.toggle('owned', o !== null);
      g.classList.toggle('dim', picking && !sel.has(id));
      g.querySelector('.pvalue').textContent = o === null ? '' : S.value[id];
    });
    if (S.lastClaim && S.lastClaim.t !== animatedClaim) {
      animatedClaim = S.lastClaim.t;
      const p = PROV[S.lastClaim.id];
      const o = S.owner[p.id];
      if (o !== null && Date.now() - S.lastClaim.t < 3000) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', p.label[0]);
        c.setAttribute('cy', p.label[1]);
        c.setAttribute('r', 80);
        c.setAttribute('class', 'ripple');
        c.style.stroke = tc(o);
        $('#fx').appendChild(c);
        setTimeout(() => c.remove(), 1300);
      }
    }
  }

  function onProvince(id) {
    if (!S || uiModal || !(S.step === 'pick' || S.step === 'attack')) return;
    if (!selectable().includes(id)) {
      const o = S.owner[id];
      if (S.step === 'pick') toast(o !== null ? 'Тази област вече е заета.' : 'Изберете област, съседна на вашите.');
      else toast(o === currentTeam() ? 'Това е ваша област — изберете чужда или свободна.' : 'Изберете област, съседна на вашите.');
      return;
    }
    hideTip();
    if (S.step === 'pick') claim(id);
    else selectTarget(id);
  }

  function showTip(id, e) {
    if (!S) return;
    const tip = $('#tooltip');
    const box = $('.map-wrap').getBoundingClientRect();
    const o = S.owner[id];
    tip.innerHTML = `<b>${esc(PROV[id].name)}</b> · ` +
      (o === null ? 'свободна' : `${esc(tn(o))} · ${S.value[id]} т.`);
    tip.hidden = false;
    const x = Math.min(e.clientX - box.left + 16, box.width - tip.offsetWidth - 6);
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = (e.clientY - box.top + 16) + 'px';
  }
  function hideTip() { $('#tooltip').hidden = true; }

  // ---------- Рисуване ----------
  function render() {
    if (!S || $('#game').hidden) { renderModal(); return; }
    renderMap();
    renderSide();
    renderTopbar();
    renderAction();
    renderModal();
    syncTimer();
    if (S.step === 'final' && !confettiDone) {
      confettiDone = true;
      confetti(S.winner !== null ? [tc(S.winner), '#b8892b', '#ffffff', '#ffd54a'] : S.teams.map(t => t.color));
    }
  }

  function renderTopbar() {
    let label = 'Край на играта';
    if (S.phase === 'conquest') label = 'Фаза 1 · Завладяване';
    else if (S.phase === 'challenge') label = `Фаза 2 · Рунд ${Math.max(1, S.round)} / ${S.settings.rounds}`;
    else if (S.phase === 'tiebreak') label = 'Въпрос за равенство';
    $('#phasePill').textContent = label;
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnSound').textContent = S.settings.sound ? '🔊' : '🔇';
  }

  function renderSide() {
    const cur = currentTeam();
    $('#teamsBoard').innerHTML = S.teams.map((t, i) => {
      const n = countOf(i);
      return `<div class="tcard${i === cur ? ' active' : ''}" style="--team:${t.color}">
        <div class="tname">${esc(t.name)}${i === cur ? '<span class="turn-tag">на ход</span>' : ''}</div>
        <div class="tscore">${score(i)} <small>точки</small></div>
        <div class="tmeta">${n} ${plural(n, 'област', 'области')} · ✓ ${S.stats[i].correct} верни · ✗ ${S.stats[i].wrong}` +
        `${S.phase === 'conquest' ? ` · въпроси ${S.asked[i]}/${S.perTeam}` : ''}</div>
      </div>`;
    }).join('');

    const total = S.regions.length;
    let html;
    if (S.phase === 'conquest') {
      html = `Въпрос ${phase1Round()} от ${S.perTeam} за всеки отбор<br>` +
        `Завладени области: ${total - freeIds().length} / ${total}<div class="bar">` +
        S.teams.map((t, i) => `<i style="width:${(countOf(i) / total) * 100}%;background:${t.color}"></i>`).join('') + '</div>';
    } else if (S.phase === 'challenge') {
      html = `Рунд ${Math.max(1, S.round)} от ${S.settings.rounds}`;
      if (S.order.length) {
        html += '<div class="order">' + S.order.map((t, k) =>
          `<span style="--team:${tc(t)}" class="${k < S.orderPos ? 'done' : k === S.orderPos ? 'now' : ''}">${esc(tn(t))}</span>`).join('') + '</div>';
      }
    } else {
      html = 'Играта приключи';
    }
    html += `<div class="tmeta" style="margin-top:.3rem">Зададени въпроси: ${S.used.length}</div>`;
    $('#progress').innerHTML = html;

    $('#log').innerHTML = S.log.slice().reverse().map(l =>
      `<li><span class="dot" style="--team:${l.team !== null && S.teams[l.team] ? tc(l.team) : 'var(--gold)'}"></span><span>${esc(l.text)}</span></li>`).join('');
  }

  const who = (i, text) =>
    `<span class="who"><span class="dot" style="--team:${tc(i)}"></span>${esc(tn(i))} <span style="font-weight:700">${text}</span></span>`;

  function renderAction() {
    const bar = $('#actionBar');
    const cur = currentTeam();
    bar.style.setProperty('--team', cur !== null ? tc(cur) : 'var(--gold)');
    const adj = S.settings.adjacency;
    let html;
    switch (S.step) {
      case 'turn':
        html = who(cur, 'е на ход') +
          `<span class="hint">Въпрос ${S.asked[cur] + 1} от ${S.perTeam} · верен отговор = нова област</span>` +
          '<button type="button" class="btn primary" data-primary data-act="show">Покажи въпроса ▶</button>';
        break;
      case 'pick':
        html = who(cur, 'избира област') +
          `<span class="hint">${adj ? 'Кликнете свободна област до вашите' : 'Кликнете върху свободна (бежова) област'}</span>`;
        break;
      case 'attack':
        html = who(cur, 'атакува!') +
          `<span class="hint">Изберете чужда${freeIds().length ? ' или свободна' : ''} област${adj ? ', съседна на вашите' : ''}</span>`;
        break;
      case 'final':
        html = '<span class="who">🏆 Играта приключи</span>' +
          '<button type="button" class="btn primary" data-primary data-act="results">Класиране</button>';
        break;
      default:
        html = cur !== null ? who(cur, 'отговаря…') : '<span class="who">⚔ Предизвикателства</span>';
    }
    bar.innerHTML = html;
  }

  function renderModal() {
    const modal = $('#modal');
    const card = $('#modalCard');
    let view = null;
    if (uiModal) view = uiModal();
    else if (S && !$('#game').hidden) view = stepView();
    if (!view) {
      modal.hidden = true;
      card.innerHTML = '';
      return;
    }
    const cur = S && !uiModal ? currentTeam() : null;
    card.className = 'modal-card' + (view.narrow ? ' narrow' : '');
    card.style.setProperty('--team', view.team || (cur !== null ? tc(cur) : 'var(--accent)'));
    card.innerHTML = view.html;
    modal.hidden = false;
  }

  function stepView() {
    switch (S.step) {
      case 'question': return { html: questionHTML() };
      case 'reveal': return { html: revealHTML() };
      case 'phase2': return { html: phase2HTML() };
      case 'round': return { html: roundHTML() };
      case 'tiebreak': return { html: tiebreakHTML(), team: 'var(--gold)' };
      case 'final': return finalHidden ? null : { html: finalHTML(), team: S.winner !== null ? tc(S.winner) : 'var(--gold)' };
      default: return null;
    }
  }

  function headHTML(q, t) {
    let html = `<span class="q-team">${esc(tn(t))}</span>`;
    if (S.phase === 'challenge' && S.target) {
      const d = S.owner[S.target];
      html += d === null
        ? `<span class="q-meta">за свободната област ${esc(PROV[S.target].name)}</span>`
        : `<span class="q-vs">⚔</span><span class="q-team" style="--team:${tc(d)}">${esc(tn(d))}</span>` +
          `<span class="q-meta">за ${esc(PROV[S.target].name)}</span>`;
    }
    html += `<span class="q-meta">· ${esc(q.category)}</span><span class="lvl lvl-${q.level}">${LEVELS[q.level]}</span>`;
    let bar = '';
    if (S.settings.timer > 0 && !S.q.shown) {
      const left = timer.token === S.q.token ? timer.left : S.settings.timer;
      html += `<button type="button" class="timer" data-act="pause" title="Пауза / продължи">${Math.ceil(left)}</button>`;
      bar = `<div class="timerbar"><i style="width:${(left / S.settings.timer) * 100}%"></i></div>`;
    }
    return `<div class="q-head">${html}</div>${bar}`;
  }

  function optionsHTML(revealed) {
    return '<div class="options">' + S.q.options.map((o, i) => {
      let cls = '';
      if (revealed) cls = i === S.q.correct ? 'right' : i === S.q.chosen ? 'bad' : 'faded';
      return `<button type="button" class="opt ${cls}" ${revealed ? 'disabled' : `data-act="answer" data-i="${i}"`}>` +
        `<b>${LETTERS[i]}</b><span>${esc(o)}</span></button>`;
    }).join('') + '</div>';
  }

  function questionHTML() {
    const q = bankById[S.q.id];
    let body = '';
    let foot;
    const swap = '<button type="button" class="btn ghost" data-act="swap" title="Ако въпросът не е подходящ">⟳ Друг въпрос</button>';
    if (S.settings.showOptions) {
      body = optionsHTML(false);
      foot = swap + '<span class="spacer"></span><span class="kbd-hint">Кликнете отговора на отбора или натиснете <kbd>1</kbd>–<kbd>4</kbd></span>';
    } else if (!S.q.shown) {
      foot = swap + '<span class="spacer"></span><span class="kbd-hint">Отборът отговаря на глас</span>' +
        '<button type="button" class="btn primary" data-primary data-act="reveal">Покажи отговора</button>';
    } else {
      body = `<div class="answer-box"><small>Верен отговор</small>${esc(q.correct)}</div>`;
      foot = '<span class="spacer"></span><span class="verdict">Отговорът на отбора е…</span>' +
        '<button type="button" class="btn bad" data-act="judge" data-ok="0">✗ Грешен</button>' +
        '<button type="button" class="btn ok" data-act="judge" data-ok="1">✓ Верен</button>';
    }
    return headHTML(q, currentTeam()) + `<h2 class="q-text">${esc(q.question)}</h2>${body}<div class="q-foot">${foot}</div>`;
  }

  function revealHTML() {
    const q = bankById[S.q.id];
    const t = currentTeam();
    const r = S.q.result;
    const title = r === 'correct' ? '<span class="big-icon">🎉</span> Вярно!'
      : r === 'timeout' ? '<span class="big-icon">⏰</span> Времето изтече!'
        : '<span class="big-icon">✗</span> Грешен отговор';
    let verdict;
    let btn;
    if (S.phase === 'conquest') {
      const last = S.asked.every(n => n >= S.perTeam);
      if (r === 'correct') {
        verdict = `${esc(tn(t))} избира свободна област на картата (+${CLAIM_VALUE} т.).`;
        btn = 'Избери област ▶';
      } else {
        verdict = last ? 'Това беше последният въпрос от фаза 1.'
          : `Ходът минава към ${esc(tn((S.turn + 1) % S.teams.length))}.`;
        btn = last ? 'Към предизвикателствата ▶' : 'Следващият отбор ▶';
      }
    } else {
      const name = esc(PROV[S.target].name);
      const d = S.owner[S.target];
      if (d === null) {
        verdict = r === 'correct' ? `${esc(tn(t))} завладява ${name} (+${CLAIM_VALUE} т.).` : `${name} остава свободна.`;
        btn = r === 'correct' ? `Завладей ${name} ▶` : 'Продължи ▶';
      } else {
        verdict = r === 'correct'
          ? `${esc(tn(t))} превзема ${name}, а стойността ѝ става ${S.value[S.target] + CONQUER_BONUS} т.`
          : `${esc(tn(d))} удържа ${name}.`;
        btn = r === 'correct' ? `Превземи ${name} ▶` : 'Продължи ▶';
      }
    }
    const body = S.settings.showOptions ? optionsHTML(true)
      : `<div class="answer-box"><small>Верен отговор</small>${esc(q.correct)}</div>`;
    const info = q.info ? `<div class="info"><b>Знаете ли, че…</b> ${esc(q.info)}</div>` : '';
    return headHTML(q, t) +
      `<div class="result ${r}">${title}</div><p class="verdict">${verdict}</p>` +
      `<h2 class="q-text small">${esc(q.question)}</h2>${body}${info}` +
      `<div class="q-foot"><span class="spacer"></span><button type="button" class="btn primary" data-primary data-act="continue">${btn}</button></div>`;
  }

  function standingsHTML() {
    return '<div class="standings">' + ranking().map(t =>
      `<div class="row" style="--team:${tc(t)}"><span class="dot"></span>${esc(tn(t))}` +
      `<span class="tmeta">${countOf(t)} ${plural(countOf(t), 'област', 'области')}</span><span class="pts">${score(t)} т.</span></div>`).join('') + '</div>';
  }

  function orderHTML(order) {
    return '<div class="order-big">' + order.map((t, k) =>
      `${k ? '<span>→</span>' : ''}<span class="t" style="--team:${tc(t)}">${esc(tn(t))}</span>`).join('') + '</div>';
  }

  function phase2HTML() {
    const n = S.settings.rounds;
    const free = freeIds().length;
    const head = free
      ? `Фаза 1 приключи. Свободни остават ${free} ${plural(free, 'област', 'области')}.`
      : `Всички ${S.regions.length} области са завладени!`;
    return `<h2>⚔ Фаза 2: Предизвикателства</h2>
      <p class="verdict">${head} Следват ${n} ${plural(n, 'рунд', 'рунда')}.</p>
      <ul class="intro-list">
        <li>Във всеки рунд всеки отбор атакува по веднъж.</li>
        <li>Атакуващият избира чужда${free ? ' или свободна' : ''} област и отговаря на въпрос.</li>
        <li><b>Верен отговор</b> — чуждата област става негова и стойността ѝ расте с ${CONQUER_BONUS} точки.</li>
        ${free ? `<li><b>Свободна област</b> — при верен отговор става негова (${CLAIM_VALUE} т.).</li>` : ''}
        <li><b>Грешен отговор</b> — областта остава у защитника.</li>
      </ul>
      ${standingsHTML()}
      <p class="verdict">Ред на атаките в рунд 1 (първи е отборът с най-малко точки):</p>
      ${orderHTML(roundOrder())}
      <div class="q-foot"><span class="spacer"></span><button type="button" class="btn primary" data-primary data-act="begin-rounds">Започни рунд 1 ▶</button></div>`;
  }

  function roundHTML() {
    return `<h2>Рунд ${S.round} от ${S.settings.rounds}</h2>
      ${standingsHTML()}
      <p class="verdict">Ред на атаките (първи е отборът с най-малко точки):</p>
      ${orderHTML(S.order)}
      <div class="q-foot"><span class="spacer"></span><button type="button" class="btn primary" data-primary data-act="start-round">Започни рунда ▶</button></div>`;
  }

  function tiebreakHTML() {
    const q = numericById[S.tb.id];
    const shown = !!S.tb.answers;
    const single = shown && S.tb.winners.length === 1;
    const teams = S.tb.teams.map(t => {
      const v = shown ? S.tb.answers[t] : '';
      const win = single && S.tb.winners[0] === t;
      return `<div class="tb-team${win ? ' win' : ''}" style="--team:${tc(t)}">
        <label for="tb-${t}">${win ? '🏆 ' : ''}${esc(tn(t))}</label>
        <input id="tb-${t}" type="number" inputmode="decimal" placeholder="Отговор" value="${shown ? v : ''}" ${shown ? 'disabled' : ''}>
        ${shown ? `<div class="diff">разлика: ${Math.abs(v - q.answer)}</div>` : ''}
      </div>`;
    }).join('');
    let foot;
    if (!shown) {
      foot = '<span class="kbd-hint">Всеки отбор пише числото на лист; после учителят ги въвежда.</span><span class="spacer"></span>' +
        '<button type="button" class="btn primary" data-act="tb-reveal">Покажи отговора</button>';
    } else if (single) {
      foot = '<span class="spacer"></span><button type="button" class="btn primary" data-primary data-act="tb-finish">Към класирането ▶</button>';
    } else {
      foot = '<span class="verdict">Отново равенство!</span><span class="spacer"></span>' +
        '<button type="button" class="btn primary" data-primary data-act="tb-next">Нов въпрос ▶</button>';
    }
    const answer = shown
      ? `<div class="answer-box"><small>Верен отговор</small>${q.answer}${q.unit ? ' ' + esc(q.unit) : ''}</div>` +
        (q.info ? `<div class="info"><b>Знаете ли, че…</b> ${esc(q.info)}</div>` : '')
      : '';
    return `<h2>⚖ Равенство за първото място!</h2>
      <p class="verdict">Печели отборът, чийто отговор е най-близо до верния.</p>
      <h2 class="q-text">${esc(q.question)}</h2>${answer}
      <div class="tb-grid">${teams}</div>
      <div class="q-foot">${foot}</div>`;
  }

  function finalHTML() {
    const rank = ranking();
    const places = [];
    rank.forEach((t, k) => {
      const tiedWithPrev = k > 0 && score(t) === score(rank[k - 1]) && rank[k - 1] !== S.winner;
      places.push(tiedWithPrev ? places[k - 1] : k + 1);
    });
    const w = S.winner;
    const title = w === null
      ? '<div class="crown">🤝</div><h2>Равенство!</h2><p class="verdict">Няколко отбора делят първото място.</p>'
      : `<div class="crown">👑</div><h2>${esc(tn(w))} печели!</h2>`;
    const maxScore = Math.max(1, ...rank.map(score));
    const podium = [1, 0, 2, 3].filter(k => k < rank.length).map(k => {
      const t = rank[k];
      const h = 4 + (10 * score(t)) / maxScore + (k === 0 ? 1.5 : 0);
      return `<div class="col" style="--team:${tc(t)}"><div class="name">${esc(tn(t))}</div>` +
        `<div class="block" style="height:${h.toFixed(1)}rem;animation-delay:${k * 0.15}s">${places[k]}<small>${score(t)} т.</small></div></div>`;
    }).join('');
    const rows = rank.map((t, k) => `<tr><td>${places[k]}.</td>
      <td><span class="dot" style="--team:${tc(t)}"></span> ${esc(tn(t))}</td>
      <td class="num">${score(t)}</td><td class="num">${countOf(t)}</td>
      <td class="num">${S.stats[t].correct}</td><td class="num">${S.stats[t].conquered}</td></tr>`).join('');
    return `<div class="final-title">${title}</div>
      <div class="podium">${podium}</div>
      <table class="results-table">
        <thead><tr><th></th><th>Отбор</th><th class="num">Точки</th><th class="num">Области</th><th class="num">Верни отговори</th><th class="num">Превзети във фаза 2</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="q-foot"><button type="button" class="btn ghost" data-act="view-map">Виж картата</button><span class="spacer"></span>
        <button type="button" class="btn primary" data-primary data-act="new-game">Нова игра</button></div>`;
  }

  // ---------- Модални прозорци извън играта ----------
  function openUi(fn) { uiModal = fn; renderModal(); }
  function closeUi() { uiModal = null; renderModal(); if (S) syncTimer(); }

  const menuModal = () => ({
    narrow: true,
    html: `<h2>Меню</h2><div class="menu-list">
      <button type="button" class="btn secondary" data-primary data-act="close-ui">▶ Продължи играта</button>
      <button type="button" class="btn secondary" data-act="rules">📜 Правила</button>
      <button type="button" class="btn secondary" data-act="fullscreen">⛶ Цял екран</button>
      <button type="button" class="btn secondary" data-act="to-setup">⚙ Към началния екран (играта остава запазена)</button>
      <button type="button" class="btn bad" data-act="confirm-new">✚ Нова игра</button>
    </div>`
  });

  const confirmModal = () => ({
    narrow: true,
    html: `<h2>Нова игра?</h2><p class="verdict">Текущата игра ще бъде изтрита.</p>
      <div class="q-foot"><button type="button" class="btn ghost" data-act="close-ui">Отказ</button><span class="spacer"></span>
      <button type="button" class="btn bad" data-act="do-new">Да, започни нова</button></div>`
  });

  const confirmStartModal = () => ({
    narrow: true,
    html: `<h2>Има запазена игра</h2><p class="verdict">Ако започнете нова, недовършената игра ще бъде изтрита.</p>
      <div class="q-foot"><button type="button" class="btn ghost" data-act="close-ui">Отказ</button><span class="spacer"></span>
      <button type="button" class="btn bad" data-act="do-start">Започни нова игра</button></div>`
  });

  const rulesModal = () => ({
    narrow: true,
    html: `<h2>📜 Правила на играта</h2><div class="rules">
      <p>Учителят води играта на проектор или интерактивна дъска. Въпросът се показва на екрана, отборът отговаря на глас,
      а учителят кликва отговора, който отборът е казал (или натиска <kbd>1</kbd>–<kbd>4</kbd>).</p>
      <h3>Фаза 1 — Завладяване</h3>
      <ul><li>Отборите се редуват и всеки получава равен брой въпроси: при 2 отбора по 14, при 3 — по 9, при 4 — по 7
        (в настройките може и по-малко).</li>
        <li>При 3 отбора София-град и София-област са една област, за да има 27 = 3 × 9 области.</li>
        <li>Верен отговор → отборът избира свободна област (${CLAIM_VALUE} т.).</li>
        <li>Грешен отговор или изтекло време → ходът минава към следващия отбор.</li>
        <li>Областите, които останат свободни, могат да се завладеят във фаза 2.</li></ul>
      <h3>Фаза 2 — Предизвикателства</h3>
      <ul><li>Във всеки рунд (по подразбиране 3) всеки отбор атакува по веднъж; първи е отборът с най-малко точки.</li>
        <li>Атакуващият избира чужда или свободна област и отговаря на въпрос.</li>
        <li>Верен отговор → областта става негова; чуждата расте по стойност с ${CONQUER_BONUS} т., свободната струва ${CLAIM_VALUE} т.</li>
        <li>Грешен отговор → областта остава у защитника (или свободна).</li></ul>
      <h3>Край</h3>
      <ul><li>Печели отборът с най-много точки (сборът от стойностите на областите му).</li>
        <li>При равенство за първото място — въпрос с число: отборите пишат отговора си на лист, печели най-близкият.</li></ul>
      <h3>Полезно</h3>
      <ul><li><b>↶ Назад</b> (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) отменя последното действие — например грешно кликнат отговор.</li>
        <li><b>⟳ Друг въпрос</b> сменя неподходящ въпрос; кликване върху таймера го поставя на пауза.</li>
        <li><kbd>Enter</kbd> натиска главния бутон, <kbd>F</kbd> включва цял екран.</li>
        <li>Играта се записва автоматично и може да продължи и след затваряне на браузъра.</li>
        <li>В една игра въпрос не се повтаря.</li></ul>
    </div>
    <div class="q-foot"><span class="spacer"></span><button type="button" class="btn primary" data-primary data-act="close-ui">Разбрах</button></div>`
  });

  // ---------- Таймер ----------
  function syncTimer() {
    const need = S && S.step === 'question' && S.q && !S.q.shown && S.settings.timer > 0 && !$('#game').hidden;
    if (!need) { stopTimer(); return; }
    if (timer.token !== S.q.token) {
      stopTimer();
      timer.token = S.q.token;
      timer.left = S.settings.timer;
      timer.paused = false;
      timer.lastSecond = null;
      timer.last = performance.now();
      timer.id = setInterval(tickTimer, 100);
    }
    paintTimer();
  }
  function stopTimer() {
    if (timer.id) clearInterval(timer.id);
    timer.id = null;
    timer.token = null;
  }
  function tickTimer() {
    const now = performance.now();
    const dt = (now - timer.last) / 1000;
    timer.last = now;
    if (timer.paused || uiModal || document.hidden) return;
    timer.left = Math.max(0, timer.left - dt);
    const sec = Math.ceil(timer.left);
    if (sec !== timer.lastSecond) {
      timer.lastSecond = sec;
      if (sec > 0 && sec <= 5) Sound.play('tick');
    }
    paintTimer();
    if (timer.left <= 0) {
      stopTimer();
      timeUp();
    }
  }
  function paintTimer() {
    const btn = $('#modalCard .timer');
    if (!btn) return;
    const sec = Math.ceil(timer.left);
    const low = sec <= 5 && !timer.paused;
    btn.textContent = timer.paused ? '⏸ ' + sec : sec;
    btn.classList.toggle('low', low);
    btn.classList.toggle('paused', timer.paused);
    const bar = $('#modalCard .timerbar');
    if (bar) {
      bar.classList.toggle('low', low);
      bar.firstElementChild.style.width = (timer.left / S.settings.timer) * 100 + '%';
    }
  }

  // ---------- Конфети ----------
  function confetti(colors) {
    const cv = $('#confetti');
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = innerWidth;
    const H = innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const parts = Array.from({ length: 200 }, () => ({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.6,
      vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3,
      s: 7 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      c: colors[rand(colors.length)]
    }));
    const end = performance.now() + 5500;
    (function frame(now) {
      ctx.clearRect(0, 0, W, H);
      if (now > end) return;
      parts.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.02; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      requestAnimationFrame(frame);
    })(performance.now());
  }

  // ---------- Начален екран ----------
  function fixColors() {
    const active = setup.teams.slice(0, setup.teamCount);
    active.forEach((t, i) => {
      if (active.slice(0, i).some(o => o.color === t.color)) {
        t.color = PALETTE.find(c => !active.some(o => o.color === c));
      }
    });
  }

  function renderSetup() {
    const wrap = $('#teamsSetup');
    wrap.innerHTML = '';
    const active = setup.teams.slice(0, setup.teamCount);
    active.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'team-setup';
      card.style.setProperty('--team', t.color);
      card.innerHTML = `<span class="team-num">${i + 1}</span>
        <input type="text" maxlength="24" value="${esc(t.name)}" aria-label="Име на отбор ${i + 1}">
        <div class="swatches">${PALETTE.map(c => {
          const taken = c !== t.color && active.some(o => o.color === c);
          return `<button type="button" class="swatch${c === t.color ? ' on' : ''}" style="--c:${c}" data-color="${c}" ${taken ? 'disabled' : ''} aria-label="Цвят ${c}"></button>`;
        }).join('')}</div>`;
      card.querySelector('input').addEventListener('input', e => { t.name = e.target.value; saveSetup(); });
      card.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
        t.color = b.dataset.color;
        saveSetup();
        renderSetup();
      }));
      wrap.appendChild(card);
    });
    renderPhase1Options();
    renderBankStatus();
    updateResume();
  }

  function renderPhase1Options() {
    const teams = setup.teamCount;
    const regions = regionsFor(teams).length;
    const max = perTeamMax(teams);
    const cur = setup.settings.phase1 > 0 && setup.settings.phase1 < max ? setup.settings.phase1 : 0;
    let html = `<option value="0">${max} (цялата карта)</option>`;
    for (let n = max - 1; n >= 3; n--) html += `<option value="${n}">${n}</option>`;
    $('#optPhase1').innerHTML = html;
    $('#optPhase1').value = String(cur);
    $('#phase1Hint').textContent = `${regions} области за ${teams} отбора` +
      (regions < MAP.provinces.length ? ' (София-град и София-област са една област)' : '') +
      '. При по-малко въпроси част от картата остава свободна за фаза 2.';
  }

  function bindSetting(sel, key, kind) {
    const input = $(sel);
    if (kind === 'check') input.checked = !!setup.settings[key];
    else input.value = String(setup.settings[key]);
    input.addEventListener('change', () => {
      setup.settings[key] = kind === 'check' ? input.checked : Number(input.value);
      if (key === 'sound') Sound.enabled = input.checked;
      saveSetup();
      renderBankStatus();
    });
  }

  function renderBankStatus() {
    const el = $('#bankStatus');
    if (!bank) { el.textContent = ''; return; }
    const by = l => bank.questions.filter(q => q.level === l).length;
    const levels = setup.settings.levels;
    const selected = bank.questions.filter(q => levels.includes(q.level));
    let text = `Заредени въпроси: ${bank.questions.length} (лесни ${by(1)} · средни ${by(2)} · трудни ${by(3)}) и ${bank.numeric.length} с число.`;
    if (setup.settings.avoidRepeats) {
      const used = loadUsed();
      text += ` От избраните нива незадавани досега: ${selected.filter(q => !used.has(q.id)).length} от ${selected.length}.`;
    } else {
      text += ` От избраните нива: ${selected.length}.`;
    }
    const teams = setup.teamCount;
    const max = perTeamMax(teams);
    const per = setup.settings.phase1 > 0 ? Math.min(setup.settings.phase1, max) : max;
    text += ` Една игра: ${per * teams + setup.settings.rounds * teams} въпроса` +
      ` (${per * teams} във фаза 1 и ${setup.settings.rounds * teams} в предизвикателствата).`;
    el.textContent = text;
    el.classList.remove('err');
  }

  function updateResume() {
    const saved = readJSON(SAVE_KEY, null);
    const btn = $('#btnResume');
    if (!saved || saved.finished || !Array.isArray(saved.teams) || !bank) { btn.hidden = true; return; }
    const owned = Object.values(saved.owner || {}).filter(o => o !== null).length;
    const total = (saved.regions || MAP.provinces).length;
    const where = saved.phase === 'conquest' ? `фаза 1, ${owned}/${total} области` : saved.phase === 'challenge' ? `фаза 2, рунд ${Math.max(1, saved.round)}` : 'финал';
    btn.textContent = `Продължи запазената игра (${where})`;
    btn.hidden = false;
  }

  function setBank(b, note) {
    bank = b;
    bankById = {};
    numericById = {};
    b.questions.forEach(q => { bankById[q.id] = q; });
    b.numeric.forEach(q => { numericById[q.id] = q; });
    $('#loader').hidden = true;
    renderBankStatus();
    updateResume();
    if (note) toast(note);
  }

  function showLoader(message) {
    $('#loader').hidden = false;
    const el = $('#bankStatus');
    el.textContent = message || '';
    el.classList.toggle('err', !!message);
  }

  function loadFromFile(file) {
    if (!file) return;
    QuestionBank.loadFile(file)
      .then(b => setBank(b, `Заредени са ${b.questions.length} въпроса от „${file.name}“.`))
      .catch(err => showLoader('Файлът не може да бъде прочетен: ' + err.message));
  }

  function showScreen(name) {
    $('#setup').hidden = name !== 'setup';
    $('#game').hidden = name !== 'game';
    if (name === 'setup') {
      stopTimer();
      renderSetup();
      renderModal();
    } else {
      render();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  // ---------- Събития ----------
  function onAction(btn) {
    switch (btn.dataset.act) {
      case 'show': showQuestion(); break;
      case 'answer': chooseAnswer(Number(btn.dataset.i)); break;
      case 'swap': act(() => drawQuestion()); break;
      case 'reveal': act(() => { S.q.shown = true; }); break;
      case 'judge': act(() => resolve(btn.dataset.ok === '1' ? 'correct' : 'wrong')); break;
      case 'pause': timer.paused = !timer.paused; paintTimer(); break;
      case 'continue': continueAfterReveal(); break;
      case 'begin-rounds': act(() => { beginRound(); nextAttack(); }); break;
      case 'start-round': act(() => nextAttack()); break;
      case 'tb-reveal': revealTiebreak(); break;
      case 'tb-next': act(() => newTiebreak(S.tb.winners)); break;
      case 'tb-finish':
        act(() => {
          const w = S.tb.winners[0];
          addLog(`${tn(w)} печели въпроса с число!`, w);
          finish(w);
        });
        break;
      case 'view-map': finalHidden = true; render(); break;
      case 'results': finalHidden = false; render(); break;
      case 'new-game': newGame(); break;
      case 'close-ui': closeUi(); break;
      case 'rules': openUi(rulesModal); break;
      case 'fullscreen': closeUi(); toggleFullscreen(); break;
      case 'to-setup': closeUi(); showScreen('setup'); break;
      case 'confirm-new': openUi(confirmModal); break;
      case 'do-new': uiModal = null; newGame(); break;
      case 'do-start': uiModal = null; startGame(); break;
    }
  }

  function bindEvents() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn && !btn.disabled) onAction(btn);
    });
    $('#modal').addEventListener('click', e => {
      if (e.target.id === 'modal' && uiModal) closeUi();
    });

    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === 'Escape' && uiModal) { closeUi(); return; }
      if (e.target.matches('input, select, textarea')) {
        if (e.key === 'Enter' && e.target.closest('.tb-team')) $('[data-act="tb-reveal"]')?.click();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!uiModal && S && !$('#game').hidden && S.step === 'question' && S.settings.showOptions) {
        const keys = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3, 'а': 0, 'б': 1, 'в': 2, 'г': 3 };
        if (k in keys) { chooseAnswer(keys[k]); return; }
      }
      if (k === 'enter' || k === ' ') {
        if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
        const btn = $('#modal:not([hidden]) [data-primary]') || (!$('#game').hidden && $('#actionBar [data-primary]'));
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
      if (k === 'f' || k === 'ф') toggleFullscreen();
    });

    $('#btnStart').addEventListener('click', () => {
      if ($('#btnResume').hidden) startGame();
      else openUi(confirmStartModal);
    });
    $('#btnResume').addEventListener('click', resumeGame);
    $('#btnRules').addEventListener('click', () => openUi(rulesModal));
    $('#btnUndo').addEventListener('click', undo);
    $('#btnMenu').addEventListener('click', () => openUi(menuModal));
    $('#btnFull').addEventListener('click', toggleFullscreen);
    $('#btnSound').addEventListener('click', () => {
      S.settings.sound = !S.settings.sound;
      setup.settings.sound = S.settings.sound;
      Sound.enabled = S.settings.sound;
      $('#optSound').checked = S.settings.sound;
      saveSetup();
      save();
      renderTopbar();
    });
    $('#btnResetUsed').addEventListener('click', e => {
      e.preventDefault();
      saveUsed(new Set());
      renderBankStatus();
      toast('Историята на зададените въпроси е изчистена.');
    });

    const fileInput = $('#fileInput');
    $('#btnPickFile').addEventListener('click', () => fileInput.click());
    $('#btnLoadOther').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { loadFromFile(fileInput.files[0]); fileInput.value = ''; });
    const setupScreen = $('#setup');
    setupScreen.addEventListener('dragover', e => { e.preventDefault(); $('#loader').classList.add('drag'); });
    setupScreen.addEventListener('dragleave', () => $('#loader').classList.remove('drag'));
    setupScreen.addEventListener('drop', e => {
      e.preventDefault();
      $('#loader').classList.remove('drag');
      loadFromFile(e.dataTransfer.files[0]);
    });

    $('#teamCount').value = String(setup.teamCount);
    $('#teamCount').addEventListener('change', e => {
      setup.teamCount = Number(e.target.value);
      fixColors();
      saveSetup();
      renderSetup();
    });
    $$('#levelChips input').forEach(cb => {
      cb.checked = setup.settings.levels.includes(Number(cb.value));
      cb.addEventListener('change', () => {
        setup.settings.levels = $$('#levelChips input').filter(c => c.checked).map(c => Number(c.value));
        saveSetup();
        renderBankStatus();
      });
    });
    bindSetting('#optTimer', 'timer');
    bindSetting('#optRounds', 'rounds');
    bindSetting('#optPhase1', 'phase1');
    bindSetting('#optOptions', 'showOptions', 'check');
    bindSetting('#optAdjacency', 'adjacency', 'check');
    bindSetting('#optRepeats', 'avoidRepeats', 'check');
    bindSetting('#optSound', 'sound', 'check');
  }

  async function init() {
    Sound.enabled = setup.settings.sound;
    buildMap();
    bindEvents();
    fixColors();
    renderSetup();
    try {
      setBank(await QuestionBank.loadDefault());
    } catch (err) {
      const cached = QuestionBank.cached();
      if (cached) {
        setBank(cached);
        $('#bankStatus').textContent += ' (запомнени от последното зареждане на файла)';
      } else {
        showLoader();
      }
    }
  }

  init();
})();
