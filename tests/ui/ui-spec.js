/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Browser UI spec. Injected after src/ui/app.js by run-ui-tests.mjs and executed
 * in headless Chrome. Results are appended to the page as a TESTLOG <pre> of PASS/FAIL lines.
 */
(function () {
  'use strict';

  const results = [];
  const expect = (condition, name) => results.push(`${condition ? 'PASS' : 'FAIL'} ${name}`);

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const chip = (name) => $$('#palette .chip').find((c) => c.textContent.includes(name));
  const slot = (id) => $(`.slot[data-slot="${id}"]`);
  const saved = () => JSON.parse(localStorage.getItem('dcp-playground-v1'));
  const button = (root, text) => $$('button', root).find((b) => b.textContent.includes(text));

  function dragAndDrop(source, target) {
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  }

  window.confirm = () => true; // auto-accept "loading the reference build replaces your job"

  // ── Building a job ──────────────────────────────────────────────────
  expect($('.empty-state'), 'empty analysis state is shown');
  expect($('.back').hidden, 'hub back-link is hidden when not opened from the hub');
  expect($('#baseSeg button.on').dataset.base === 'spark', 'Apache Spark is the active family');

  dragAndDrop(chip('Hadoop YARN'), slot('engine'));
  expect($('#statMistakes').textContent.includes('1'), 'wrong-layer drop is counted as a miss');
  expect(!slot('engine').textContent.includes('YARN'), 'wrong-layer drop is rejected');

  dragAndDrop(chip('Hadoop YARN'), slot('cluster'));
  expect(slot('cluster').textContent.includes('YARN'), 'correct-layer drop places the component');

  chip('Catalyst + Tungsten').click();
  expect(slot('engine').textContent.includes('Catalyst'), 'click-to-add places a component');
  expect($('.summary'), 'analysis renders once an engine is present');
  expect($('.summary h3').textContent.includes('Apache Spark'), 'summary names the family and engine');

  dragAndDrop(chip('Gluten'), slot('engine'));
  expect(slot('engine').textContent.includes('Gluten') && !$('.pchip', slot('engine')).textContent.includes('Catalyst'),
    'single-slot layer swaps the engine');
  expect($$('.checks li.warn').some((li) => li.textContent.includes('off-heap')), 'Gluten without off-heap raises a warning');

  chip('Dynamic allocation').click();
  expect($('.pchip.inactive', slot('sched')), 'dynamic allocation without a shuffle service is marked inactive');
  expect($$('.checks li.error').some((li) => li.textContent.includes('external shuffle service')), 'prerequisite error is listed');
  chip('External shuffle service').click();
  expect(!$('.pchip.inactive', slot('sched')), 'dynamic allocation becomes active once ESS is added');

  dragAndDrop($('.pchip', slot('cluster')), $('.palette-col'));
  expect(!slot('cluster').textContent.includes('YARN'), 'dragging back to the palette removes a component');
  $('.pchip button', slot('sched')).click();
  expect(!$('.pchip', slot('sched')), 'the × button removes a component');

  // ── Theme, analysis tabs and persistence ────────────────────────────
  const themeBefore = document.documentElement.dataset.theme;
  $('#themeBtn').click();
  expect(document.documentElement.dataset.theme !== themeBefore, 'theme toggles');

  $('.tabs button[data-tab="plan"]').click();
  expect($$('.fit').length >= 1, 'best-fit workload cards are shown');
  expect($('.tab-body pre.plan').textContent.includes('== Physical Plan =='), 'job plan tab renders an explain-style plan');
  expect($('.tab-body table tbody tr'), 'stage table is rendered');
  expect($('.plan-sum').textContent.includes('tasks'), 'estimate summary mentions tasks');
  expect(saved().slots.engine[0] === 'gluten', 'state is persisted to localStorage');

  chip('Broadcast hint').click();
  expect($('.tab-body pre.plan').textContent.includes('BroadcastHashJoin'), 'adding a broadcast hint changes the plan to BroadcastHashJoin');

  $('.tabs button[data-tab="config"]').click();
  expect($('.tab-body pre').textContent.includes('spark-submit'), 'config tab shows a spark-submit line');
  expect($('.tab-body pre').textContent.includes('GlutenPlugin'), 'config tab includes the engine plugin conf');

  // ── Colour coding and guidance ──────────────────────────────────────
  const colorOf = (el) => getComputedStyle(el).getPropertyValue('--c').trim();
  expect(window.DCP.SLOTS.every((s) => colorOf($(`.group[data-slot="${s.id}"]`)) === colorOf(slot(s.id))),
    'palette group colours match stack slot colours');

  const dt = new DataTransfer();
  const dragged = chip('Kubernetes');
  dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  expect(slot('cluster').classList.contains('target') && document.body.classList.contains('guide'),
    'guide mode highlights the matching layer while dragging');
  dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  expect(!$('.slot.target'), 'highlight is cleared on dragend');

  $('.group[data-slot="shuffle"] .group-head').click();
  expect($('.group[data-slot="shuffle"]').classList.contains('open'), 'accordion opens a palette group');
  $('.slot-head', slot('layout')).click();
  expect($('.group[data-slot="layout"]').classList.contains('open'), 'clicking a layer opens its palette group');

  // ── Presets ─────────────────────────────────────────────────────────
  const presetSel = $('#presetSel');
  presetSel.value = '0';
  presetSel.dispatchEvent(new Event('change', { bubbles: true }));
  expect(slot('engine').textContent.includes('Catalyst') && $$('.pchip').length >= 10, 'loading a preset fills the job');
  expect($('.summary .tag').textContent.includes('components'), 'summary shows the component count');
  $('#resetBtn').click();
  expect($('.empty-state'), 'reset clears the job');

  // ── Missions ────────────────────────────────────────────────────────
  const D = window.DCP;
  const dlg = $('#missionDlg');
  expect(D.MISSIONS.length >= 20, `mission catalogue has ${D.MISSIONS.length} case studies`);

  button($('#mission'), 'Case study').click();
  expect(dlg.open, 'mission board dialog opens');
  expect($$('.mcard', dlg).length === D.MISSIONS.length, 'board lists every mission');

  button($('.seg.fams', dlg), 'Streaming').click();
  expect($$('.mcard', dlg).length === D.MISSIONS.filter((m) => m.cat === 'streaming').length, 'category filter narrows the list');
  button($('.seg.fams', dlg), 'All').click();

  $('.mcard[data-id="straggler"]', dlg).click();
  expect($('.cs-head h3', dlg).textContent.includes('One task'), 'selecting a card shows its case study');
  expect($$('.cs-sec', dlg).length >= 4 && $('.cs-quote', dlg), 'case study sections and quote are rendered');

  expect($('.cs-q.locked', dlg), 'the question is hidden initially');
  $('.cs-q.locked', dlg).click();
  expect(!$('.cs-q.locked', dlg) && $('.cs-q', dlg).textContent.includes('Question'), 'the question can be revealed');

  button($('.hint-row', dlg), 'goals').click();
  expect($('.goal-list', dlg) && saved().hints.straggler === 1, 'revealing goals records a hint');

  button($('.cs-foot', dlg), 'Start').click();
  expect(!dlg.open && saved().mission === 'straggler', 'starting a mission closes the board and activates it');
  expect($$('#mission .checkpills li:not(.secret)').length > 0, 'goal pills are visible after the hint');

  $('#mission .btn.primary').click();
  button($('.hint-row', dlg), 'answer').click();
  expect($('.answer', dlg), 'reference answer is shown');
  $('.answer .btn', dlg).click();
  expect(saved().completed.includes('straggler') && saved().stars.straggler === 1, 'loading the answer completes the mission with 1 star');
  expect($('#mission.done'), 'mission card shows completion');

  $('#mission .btn.primary').click();
  $$('.cs-foot button', dlg).find((b) => b.textContent === 'Free play').click();
  expect($('#mission.free'), 'free play mode can be selected');

  const pre = document.createElement('pre');
  pre.id = 'TESTLOG';
  pre.textContent = results.join('\n');
  document.body.append(pre);
})();
