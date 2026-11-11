// Sidebar UI - Systems panel with collapsible groups
import { state, subscribe, getSystemParts, getStructureInfo, setLanguage, translate } from '../state/store.js';
import { getMeshRegistry, loadModel, unloadSystem } from '../viewer/loadModel.js';
import { SYSTEM_IDS } from '../data/anatomy.js';
import { hideSystem, showSystem, hidePart, showPart, isolatePart, setPartTransparency, restoreAllParts, getSystemVisibilityState } from '../viewer/visibility.js';
import { selectPartById, deselectPart } from '../viewer/selection.js';
import { setView, resetView } from '../viewer/camera.js';
import { loadAllData, searchStructures } from '../utils/dataLoader.js';
import { initDepthSlider, resetDepthSlider } from './depthSlider.js';
import { PRESETS, applyPreset } from '../data/presets.js';
import { setInert, focusFirst, trapFocus, rovingList } from './focus.js';

// Systems as they are organised in the Z-Anatomy source file. Respiratory,
// digestive and urinary structures all live in the single "visceral" model.
const SYSTEM_LABELS = {
  it: {
    skeletal: 'Sistema scheletrico',
    muscular: 'Sistema muscolare',
    joints: 'Articolazioni',
    cardiovascular: 'Sistema cardiovascolare',
    lymphatic: 'Organi linfatici',
    nervous: 'Sistema nervoso e organi di senso',
    visceral: 'Sistemi viscerali'
  },
  en: {
    skeletal: 'Skeletal system',
    muscular: 'Muscular system',
    joints: 'Joints',
    cardiovascular: 'Cardiovascular system',
    lymphatic: 'Lymphoid organs',
    nervous: 'Nervous system & sense organs',
    visceral: 'Visceral systems'
  }
};

const SYSTEM_ICONS = {
  skeletal: '🦴',
  muscular: '💪',
  joints: '🦵',
  cardiovascular: '❤️',
  lymphatic: '🫧',
  nervous: '🧠',
  visceral: '🫁'
};

export function systemLabel(systemId, lang = state.language || 'it') {
  return SYSTEM_LABELS[lang]?.[systemId] || SYSTEM_LABELS.it[systemId] || systemId;
}

