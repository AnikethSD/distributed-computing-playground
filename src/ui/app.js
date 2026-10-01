/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
/* Distributed Compute Playground — UI, drag & drop and game state.
 * Everything is local: no network calls. State persists in localStorage. */
(function () {
  const D = window.DCP;
  const STORE = 'dcp-playground-v1';
  const SLOT_BY_ID = Object.fromEntries(D.SLOTS.map((s) => [s.id, s]));
  const DIM_NAME = Object.fromEntries(D.DIMS.map((d) => [d.id, d.n]));
  const LVL_LABEL = { danger: 'Danger', error: 'Error', warn: 'Warning', info: 'Note', tip: 'Tip' };
  const FAM_LABEL = { spark: 'Apache Spark', any: 'Any engine' };

  // ── tiny DOM helper (textContent only, never innerHTML with data) ──
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  const $ = (id) => document.getElementById(id);
  const emptySlots = () => Object.fromEntries(D.SLOTS.map((s) => [s.id, []]));
  const colorVar = (slot) => `--c:${slot.color}`;
  const names = (ids) => ids.map((id) => (D.byId[id] ? D.byId[id].n : id));

  // ── state ──
  const defaults = {
    base: 'spark', slots: emptySlots(), mission: 'maya', theme: null, learn: true,
    unlocked: [], completed: [], usedBases: [], mistakes: 0, workload: null,
    openGroup: 'engine', tab: 'overview',
    hints: {}, stars: {}, qShown: {},
  };
  let st;
  try { st = Object.assign({}, defaults, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { st = { ...defaults }; }
  if (!D.PRESETS[st.base]) st.base = 'spark';
  st.slots = Object.assign(emptySlots(), st.slots);
  // drop unknown ids (e.g. after catalogue changes)
  Object.keys(st.slots).forEach((k) => { st.slots[k] = st.slots[k].filter((id) => D.byId[id] && D.byId[id].b === st.base); });
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch { /* private mode */ } };

  let lastAdded = null;
  let dragging = null; // { id, from: 'palette' | 'slot' }
  let result = null;

  // ── theme ──
  function applyTheme() {
    const theme = st.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    $('themeBtn').textContent = theme === 'dark' ? '☀' : '☾';
  }
  $('themeBtn').addEventListener('click', () => {
    st.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); save();
  });

  // ── toasts ──
  function toast(text, kind) {
    const t = h('div', { class: 'toast ' + (kind || ''), text });
    $('toasts').append(t);
    setTimeout(() => t.remove(), 2800);
  }

  // ── actions ──
  function place(id, targetSlot) {
    const c = D.byId[id];
    if (!c || c.b !== st.base) return;
    const slot = SLOT_BY_ID[c.slot];
    if (targetSlot && targetSlot !== c.slot) {
      st.mistakes += 1;
      const el = document.querySelector(`.slot[data-slot="${targetSlot}"]`);
      if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 450); }
      toast(`${c.n} belongs in L${slot.layer} · ${slot.n}`, 'bad');
      update();
      return;
    }
    const list = st.slots[c.slot];
    if (list.includes(id)) { toast(`${c.n} is already in your job`); return; }
    if (!slot.multi && list.length) {
      toast(`Swapped ${D.byId[list[0]].n} → ${c.n}`);
      st.slots[c.slot] = [id];
    } else list.push(id);
    if (c.slot === 'engine' && !st.usedBases.includes(st.base)) st.usedBases.push(st.base);
    lastAdded = id;
    update();
  }
  function remove(id) {
    Object.keys(st.slots).forEach((k) => { st.slots[k] = st.slots[k].filter((x) => x !== id); });
    update();
  }
  const isPlaced = (id) => Object.values(st.slots).some((l) => l.includes(id));
  const anyPlaced = () => Object.values(st.slots).some((l) => l.length);

  function setBase(base) {
    if (base === st.base || !D.PRESETS[base]) return;
    if (anyPlaced() && !window.confirm('Switching engine family clears your current job. Continue?')) return;
    st.base = base; st.slots = emptySlots(); st.workload = null; st.openGroup = 'engine';
    update();
  }
  function loadPreset(p) {
    st.slots = emptySlots();
    p.ids.forEach((id) => { const c = D.byId[id]; if (c) st.slots[c.slot].push(id); });
    if (!st.usedBases.includes(st.base)) st.usedBases.push(st.base);
    st.workload = null;
    toast(`Loaded preset: ${p.n}`);
    update();
  }
  function openGroup(slotId, scroll) {
    st.openGroup = slotId;
    $('searchBox').value = '';
    renderPalette();
    save();
    if (scroll) {
      const g = document.querySelector(`.group[data-slot="${slotId}"]`);
      if (g) g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── hover card ──
  const pop = $('pop');
  let popTimer = null;
  function fxChips(obj) {
    return Object.entries(obj || {}).filter(([, v]) => v).map(([k, v]) =>
      h('span', { class: v > 0 ? 'up' : 'down' }, `${v > 0 ? '+' : '−'}${Math.abs(v)} ${DIM_NAME[k] || k}`));
  }
  function buildPop(c) {
    const slot = SLOT_BY_ID[c.slot];
    const placed = isPlaced(c.id);
    const body = [h('p', null, c.d)];

    if (c.base) {
      const strong = Object.entries(c.base).filter(([, v]) => v >= 60).sort((a, b) => b[1] - a[1]);
      const weak = Object.entries(c.base).filter(([, v]) => v <= 30).sort((a, b) => a[1] - b[1]).slice(0, 4);
      if (strong.length) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Strong at'), h('div', { class: 'fx' }, strong.map(([k, v]) => h('span', { class: 'up' }, `${DIM_NAME[k]} ${v}`)))));
      if (weak.length) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Weak at'), h('div', { class: 'fx' }, weak.map(([k, v]) => h('span', { class: 'down' }, `${DIM_NAME[k]} ${v}`)))));
    } else {
      const fx = fxChips(c.fx);
      if (fx.length) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Effect when active'), h('div', { class: 'fx' }, fx)));
    }
    if (c.needs) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Requires one of'), h('div', { class: 'list' }, names(c.needs.any).join(' · '))));
    if (c.engines) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Works with engine'), h('div', { class: 'list' }, names(c.engines).join(' · '))));
    if (c.conflicts && c.conflicts.length) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Conflicts with'), h('div', { class: 'list' }, names(c.conflicts.map((x) => x.id)).join(' · '))));
    if (c.flavors) body.push(h('div', { class: 'pop-sec' }, h('span', null, 'Available on'), h('div', { class: 'list' }, c.flavors.map((f) => D.PLATFORM_NAMES[f] || f).join(' · '))));
    if (placed && result && result.inactive.has(c.id)) {
      body.push(h('div', { class: 'callout warn' }, 'Not active in your job', c.needs ? ` — ${c.needs.msg}` : ' — see Checks on the right.'));
    }
    if (c.note) body.push(h('div', { class: 'callout ' + c.note.lvl }, c.note.t));
    const snippet = c.code || c.conf;
    if (snippet) body.push(h('pre', { class: 'code' }, snippet));

    const foot = placed
      ? 'In your job · click × or drag back to the left to remove'
      : `Drag onto L${slot.layer} · ${slot.n} — or click to add`;
    pop.style.cssText = colorVar(slot);
    pop.replaceChildren(
      h('div', { class: 'pop-head' },
        h('div', { class: 'pop-layer' }, h('span', { class: 'lbadge' }, `L${slot.layer}`), slot.n, placed ? ' · added' : ''),
        h('h4', null, c.n)),
      h('div', { class: 'pop-body' }, body),
      h('div', { class: 'pop-foot' }, foot));
  }
  function positionPop(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth; const ph = pop.offsetHeight; const gap = 12;
    let left = r.right + gap;
    if (left + w > window.innerWidth - 8) left = r.left - w - gap;
    if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    let top = r.top - 8;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  function showPop(anchor, c) {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => {
      if (dragging) return;
      buildPop(c);
      pop.style.visibility = 'hidden';
      pop.hidden = false;
      positionPop(anchor);
      pop.style.visibility = '';
    }, 140);
  }
  function hidePop() { clearTimeout(popTimer); popTimer = setTimeout(() => { pop.hidden = true; }, 60); }
  function hidePopNow() { clearTimeout(popTimer); pop.hidden = true; }
  function bindPop(el, c) {
    el.addEventListener('mouseenter', () => showPop(el, c));
    el.addEventListener('mouseleave', hidePop);
    el.addEventListener('focus', () => showPop(el, c));
    el.addEventListener('blur', hidePop);
  }
  document.addEventListener('scroll', hidePopNow, true);

  // ── drag helpers ──
  function startDrag(e, id, from) {
    hidePopNow();
    dragging = { id, from };
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('is-dragging');
    document.body.classList.toggle('guide', !!st.learn);
    if (st.learn) {
      const el = document.querySelector(`.slot[data-slot="${D.byId[id].slot}"]`);
      if (el) el.classList.add('target');
    }
    if (from === 'slot') paletteCol.classList.add('remove-target');
  }
  function endDrag() {
    dragging = null;
    document.body.classList.remove('is-dragging', 'guide');
    paletteCol.classList.remove('remove-target');
    document.querySelectorAll('.slot.target, .slot.over').forEach((el) => el.classList.remove('target', 'over'));
  }
  document.addEventListener('dragend', endDrag);

  // palette accepts chips dragged out of the stack (= remove)
  const paletteCol = document.querySelector('.palette-col');
  paletteCol.addEventListener('dragover', (e) => { if (dragging && dragging.from === 'slot') e.preventDefault(); });
  paletteCol.addEventListener('drop', (e) => {
    if (!dragging || dragging.from !== 'slot') return;
    e.preventDefault();
    const id = dragging.id; endDrag(); remove(id);
  });

  // ── render: palette (accordion, one group per layer colour) ──
  function renderPalette() {
    const q = $('searchBox').value.trim().toLowerCase();
    const groups = D.SLOTS.map((slot) => {
      const all = D.COMPONENTS.filter((c) => c.b === st.base && c.slot === slot.id);
      const items = all.filter((c) => !q || (c.n + ' ' + c.d).toLowerCase().includes(q));
      if (!items.length) return null;
      const used = st.slots[slot.id].length;
      const open = q ? true : st.openGroup === slot.id;
      const chips = items.map((c) => {
        const toggle = () => { hidePopNow(); isPlaced(c.id) ? remove(c.id) : place(c.id); };
        const chip = h('div', {
          class: 'chip' + (isPlaced(c.id) ? ' placed' : ''), draggable: 'true', tabindex: '0', role: 'button',
          'data-id': c.id,
          'aria-label': `${c.n}. ${isPlaced(c.id) ? 'Press Enter to remove' : `Press Enter to add to ${slot.n}`}`,
          ondragstart: (e) => startDrag(e, c.id, 'palette'),
          onclick: toggle,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
        }, c.n, c.note && c.note.lvl !== 'info' ? h('span', { class: 'dot ' + c.note.lvl, title: c.note.lvl === 'danger' ? 'Risky' : 'Has caveats' }) : null);
        bindPop(chip, c);
        return chip;
      });
      return h('div', { class: 'group' + (open ? ' open' : ''), 'data-slot': slot.id, style: colorVar(slot) },
        h('button', {
          class: 'group-head', 'aria-expanded': String(open),
          onclick: () => { st.openGroup = st.openGroup === slot.id ? null : slot.id; renderPalette(); save(); },
        },
        h('span', { class: 'lbadge' }, `L${slot.layer}`),
        h('span', { class: 'gname' }, slot.n),
        h('span', { class: 'gcount' + (used ? ' has' : '') }, q ? `${items.length} match` : used ? `${used} added` : `${all.length}`),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '▶')),
        h('div', { class: 'group-body' },
          h('p', { class: 'group-hint' }, slot.hint),
          h('div', { class: 'chips' }, chips)));
    }).filter(Boolean);
    $('palette').replaceChildren(...(groups.length ? groups : [h('p', { class: 'empty-note' }, 'No components match your search.')]));

    document.querySelectorAll('#baseSeg button[data-base]').forEach((b) => {
      b.classList.toggle('on', b.dataset.base === st.base);
      b.setAttribute('aria-selected', String(b.dataset.base === st.base));
    });
    const sel = $('presetSel');
    sel.replaceChildren(h('option', { value: '' }, 'Load a preset…'), ...D.PRESETS[st.base].map((p, i) => h('option', { value: String(i) }, p.n)));
  }

  // ── render: stack ──
  function renderStack() {
    const inactive = result.inactive;
    const nodes = D.SLOTS.map((slot) => {
      const ids = st.slots[slot.id];
      const body = ids.length
        ? ids.map((id) => {
          const c = D.byId[id];
          const chip = h('span', {
            class: 'pchip' + (inactive.has(id) ? ' inactive' : '') + (id === lastAdded ? ' fresh' : ''), draggable: 'true',
            tabindex: '0', 'data-id': id,
            ondragstart: (e) => startDrag(e, id, 'slot'),
          }, c.n, h('button', { 'aria-label': `Remove ${c.n}`, title: 'Remove', onclick: (e) => { e.stopPropagation(); hidePopNow(); remove(id); } }, '×'));
          bindPop(chip, c);
          return chip;
        })
        : [h('div', { class: 'drop-zone' },
          h('span', null, slot.required ? 'Start here — drop an execution engine' : 'Drop a component here'),
          h('button', { onclick: () => openGroup(slot.id, true) }, 'Browse →'))];
      const el = h('div', {
        class: `slot ${ids.length ? 'filled' : 'empty'}${slot.required ? ' required' : ''}`, 'data-slot': slot.id, style: colorVar(slot),
        ondragover: (e) => { if (dragging) { e.preventDefault(); el.classList.add('over'); } },
        ondragleave: (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); },
        ondrop: (e) => {
          e.preventDefault();
          const id = dragging ? dragging.id : e.dataTransfer.getData('text/plain');
          const from = dragging ? dragging.from : 'palette';
          endDrag();
          if (!D.byId[id]) return;
          if (from === 'slot' && D.byId[id].slot === slot.id) return; // dropped back where it was
          place(id, slot.id);
        },
      },
      h('div', { class: 'slot-head', title: 'Show these components on the left', onclick: () => openGroup(slot.id, true) },
        h('span', { class: 'lbadge' }, `L${slot.layer}`),
        h('strong', null, slot.n),
        h('span', { class: 'hint' }, slot.hint),
        slot.required && !ids.length ? h('span', { class: 'req' }, 'Required') : null),
      h('div', { class: 'slot-body' }, body));
      return el;
    });
    $('stack').replaceChildren(...nodes);
    lastAdded = null;
  }

  // ── missions: shared helpers ──
  const CATS = D.MISSION_CATS;
  const LEVELS = D.MISSION_LEVELS;
  const MISSION_BY_ID = Object.fromEntries(D.MISSIONS.map((m) => [m.id, m]));
  const HINT_COST = [0, 1, 2]; // stars lost for: no hint, goals revealed, answer revealed
  const tile = (m, cls) => h('span', { class: 'mtile' + (cls ? ' ' + cls : ''), style: `--mc:${CATS[m.cat].color}`, 'aria-hidden': 'true' }, m.icon);
  const starStr = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);
  const isDone = (m) => st.completed.includes(m.id);
  const hintOf = (m) => st.hints[m.id] || 0;
  const goalsVisible = (m) => hintOf(m) >= 1 || isDone(m);
  const starsOf = (m) => st.stars[m.id] || (isDone(m) ? 3 : 0);
  const totalStars = () => D.MISSIONS.reduce((s, m) => s + starsOf(m), 0);
  const evalMission = (m) => m.checks.map((c) => ({ t: c.t, ok: !!result.engine && c.f(result) }));

  function startMission(m) {
    if (m.family !== 'any' && m.family !== st.base) {
      if (anyPlaced() && !window.confirm(`This case study runs on ${FAM_LABEL[m.family]}. Switching family clears your current job. Continue?`)) return;
      st.base = m.family; st.slots = emptySlots(); st.workload = null; st.openGroup = 'engine';
    }
    st.mission = m.id;
    closeBoard();
    update();
    toast(`Mission started: ${m.n}`);
  }
  function loadAnswer(m, fam) {
    if (anyPlaced() && !window.confirm('Loading the reference build replaces your current job. Continue?')) return;
    st.base = fam; st.slots = emptySlots(); st.workload = null;
    m.answer[fam].forEach((id) => { const c = D.byId[id]; if (c) st.slots[c.slot].push(id); });
    if (!st.usedBases.includes(fam)) st.usedBases.push(fam);
    st.mission = m.id;
    closeBoard();
    update();
  }
  function revealHint(m, level) {
    if (!isDone(m)) st.hints[m.id] = Math.max(hintOf(m), level);
    save(); renderBoard(); renderMission();
  }

  // ── render: mission card (middle column) ──
  function renderMission() {
    const box = $('mission');
    const m = MISSION_BY_ID[st.mission];
    const doneCount = D.MISSIONS.filter(isDone).length;
    if (!m) {
      box.className = 'panel mission free';
      box.style.cssText = '--mc:var(--accent)';
      box.replaceChildren(h('div', { class: 'm-head' },
        h('span', { class: 'mtile', 'aria-hidden': 'true' }, '🎮'),
        h('div', { class: 'm-title' }, h('b', null, 'Free play'), h('small', null, `Build anything, or take on one of ${D.MISSIONS.length} on-call tickets (${doneCount} done).`)),
        h('button', { class: 'btn primary', onclick: () => openBoard(null) }, 'Choose a mission')));
      return;
    }
    const res = evalMission(m);
    const passed = res.filter((x) => x.ok).length;
    const done = passed === res.length;
    const visible = goalsVisible(m);
    const wrongFamily = m.family !== 'any' && m.family !== st.base;
    box.className = 'panel mission' + (done ? ' done' : '');
    box.style.cssText = `--mc:${CATS[m.cat].color}`;
    box.replaceChildren(...[
      h('div', { class: 'm-head' }, tile(m),
        h('div', { class: 'm-title' }, h('b', null, m.n),
          h('small', null, `${m.co} · ${LEVELS[m.lvl]} · ${CATS[m.cat].n}`, st.stars[m.id] ? h('span', { class: 'stars' }, '  ' + starStr(st.stars[m.id])) : null)),
        h('button', { class: 'btn primary', onclick: () => openBoard(m.id) }, 'Case study'),
        h('button', { class: 'btn', title: 'Browse all missions', onclick: () => openBoard(null) }, 'Missions', h('span', { class: 'count' }, `${doneCount}/${D.MISSIONS.length}`))),
      wrongFamily ? h('div', { class: 'callout warn' }, `This case study runs on ${FAM_LABEL[m.family]}. Switch family on the left to build it.`) : null,
      h('div', { class: 'm-prog' },
        h('div', { class: 'progress' }, h('i', { style: `width:${(passed / res.length) * 100}%` })),
        h('span', null, `${passed}/${res.length} goals met`)),
      h('ul', { class: 'checkpills' }, res.map((x, i) => h('li', { class: (x.ok ? 'pass' : '') + (visible ? '' : ' secret') }, visible ? x.t : `Hidden goal ${i + 1}`))),
      !visible ? h('p', { class: 'm-note' }, 'The goals are hidden, so work them out from the case study. You can reveal them in the case study for −1 ★.') : null,
    ].filter(Boolean));
    if (done && !isDone(m)) {
      const stars = Math.max(1, 3 - HINT_COST[hintOf(m)]);
      st.completed.push(m.id);
      st.stars[m.id] = Math.max(st.stars[m.id] || 0, stars);
      toast(`Mission complete: ${m.n}  ${starStr(stars)}`, 'win');
      save();
      renderMission();
    }
  }

  // ── mission board (dialog) ──
  const dlg = $('missionDlg');
  const board = { sel: null, cat: 'all' };
  function openBoard(id) {
    board.sel = id || board.sel || st.mission || D.MISSIONS[0].id;
    if (!MISSION_BY_ID[board.sel]) board.sel = D.MISSIONS[0].id;
    hidePopNow();
    renderBoard(true);
    if (!dlg.open) dlg.showModal();
    const sel = dlg.querySelector('.mcard.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function closeBoard() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeBoard(); });

  function renderBoard(resetDetail) {
    if (!dlg.open && !resetDetail) return;
    const prevList = dlg.querySelector('.mlist-items');
    const prevDetail = dlg.querySelector('.cs-scroll');
    const listTop = prevList ? prevList.scrollTop : 0;
    const detailTop = prevDetail && !resetDetail ? prevDetail.scrollTop : 0;

    const doneCount = D.MISSIONS.filter(isDone).length;
    const cats = [['all', 'All'], ...Object.entries(CATS).map(([id, c]) => [id, c.n])];
    const filters = h('div', { class: 'seg fams', role: 'tablist', 'aria-label': 'Filter missions' }, cats.map(([id, label]) => {
      const n = id === 'all' ? D.MISSIONS.length : D.MISSIONS.filter((m) => m.cat === id).length;
      return h('button', { class: board.cat === id ? 'on' : '', role: 'tab', 'aria-selected': String(board.cat === id), onclick: () => { board.cat = id; renderBoard(); } }, label, h('small', null, n));
    }));
    const items = D.MISSIONS.filter((m) => board.cat === 'all' || m.cat === board.cat).map((m) => h('button', {
      class: 'mcard' + (m.id === board.sel ? ' sel' : '') + (isDone(m) ? ' done' : ''), 'data-id': m.id,
      style: `--mc:${CATS[m.cat].color}`,
      onclick: () => { board.sel = m.id; renderBoard(true); },
    }, tile(m),
    h('span', { class: 'mc-text' }, h('b', null, m.n), h('small', null, `${m.co} · ${CATS[m.cat].n}`)),
    h('span', { class: 'mc-side' },
      isDone(m) ? h('span', { class: 'stars' }, starStr(starsOf(m))) : h('span', { class: 'lvl l' + m.lvl, title: LEVELS[m.lvl] }, LEVELS[m.lvl]),
      st.mission === m.id ? h('span', { class: 'now' }, 'Active') : null)));

    const head = h('div', { class: 'dlg-head' },
      h('div', null, h('h2', null, 'Mission board'),
        h('p', null, `${doneCount}/${D.MISSIONS.length} completed · ${totalStars()} of ${D.MISSIONS.length * 3} ★ · on-call tickets as exam-style case studies`)),
      h('button', { class: 'btn icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeBoard }, '×'));
    const list = h('div', { class: 'mlist' }, filters, h('div', { class: 'mlist-items' }, items.length ? items : h('p', { class: 'empty-note' }, 'No missions.')));
    dlg.replaceChildren(head, h('div', { class: 'dlg-body' }, list, renderDetail(MISSION_BY_ID[board.sel])));
    dlg.querySelector('.mlist-items').scrollTop = listTop;
    dlg.querySelector('.cs-scroll').scrollTop = detailTop;
  }

  function renderDetail(m) {
    const done = isDone(m);
    const hint = hintOf(m);
    const qOpen = st.qShown[m.id] || done || hint > 0;
    const color = CATS[m.cat].color;
    const ul = (arr) => h('ul', null, arr.map((x) => h('li', null, x)));
    const csec = (title, ...kids) => h('section', { class: 'cs-sec' }, h('h5', null, title), ...kids);
    const tag = (t, cls) => h('span', { class: 'tag' + (cls ? ' ' + cls : '') }, t);

    const parts = [
      h('header', { class: 'cs-head' }, tile(m, 'big'),
        h('div', null,
          h('div', { class: 'cs-tags' }, h('span', { class: 'tag cat', style: `--mc:${color}` }, CATS[m.cat].n), tag(LEVELS[m.lvl]), tag(FAM_LABEL[m.family]), done ? tag(`Completed ${starStr(starsOf(m))}`, 'ok') : null),
          h('h3', null, m.n),
          h('p', { class: 'cs-co' }, h('b', null, m.co), ' — ', m.brief))),
      csec('Company overview', h('p', null, m.story[0])),
      csec('The incident', m.story.slice(1).map((p) => h('p', null, p))),
      m.env.length ? csec('Existing technical environment', ul(m.env)) : null,
      csec('Business & technical requirements', ul(m.reqs)),
      h('blockquote', { class: 'cs-quote', style: `--mc:${color}` }, h('p', null, `“${m.quote.t}”`), h('cite', null, `— ${m.quote.who}`)),
      qOpen
        ? h('div', { class: 'cs-q' }, h('span', { class: 'lbl' }, 'Question'), h('p', null, m.q),
          h('p', { class: 'cs-q-how' }, 'Answer by building the job: drag components onto the layers. The hidden goals are checked as you build, and the Job plan tab shows what Spark would do.'))
        : h('button', { class: 'cs-q locked', onclick: () => { st.qShown[m.id] = true; save(); renderBoard(); } },
          h('span', { class: 'lbl' }, 'Hidden question'), h('p', null, 'Read the ticket first, then click to reveal the question.')),
    ];

    // hints: goals first, then the reference answer
    if (goalsVisible(m)) {
      const goals = st.mission === m.id ? evalMission(m) : m.checks.map((c) => ({ t: c.t, ok: false }));
      parts.push(csec('Scoring goals', h('ul', { class: 'goal-list' }, goals.map((g) => h('li', { class: g.ok ? 'pass' : '' }, g.t)))));
    }
    if (!done && hint < 2) {
      parts.push(h('div', { class: 'hint-row' },
        h('span', { class: 'hint-label' }, 'Stuck?'),
        hint < 1 ? h('button', { class: 'btn', onclick: () => revealHint(m, 1) }, 'Reveal scoring goals', h('span', { class: 'cost' }, '−1 ★')) : null,
        h('button', { class: 'btn', onclick: () => revealHint(m, 2) }, 'Show reference answer', h('span', { class: 'cost' }, hint < 1 ? '−2 ★' : '−1 ★'))));
    }
    if (hint >= 2 || done) {
      parts.push(csec('Reference answer', Object.keys(m.answer).map((fam) => h('div', { class: 'answer' },
        h('div', { class: 'answer-head' }, h('b', null, FAM_LABEL[fam]), h('button', { class: 'btn small', onclick: () => loadAnswer(m, fam) }, 'Load this build')),
        h('div', { class: 'chips' }, m.answer[fam].map((id) => {
          const c = D.byId[id]; const slot = SLOT_BY_ID[c.slot];
          return h('span', { class: 'chip static', style: colorVar(slot), title: `L${slot.layer} · ${slot.n}` }, c.n);
        }))))),
      csec('Why this works', h('p', { class: 'debrief' }, m.debrief)));
    }

    const foot = h('div', { class: 'cs-foot' },
      h('button', { class: 'btn', onclick: () => { st.mission = ''; closeBoard(); update(); } }, 'Free play'),
      h('span', { class: 'spacer' }),
      st.mission === m.id
        ? h('button', { class: 'btn primary', onclick: closeBoard }, 'Continue building')
        : h('button', { class: 'btn primary', onclick: () => startMission(m) }, done ? 'Replay mission' : 'Start mission →'));
    return h('div', { class: 'mdetail' }, h('div', { class: 'cs-scroll', tabindex: '-1', autofocus: true }, parts), foot);
  }

  // ── achievements (header dropdown) ──
  function checkAchievements() {
    D.ACHIEVEMENTS.forEach((a) => {
      if (st.unlocked.includes(a.id)) return;
      if (a.f(result)) { st.unlocked.push(a.id); toast(`Achievement unlocked: ${a.n}`, 'win'); }
    });
    $('badgePanel').replaceChildren(h('h4', null, 'Achievements'),
      ...D.ACHIEVEMENTS.map((a) => h('div', { class: 'ach' + (st.unlocked.includes(a.id) ? ' on' : '') },
        h('span', { class: 'ic' }, a.icon), h('div', null, h('b', null, a.n), h('small', null, a.d)))));
    $('badgeBtn').textContent = `🏅 ${st.unlocked.length}/${D.ACHIEVEMENTS.length}`;
    const miss = $('statMistakes');
    miss.textContent = `${st.mistakes} ${st.mistakes === 1 ? 'miss' : 'misses'}`;
    miss.classList.toggle('bad', st.mistakes > 0);
  }
  $('badgeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const p = $('badgePanel'); p.hidden = !p.hidden;
    $('badgeBtn').setAttribute('aria-expanded', String(!p.hidden));
  });
  document.addEventListener('click', (e) => {
    const p = $('badgePanel');
    if (!p.hidden && !p.contains(e.target)) { p.hidden = true; $('badgeBtn').setAttribute('aria-expanded', 'false'); }
  });

  // ── render: analysis ──
  const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', null, ...[].concat(title)), ...kids);

  function overviewTab(r) {
    const checks = r.checks.length
      ? h('ul', { class: 'checks' }, r.checks.map((c) => h('li', { class: c.lvl }, h('span', { class: 'lv' }, LVL_LABEL[c.lvl]), h('span', null, c.t))))
      : h('div', { class: 'all-good' }, '✓ No issues found in this configuration.');
    const bars = h('div', { class: 'bars' }, D.DIMS.map((d) => {
      const v = r.scores[d.id];
      return h('div', { class: 'bar' }, h('span', { title: d.n }, d.n),
        h('div', { class: 'track' }, h('div', { class: 'fill' + (v >= 75 ? ' hi' : v < 30 ? ' lo' : ''), style: `width:${v}%` })),
        h('span', { class: 'v' }, v));
    }));
    return [
      sec('Checks', checks),
      sec('Capabilities', bars),
      r.caps.length ? sec('What it can do', h('div', { class: 'caps' }, r.caps.map((c) => h('span', { class: 'cap' }, c)))) : null,
    ];
  }

  function planTab(r) {
    const good = r.fits.filter((f) => !f.gated).slice(0, 3);
    const poor = r.fits.filter((f) => !good.includes(f) && (f.gated || f.fit < 55));
    const all = r.fits;
    const selId = all.some((f) => f.w.id === st.workload) ? st.workload : good[0] && good[0].w.id;
    const sel = all.find((f) => f.w.id === selId);
    const card = (f) => h('button', {
      class: 'fit' + (f.w.id === selId ? ' sel' : ''),
      onclick: () => { st.workload = f.w.id; save(); renderAnalysis(); },
    },
    h('span', { class: 'emo' }, f.w.icon),
    h('span', null, h('div', { class: 't' }, f.w.n), h('div', { class: 'why' }, `Best: ${DIM_NAME[f.strong.k]} · Weakest: ${DIM_NAME[f.weak.k]}`)),
    h('span', { class: 'pct' }, `${f.fit}%`));
    const out = [sec('Best suited workloads', h('div', { class: 'fits' }, good.map(card)))];
    if (poor.length) {
      out.push(sec('Not a good fit', h('div', { class: 'poor' },
        poor.map((f) => h('button', { class: 'poor-pick' + (f.w.id === selId ? ' sel' : ''), title: f.gated ? f.w.reqMsg : `Weakest: ${DIM_NAME[f.weak.k]}`, onclick: () => { st.workload = f.w.id; save(); renderAnalysis(); } }, `${f.w.n} · ${f.fit}%`)))));
    }
    if (sel) {
      const w = sel.w; const p = sel.plan;
      const fmt = D.fmt;
      out.push(sec(`What Spark would do · ${w.n}`,
        h('p', { class: 'blurb' }, w.blurb),
        sel.gated ? h('div', { class: 'callout warn' }, `This workload ${w.reqMsg}.`) : null,
        h('pre', { class: 'code' }, w.code),
        h('div', { class: 'plan-sum' }, h('b', null, 'Estimate: '), p.summary),
        h('pre', { class: 'code plan' }, p.lines.join('\n')),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Stage', 'Tasks', 'Bytes', 'Note'].map((c) => h('th', null, c)))),
          h('tbody', null, p.stages.map((s) => h('tr', null,
            h('td', null, s.n), h('td', null, fmt.int(s.tasks)), h('td', null, fmt.mb(s.bytes)), h('td', { class: 'wrap' }, s.note)))))),
        h('ul', { class: 'jobs' }, p.jobs.map((j) => h('li', null, j))),
        p.sortNote ? h('div', { class: 'callout info' }, p.sortNote) : null,
        p.skew ? h('div', { class: 'callout ' + (p.skew.kind === 'straggler' ? 'warn' : 'info') }, p.skew.t) : null,
        ...p.notes.map((n) => h('div', { class: 'callout tip' }, n))));
    }
    return out;
  }

  function configTab(r) {
    const copyBtn = h('button', {
      class: 'btn small', onclick: () => {
        if (navigator.clipboard) navigator.clipboard.writeText(r.config).then(() => toast('Config copied'), () => toast('Copy failed — select the text manually'));
      },
    }, 'Copy');
    return [sec(['Generated config', copyBtn], h('pre', { class: 'code' }, r.config))];
  }

  function renderAnalysis() {
    const r = result;
    const out = $('analysis');
    if (!r.engine) {
      const steps = [
        ['engine', 'Pick an execution engine — what runs the plan'],
        ['format', 'Choose a file / table format and data layout'],
        ['planner', 'Shape joins, pruning and shuffles with the planner'],
      ].map(([id, t]) => h('li', { style: colorVar(SLOT_BY_ID[id]) }, h('span', { class: 'lbadge' }, `L${SLOT_BY_ID[id].layer}`), t));
      out.replaceChildren(h('div', { class: 'empty-state' },
        h('h3', null, 'Your job is empty'),
        h('p', null, 'Drag components from the left onto the matching coloured layer, or load a preset. Checks, capability scores and a live job plan (explain output, stages, task counts, time estimate) appear here.'),
        h('ul', { class: 'steps' }, steps)));
      return;
    }
    const ringColor = r.grade === 'S' || r.grade === 'A' ? 'var(--ok)' : r.grade === 'B' ? 'var(--accent)' : r.grade === 'C' ? 'var(--warn)' : 'var(--bad)';
    const warns = r.checks.filter((c) => c.lvl === 'warn').length;
    const bad = r.errors + r.dangers;

    const tags = [h('span', { class: 'tag' }, `${r.placed.length} components`)];
    if (bad) tags.push(h('span', { class: 'tag bad' }, `${bad} ${bad === 1 ? 'problem' : 'problems'}`));
    if (warns) tags.push(h('span', { class: 'tag warn' }, `${warns} ${warns === 1 ? 'warning' : 'warnings'}`));
    const everywhere = r.flavors.length === D.PLATFORMS.length;
    tags.push(h('span', { class: 'tag' + (r.flavors.length ? '' : ' bad') }, r.flavors.length ? (everywhere ? 'Runs on any platform' : `Runs on ${r.flavors.join(', ')}`) : 'Runs nowhere: platform conflict'));

    const summary = h('div', { class: 'summary' },
      h('div', { class: 'ring', style: `--p:${r.score};--rc:${ringColor}` }, h('div', null, h('b', null, r.grade), h('small', null, `${r.score}/100`))),
      h('div', null,
        h('h3', null, `${FAM_LABEL[r.base] || r.base} · ${r.engine.n}`),
        h('div', { class: 'tags' }, tags)));

    const tabDefs = [
      ['overview', 'Overview', bad || warns ? h('span', { class: 'n' + (bad ? '' : ' warn') }, bad || warns) : null],
      ['plan', 'Job plan', null],
      ['config', 'Config', null],
    ];
    if (!tabDefs.some(([id]) => id === st.tab)) st.tab = 'overview';
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabDefs.map(([id, label, badge]) => h('button', {
      class: st.tab === id ? 'on' : '', role: 'tab', 'aria-selected': String(st.tab === id), 'data-tab': id,
      onclick: () => { st.tab = id; save(); renderAnalysis(); },
    }, label, badge)));
    const content = st.tab === 'plan' ? planTab(r) : st.tab === 'config' ? configTab(r) : overviewTab(r);
    out.replaceChildren(summary, tabs, h('div', { class: 'tab-body' }, content));
  }

  // ── main update loop ──
  function update() {
    result = D.analyze(st);
    renderPalette();
    renderStack();
    renderMission();
    checkAchievements();
    renderAnalysis();
    save();
  }

  // ── wire static controls ──
  document.querySelectorAll('#baseSeg button[data-base]').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $('presetSel').addEventListener('change', (e) => {
    const p = D.PRESETS[st.base][+e.target.value];
    if (p) loadPreset(p);
  });
  $('searchBox').addEventListener('input', renderPalette);
  $('learnMode').checked = st.learn;
  $('learnMode').addEventListener('change', (e) => { st.learn = e.target.checked; save(); toast(st.learn ? 'Guide on: the matching layer lights up while dragging' : 'Hard mode: no hints, misses are counted'); });
  $('resetBtn').addEventListener('click', () => { st.slots = emptySlots(); st.workload = null; update(); toast('Job cleared'); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!st.theme) applyTheme(); });

  // The "back to hub" link only makes sense when embedded in the upskill hub (?from=hub).
  if (new URLSearchParams(window.location.search).get('from') === 'hub') document.querySelector('.back').hidden = false;

  applyTheme();
  update();
})();