export function initSystemsSidebar() {
  const container = document.getElementById('systemsList');
  if (!container) return;

  const lang = state.language || 'en';

  const presets = `
    <div class="sidebar-section-label">Body regions</div>
    <div class="preset-row">
      ${PRESETS.map(preset => `
        <button type="button" class="preset-chip" data-preset="${preset.id}">
          ${escapeHtml(preset.label[lang] || preset.label.en)}
        </button>
      `).join('')}
    </div>
  `;

  container.innerHTML = presets + SYSTEM_IDS.map(systemId => {
    const parts = getSystemParts(systemId);
    const count = parts.length;
    const icon = SYSTEM_ICONS[systemId] || '🔬';
    const label = systemLabel(systemId, lang);

    // Determine initial visibility state
    const visibility = getSystemVisibilityState(systemId);
    const isVisible = visibility.visible;
    const checkboxState = isVisible ? 'checked' : '';

    return `
      <div class="system-group" data-system="${systemId}">
        <label class="system-group-label">
          <input type="checkbox" ${checkboxState} data-system-checkbox="${systemId}">
          <span class="system-icon">${icon}</span>
          <span class="system-name">${label}</span>
          <span class="system-count">${count}</span>
        </label>
        <div class="system-group-content" style="display: ${isVisible ? 'block' : 'none'};"></div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-preset]').forEach(chip => {
    chip.addEventListener('click', () => {
      const preset = PRESETS.find(p => p.id === chip.dataset.preset);
      if (preset) applyPreset(preset);
    });
  });

  // Systems loaded before this ran — the startup system, or anything restored
  // from a link — never passed through the checkbox handler, so their lists
  // would stay empty.
  state.loadedSystems.forEach(systemId => {
    const content = container.querySelector(`.system-group[data-system="${systemId}"] .system-group-content`);
    if (content && content.children.length === 0) populateSystemStructures(systemId, content);
  });

  // Add event listeners for system toggles
  container.querySelectorAll('[data-system-checkbox]').forEach(checkbox => {
    checkbox.addEventListener('change', async (e) => {
      const systemId = e.target.dataset.systemCheckbox;
      const group = e.target.closest('.system-group');
      const content = group.querySelector('.system-group-content');

      // A manual toggle invalidates the depth slider's picture of the scene.
      resetDepthSlider();

      if (!e.target.checked) {
        hideSystem(systemId);
        content.style.display = 'none';
        scheduleUnload(systemId, content);
        return;
      }

      cancelUnload(systemId);

      // Models are fetched on first activation, not upfront.
      await ensureSystemLoaded(systemId, group);
      showSystem(systemId);
      content.style.display = 'block';

      // Building the list here covers every activation path: clicking the
      // checkbox, clicking the row, or keyboard activation.
      if (content.children.length === 0) {
        populateSystemStructures(systemId, content);
      }
    });
  });
}

// Selecting a structure from search must work even when its system has never
// been downloaded: 2550 of the 2827 structures are in that state on a fresh
// page, and every one of them used to be a dead click.
export async function selectStructureAnywhere(partId) {
  const info = getStructureInfo(partId);
  const systemId = info?.system;

  if (systemId) {
    // Switching a system off leaves it in loadedSystems with an unload timer
    // running, so "already loaded" is not the same as "on screen". Without
    // this the structure would be selected inside a system nobody can see, and
    // the timer would then dispose the geometry under the live selection.
    cancelUnload(systemId);

    const groupEl = () => document.querySelector(`.system-group[data-system="${systemId}"]`);
    const loaded = state.loadedSystems.includes(systemId);
    // Ask the scene rather than the checkbox: the checkbox is a rendering of
    // this answer and can be older than it. A system with anything still on
    // screen is left alone, because showSystem() would undo every structure
    // the user hid or faded inside it.
    const hidden = loaded && !getSystemVisibilityState(systemId).visible;

    if (!loaded || hidden) {
      if (!loaded) await ensureSystemLoaded(systemId, groupEl());

      // Re-read the row after the await: it may have been rebuilt while the
      // model was in flight.
      const group = groupEl();
      const checkbox = group?.querySelector('[data-system-checkbox]');
      const content = group?.querySelector('.system-group-content');
      if (checkbox) checkbox.checked = true;
      if (content) {
        content.style.display = 'block';
        if (content.children.length === 0) populateSystemStructures(systemId, content);
      }
      showSystem(systemId);
    }
  }

  selectPartById(partId, state.viewer);
}

// Hiding a system is instant, but its buffers are only released if it stays
// off: toggling twice in a row should not pay for a reload.
const UNLOAD_GRACE_MS = 30000;
const pendingUnloads = new Map();

function scheduleUnload(systemId, content) {
  cancelUnload(systemId);
  pendingUnloads.set(systemId, setTimeout(() => {
    pendingUnloads.delete(systemId);
    if (unloadSystem(systemId) && content) content.innerHTML = '';
  }, UNLOAD_GRACE_MS));
}

function cancelUnload(systemId) {
  const timer = pendingUnloads.get(systemId);
  if (timer) {
    clearTimeout(timer);
    pendingUnloads.delete(systemId);
  }
}

const pendingSystemLoads = new Map();

async function ensureSystemLoaded(systemId, group) {
  if (state.loadedSystems.includes(systemId)) return;

  if (!pendingSystemLoads.has(systemId)) {
    const label = group?.querySelector('.system-group-label');
    const counter = label?.querySelector('.system-count');
    const originalCount = counter?.textContent;
    label?.classList.add('loading');

    // The bytes were already being measured and thrown away; show them.
    const unsubscribe = subscribe('loading', info => {
      if (!counter || info.system !== systemId || info.loaded) return;
      counter.textContent = info.total
        ? `${Math.round(info.loaded / 1048576 * 10) / 10}/${Math.round(info.total / 1048576 * 10) / 10} MB`
        : `${Math.round(info.loaded / 1048576 * 10) / 10} MB`;
    });

    const promise = loadModel(systemId, state.viewer)
      .catch(error => {
        console.error(`[sidebar] Failed to load ${systemId}:`, error);
        label?.classList.add('failed');
        if (counter) counter.textContent = translate('retry');
      })
      .finally(() => {
        unsubscribe?.();
        label?.classList.remove('loading');
        if (counter && originalCount && !label?.classList.contains('failed')) {
          counter.textContent = originalCount;
        }
        pendingSystemLoads.delete(systemId);
      });

    pendingSystemLoads.set(systemId, promise);
  }

  await pendingSystemLoads.get(systemId);
}

const ROWS_PER_CHUNK = 60;

// Each rendered list keeps its roving-tabindex refresher, called as chunks land.
const rovingRefreshers = new WeakMap();

// One row per structure rather than per mesh: the left and right copies of the
// same structure share a row and are picked with a side chip.
function groupSystemStructures(systemId, lang) {
  const groups = new Map();

  getSystemParts(systemId).forEach(partId => {
    const info = getStructureInfo(partId) || {};
    const base = info.baseName || partId;

    let group = groups.get(base);
    if (!group) {
      group = {
        base,
        label: (info.name?.[lang] || info.name?.en || base).replace(/\s*\((sinistro|destro|left|right)\)$/i, ''),
        parts: [],
        sides: {}
      };
      groups.set(base, group);
    }

    group.parts.push(partId);
    group.sides[info.side || 'none'] = partId;
  });

  return [...groups.values()];
}

function rowMarkup(group) {
  const primary = group.sides.none || group.sides.right || group.sides.left;
  const visible = group.parts.some(id => state.partStates.get(id)?.visible !== false);
  const selected = group.parts.some(id => state.partStates.get(id)?.selected === true);

  const sides = ['left', 'right']
    .filter(side => group.sides[side])
    .map(side => `<button type="button" class="structure-side" data-select="${escapeHtml(group.sides[side])}" title="${translate(side === 'left' ? 'side_left' : 'side_right')}">${translate(side === 'left' ? 'side_left_short' : 'side_right_short')}</button>`)
    .join('');

  const label = escapeHtml(group.label);

  return `
    <div class="structure-item ${selected ? 'selected' : ''}" role="option" tabindex="-1" aria-selected="${selected}" data-part="${escapeHtml(primary)}" data-parts="${escapeHtml(group.parts.join('|'))}">
      <input type="checkbox" ${visible ? 'checked' : ''} data-part-checkbox="${escapeHtml(primary)}">
      <span class="structure-name" title="${label}">${label}</span>
      <span class="structure-sides">${sides}</span>
      <div class="structure-actions">
        <button class="action-btn isolate" data-action="isolate" title="${escapeHtml(translate('isolate'))}" aria-label="${escapeHtml(translate('isolate'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="action-btn hide" data-action="hide" title="${escapeHtml(translate('hide'))}" aria-label="${escapeHtml(translate('hide'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M2 2l20 20"/></svg>
        </button>
        <button class="action-btn transparent" data-action="transparent" title="${escapeHtml(translate('transparent'))}" aria-label="${escapeHtml(translate('transparent'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2v20M2 12h20"/></svg>
        </button>
      </div>
    </div>
  `;
}

function populateSystemStructures(systemId, container) {
  const lang = state.language || 'it';
  const groups = groupSystemStructures(systemId, lang);

  // A 669-structure system used to build ~10 000 nodes and ~2700 listeners in
  // one go. Rows arrive in chunks as the panel is scrolled, behind a single
  // delegated listener.
  let rendered = 0;
  container.innerHTML = '';

  const sentinel = document.createElement('div');
  sentinel.className = 'structure-sentinel';

  const renderChunk = () => {
    const slice = groups.slice(rendered, rendered + ROWS_PER_CHUNK);
    if (!slice.length) return;

    sentinel.insertAdjacentHTML('beforebegin', slice.map(rowMarkup).join(''));
    rendered += slice.length;
    rovingRefreshers.get(container)?.();

    if (rendered >= groups.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };

  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) renderChunk();
  }, { root: container.closest('.sidebar-content'), rootMargin: '200px' });

  container.setAttribute('role', 'listbox');
  container.setAttribute('aria-label', translate('systems'));

  container.appendChild(sentinel);
  renderChunk();
  observer.observe(sentinel);

  container.addEventListener('click', onStructureListClick);
  container.addEventListener('change', onStructureListChange);

  // One tab stop for the whole list; the arrows move between rows. 669 rows
  // would otherwise be 669 stops.
  const refreshRoving = rovingList(container, {
    itemSelector: '.structure-item',
    onActivate: item => selectPartById(item.dataset.part, state.viewer)
  });
  refreshRoving();
  rovingRefreshers.set(container, refreshRoving);
}

function partsOf(item) {
  return (item.dataset.parts || item.dataset.part || '').split('|').filter(Boolean);
}

function onStructureListChange(event) {
  const checkbox = event.target.closest('[data-part-checkbox]');
  if (!checkbox) return;

  const item = checkbox.closest('.structure-item');
  partsOf(item).forEach(partId => {
    if (checkbox.checked) showPart(partId); else hidePart(partId);
  });
}

function onStructureListClick(event) {
  const item = event.target.closest('.structure-item');
  if (!item) return;

  const side = event.target.closest('[data-select]');
  if (side) {
    event.stopPropagation();
    selectPartById(side.dataset.select, state.viewer);
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  const parts = partsOf(item);
  const primary = item.dataset.part;

  if (action === 'isolate') {
    event.stopPropagation();
    isolatePart(primary);
    return;
  }

  if (action === 'hide') {
    event.stopPropagation();
    parts.forEach(hidePart);
    deselectPart();
    return;
  }

  if (action === 'transparent') {
    event.stopPropagation();
    const opacity = getPartVisibility(primary).opacity < 1 ? 1 : 0.3;
    parts.forEach(partId => setPartTransparency(partId, opacity));
    return;
  }

  if (event.target.type === 'checkbox') return;
  selectPartById(primary, state.viewer);
}

function getPartVisibility(partId) {
  const meshRegistry = getMeshRegistry();
  const mesh = meshRegistry.get(partId);
  if (!mesh) return { visible: false, opacity: 1 };

  const partState = state.partStates.get(partId);
  return {
    visible: mesh.visible && (partState?.visible !== false),
    opacity: partState?.opacity ?? 1
  };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize toolbar buttons
export function initToolbar(viewer) {
  // Isolate / hide / transparency are on the callout and the action bar; the
  // toolbar only carries camera presets.
  const buttons = {
    resetBtn: () => resetView(viewer),
    frontViewBtn: () => setView('front', viewer),
    sideViewBtn: () => setView('right', viewer),
    backViewBtn: () => setView('back', viewer),
    topViewBtn: () => setView('top', viewer)
  };

  Object.entries(buttons).forEach(([id, handler]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', handler);
  });
}

function isolateSelected() {
  if (state.selectedPart) {
    isolatePart(state.selectedPart.id);
  }
}

function hideSelected() {
  if (state.selectedPart) {
    hidePart(state.selectedPart.id);
    deselectPart();
  }
}

function toggleTransparencySelected() {
  if (state.selectedPart) {
    const visibility = getPartVisibility(state.selectedPart.id);
    setPartTransparency(state.selectedPart.id, visibility.opacity < 1 ? 1 : 0.3);
  }
}

// Footer actions
export function initFooterActions(viewer) {
  const buttons = {
    footerIsolateBtn: () => isolateSelected(),
    footerHideBtn: () => hideSelected(),
    footerTransparentBtn: () => toggleTransparencySelected(),
    // Restoring visibility must not throw away the angle the user just chose;
    // the camera has its own Reset in the toolbar.
    footerShowAllBtn: () => { restoreAllParts(); deselectPart(); }
  };

  Object.entries(buttons).forEach(([id, handler]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', handler);
  });
}

// Help modal
export function initHelpModal() {
  const modal = document.getElementById('helpModal');
  const openBtn = document.getElementById('helpBtn');
  const closeBtn = document.getElementById('helpClose');
  const overlay = modal?.querySelector('.modal-overlay');
  if (!modal) return;

  let release = null;

  function open() {
    modal.classList.remove('hidden');
    setInert(modal, false);
    // A modal dialog keeps the focus until it is dismissed, and hands it back
    // to whatever opened it.
    release = trapFocus(modal.querySelector('.modal-content') || modal, { onEscape: close, returnFocusTo: openBtn });
  }

  function close() {
    if (modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    setInert(modal, true);
    release?.();
    release = null;
  }

  setInert(modal, true);

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
}

// Language selector
export function initLanguageSelector() {
  const select = document.getElementById('langSelect');
  if (select) {
    select.value = state.language || 'it';
    select.addEventListener('change', (e) => {
      setLanguage(e.target.value);
    });
  }
}

// Search functionality
export function initSearch() {
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');

  if (!input || !results) return;

  input.addEventListener('input', debounce((e) => {
    const query = e.target.value.toLowerCase().trim();
    if (query.length < 2) {
      results.innerHTML = '';
      results.classList.remove('show');
      return;
    }

    const matches = searchStructures(query);
    if (matches.length > 0) {
      const lang = state.language || 'it';

      results.innerHTML = matches.map((row, index) => {
        // Paired structures are one row with a side chip each, instead of two
        // near-identical rows.
        const sides = ['left', 'right']
          .filter(side => row.sides[side])
          .map(side => `<button type="button" class="result-side" data-part="${escapeHtml(row.sides[side])}" title="${translate(side === 'left' ? 'side_left' : 'side_right')}">${translate(side === 'left' ? 'side_left_short' : 'side_right_short')}</button>`)
          .join('');

        const target = row.sides.none || row.sides.right || row.sides.left;
        const pending = state.loadedSystems.includes(row.system) ? '' : ' is-pending';

        return `
          <div class="search-result-item${pending}" role="option" id="search-option-${index}" aria-selected="false" data-part="${escapeHtml(target)}">
            <span class="result-name">${escapeHtml(row.label)}</span>
            <span class="result-sides">${sides}</span>
            <span class="result-system">${escapeHtml(systemLabel(row.system, lang))}</span>
          </div>
        `;
      }).join('');

      results.classList.add('show');

      const choose = async (partId) => {
        input.value = '';
        results.innerHTML = '';
        results.classList.remove('show');
        input.blur();
        await selectStructureAnywhere(partId);
      };

      results.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', (clickEvent) => {
          const side = clickEvent.target.closest('.result-side');
          choose(side ? side.dataset.part : item.dataset.part);
        });
      });
    } else {
      results.innerHTML = `<div class="search-result-item is-empty" role="option" aria-disabled="true">${translate('no_results')}</div>`;
      results.classList.add('show');
    }
  }, 150));

  // Close results on click outside
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.classList.remove('show');
    }
  });

  // Combobox semantics: the field keeps the focus and the arrows move an
  // "active" option, which is what a screen reader announces.
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'searchResults');
  results.setAttribute('role', 'listbox');

  let activeIndex = -1;

  function options() {
    return [...results.querySelectorAll('.search-result-item:not(.is-empty)')];
  }

  function setActive(index) {
    const list = options();
    list.forEach(option => {
      option.classList.remove('is-active');
      option.setAttribute('aria-selected', 'false');
    });

    activeIndex = list.length ? (index + list.length) % list.length : -1;
    const active = list[activeIndex];

    if (active) {
      active.classList.add('is-active');
      active.setAttribute('aria-selected', 'true');
      active.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', active.id);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function closeResults() {
    results.classList.remove('show');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  // The list is rebuilt on every keystroke, so the active option resets with it.
  const observer = new MutationObserver(() => {
    input.setAttribute('aria-expanded', String(results.classList.contains('show')));
    activeIndex = -1;
  });
  observer.observe(results, { childList: true });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeResults();
      input.blur();
      return;
    }

    if (!results.classList.contains('show')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      const list = options();
      const target = list[activeIndex] || list[0];
      if (target) {
        e.preventDefault();
        target.click();
      }
    }
  });
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

// State change handlers
subscribe('selectedPart', onSelectionChange);
subscribe('language', onLanguageChange);
subscribe('partStates', onPartStatesChange);

function onSelectionChange(part) {
  // Update sidebar highlights
  document.querySelectorAll('.structure-item.selected').forEach(el => {
    el.classList.remove('selected');
  });

  if (part) {
    const item = document.querySelector(`.structure-item[data-part="${part.id}"]`);
    if (item) item.classList.add('selected');

    updateFooterButtons(part);
  } else {
    document.getElementById('footerBar')?.style.setProperty('display', 'none');
  }
}

function onLanguageChange(lang) {
  // Update UI text
  updateUIText(lang);

  // Re-render sidebar
  initSystemsSidebar();

  // Re-render info panel if part selected
  if (state.selectedPart) {
    selectPartById(state.selectedPart.id, state.viewer);
  }
}

function onPartStatesChange(partStates) {
  // Update checkboxes in sidebar
  partStates.forEach((partState, partId) => {
    const checkbox = document.querySelector(`[data-part-checkbox="${partId}"]`);
    if (checkbox) {
      checkbox.checked = partState.visible !== false;
    }

    const item = document.querySelector(`.structure-item[data-part="${partId}"]`);
    if (item) {
      item.classList.toggle('hidden', partState.visible === false);
      item.style.opacity = partState.opacity < 1 ? '0.5' : '1';
    }
  });
}

function updateFooterButtons(part) {
  const footer = document.getElementById('footerBar');
  if (!footer) return;

  footer.style.display = 'flex';

  const isolateBtn = document.getElementById('footerIsolateBtn');
  const hideBtn = document.getElementById('footerHideBtn');
  const transparentBtn = document.getElementById('footerTransparentBtn');

  if (isolateBtn) isolateBtn.disabled = false;
  if (hideBtn) hideBtn.disabled = false;
  if (transparentBtn) transparentBtn.disabled = false;

  const visibility = getPartVisibility(part.id);
  if (transparentBtn) {
    transparentBtn.textContent = translate(visibility.opacity < 1 ? 'opaque' : 'transparent');
  }
}

function updateUIText(lang) {
  const t = (key) => translate(key, lang);

  // Assistive technology takes pronunciation and language from the document,
  // not from the picker in the header.
  document.documentElement.lang = lang;

  // Update placeholders
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.placeholder = t('search_placeholder');

  // Update button titles
  const updates = [
    ['resetBtn', 'reset'],
    ['isolateBtn', 'isolate'],
    ['hideBtn', 'hide'],
    ['transparentBtn', 'transparent'],
    ['frontViewBtn', 'front_view'],
    ['sideViewBtn', 'side_view'],
    ['backViewBtn', 'back_view'],
    ['topViewBtn', 'top_view'],
    ['footerIsolateBtn', 'isolate'],
    ['footerHideBtn', 'hide'],
    ['footerTransparentBtn', 'transparent'],
    ['footerShowAllBtn', 'show_all']
  ];

  updates.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) {
      el.title = t(key);
      if (el.tagName === 'BUTTON' && !el.querySelector('svg')) {
        el.textContent = t(key);
      }
    }
  });

  // Update sidebar headers
  const systemsHeader = document.querySelector('.sidebar-systems .sidebar-header h2');
  if (systemsHeader) systemsHeader.textContent = t('systems');

  const infoHeader = document.querySelector('.sidebar-info .sidebar-header h2');
  if (infoHeader) infoHeader.textContent = t('info');

  // Static markup opts in with data-i18n; that is what keeps the help modal
  // from staying in English after switching language.
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });

  const depthLabel = document.querySelector('.depth-label');
  if (depthLabel) depthLabel.textContent = t('depth');

  const depthSlider = document.getElementById('depthSlider');
  if (depthSlider) depthSlider.setAttribute('aria-label', t('depth'));
}

// Initialize all UI
export async function initUI(viewer) {
  await loadAllData();
  // The markup is written in English; anything else comes from the dictionaries.
  updateUIText(state.language);
  initSystemsSidebar();
  initToolbar(viewer);
  initFooterActions(viewer);
  initHelpModal();
  initLanguageSelector();
  initSearch();
  initDrawers();
  initMobileSearch();
  initDepthSlider();
}

// Under 1024px the search field is hidden; this button is the only way to it.
function initMobileSearch() {
  const button = document.getElementById('searchOpen');
  const header = document.querySelector('.header');
  const input = document.getElementById('searchInput');
  if (!button || !header || !input) return;

  button.addEventListener('click', () => {
    const open = header.classList.toggle('search-open');
    button.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      header.classList.remove('search-open');
      button.setAttribute('aria-expanded', 'false');
      input.blur();
    }
  });
}

// On narrow layouts both sidebars slide off-canvas; these wire the header
// buttons that bring them back and the close buttons inside them.
function initDrawers() {
  const app = document.getElementById('app');
  const drawerQuery = window.matchMedia('(max-width: 1024px)');

  const panels = {
    systems: { el: document.getElementById('systemsSidebar'), closed: '-100%', flag: 'systems-open', trigger: 'systemsOpen' },
    info: { el: document.getElementById('infoSidebar'), closed: '100%', flag: 'info-open', trigger: 'infoOpen' }
  };

  // The drawer offset is written inline rather than left to a class, because
  // the off-canvas transform is declared in several places and whichever rule
  // wins is not worth reasoning about every time the stylesheet moves.
  function apply(name, open, { moveFocus = false } = {}) {
    const panel = panels[name];
    if (!panel.el) return;

    app?.classList.toggle(panel.flag, open);

    if (drawerQuery.matches) {
      panel.el.style.transform = open ? 'translateX(0)' : `translateX(${panel.closed})`;
    } else {
      panel.el.style.transform = '';
    }

    // A panel that is off screen must not be reachable with Tab. The systems
    // panel is a real column on desktop, so it only goes inert as a drawer.
    const offScreen = name === 'systems' ? drawerQuery.matches && !open : !open;
    setInert(panel.el, offScreen);

    const trigger = document.getElementById(panel.trigger);
    trigger?.setAttribute('aria-expanded', String(open));

    if (!moveFocus) return;

    if (open) {
      focusFirst(panel.el);
    } else if (trigger && trigger.offsetParent !== null) {
      trigger.focus();
    } else {
      // The trigger is hidden at this width; park the focus somewhere sane.
      document.getElementById('threeCanvas')?.focus();
    }
  }

  function isOpen(name) {
    return app?.classList.contains(panels[name].flag);
  }

  document.getElementById('systemsOpen')?.addEventListener('click', () => apply('systems', !isOpen('systems'), { moveFocus: true }));
  document.getElementById('systemsToggle')?.addEventListener('click', () => apply('systems', false, { moveFocus: true }));
  document.getElementById('infoOpen')?.addEventListener('click', () => apply('info', !isOpen('info'), { moveFocus: true }));
  document.getElementById('infoToggle')?.addEventListener('click', () => apply('info', false, { moveFocus: true }));

  // Escape closes whichever panel the focus is in.
  Object.entries(panels).forEach(([name, panel]) => {
    panel.el?.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen(name)) apply(name, false, { moveFocus: true });
    });
  });

  // Crossing the breakpoint must not leave a drawer offset stuck on a panel
  // that is now part of the desktop layout.
  drawerQuery.addEventListener('change', () => {
    apply('systems', isOpen('systems'));
    apply('info', isOpen('info'));
  });

  // On a phone the systems drawer starts closed; on desktop it is a column.
  apply('systems', false);
  apply('info', false);
}