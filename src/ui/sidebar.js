// Sidebar UI - Systems panel with collapsible groups
import { state, subscribe, getSystemParts, getStructureInfo, setLanguage, translate } from '../state/store.js';
import { getMeshRegistry, loadModel, unloadSystem } from '../viewer/loadModel.js';
import { ANATOMY_LAYERS, BODY_REGIONS } from '../data/anatomy.js';
import { hideSystem, showSystem, hidePart, isolatePart, setPartTransparency, restoreAllParts, getSystemVisibilityState } from '../viewer/visibility.js';
import { selectPartById, deselectPart } from '../viewer/selection.js';
import { setView, resetView, focusOnRegion } from '../viewer/camera.js';
import { loadAllData, searchStructures } from '../utils/dataLoader.js';
import { initDepthSlider, resetDepthSlider } from './depthSlider.js';
import { setInert, focusFirst, trapFocus } from './focus.js';

const SIDEBAR_COPY = {
  en: {
    heading: 'Explore Anatomy',
    searchLabel: 'Search structures',
    searchPlaceholder: 'Search anatomical structures...',
    regionLabel: 'Body region',
    reset: 'Reset View',
    unavailable: 'Not available in this atlas',
    loadError: 'Could not load this layer. Please try again.',
    collapse: 'Collapse anatomy sidebar',
    expand: 'Expand anatomy sidebar'
  },
  it: {
    heading: 'Esplora l’anatomia',
    searchLabel: 'Cerca strutture',
    searchPlaceholder: 'Cerca strutture anatomiche...',
    regionLabel: 'Regione del corpo',
    reset: 'Reimposta vista',
    unavailable: 'Non disponibile in questo atlante',
    loadError: 'Impossibile caricare questo livello. Riprova.',
    collapse: 'Comprimi il pannello anatomico',
    expand: 'Espandi il pannello anatomico'
  }
};

let selectedRegion = 'full';

export function initSystemsSidebar() {
  const container = document.getElementById('systemsList');
  if (!container) return;

  const lang = state.language || 'en';
  const copy = SIDEBAR_COPY[lang] || SIDEBAR_COPY.en;

  container.innerHTML = `
    <fieldset class="anatomy-layers" aria-label="${escapeHtml(lang === 'it' ? 'Livelli anatomici' : 'Anatomical layers')}">
      ${ANATOMY_LAYERS.map(layer => {
        const available = availableSystemsForLayer(layer).length > 0;
        const label = layer.label[lang] || layer.label.en;
        return `
          <div class="anatomy-layer-option" data-layer-option="${layer.id}">
            <label class="anatomy-layer" data-layer-label="${layer.id}">
              <input type="checkbox" data-layer-toggle="${layer.id}" aria-label="${escapeHtml(label)}" ${available ? '' : 'disabled'}>
              <span class="anatomy-layer-name">${escapeHtml(label)}</span>
              ${available ? '' : `<span class="layer-unavailable">${escapeHtml(copy.unavailable)}</span>`}
            </label>
            <span class="layer-error" data-layer-error="${layer.id}" role="alert" hidden>${escapeHtml(copy.loadError)}</span>
          </div>
        `;
      }).join('')}
    </fieldset>
    <div class="anatomy-region">
      <label for="bodyRegionSelect">${escapeHtml(copy.regionLabel)}</label>
      <select id="bodyRegionSelect">
        ${BODY_REGIONS.map(region => `<option value="${region.id}" ${selectedRegion === region.id ? 'selected' : ''}>${escapeHtml(region.label[lang] || region.label.en)}</option>`).join('')}
      </select>
    </div>
    <button type="button" class="anatomy-reset" id="sidebarResetBtn">${escapeHtml(copy.reset)}</button>
  `;

  syncLayerControls();

  container.querySelectorAll('[data-layer-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const layer = ANATOMY_LAYERS.find(entry => entry.id === input.dataset.layerToggle);
      const systems = availableSystemsForLayer(layer);
      const label = input.closest('.anatomy-layer');
      const error = container.querySelector(`[data-layer-error="${layer.id}"]`);
      error.hidden = true;
      resetDepthSlider();

      if (!input.checked) {
        systems.forEach(systemId => {
          hideSystem(systemId);
          scheduleUnload(systemId, null);
        });
        return;
      }

      label.classList.add('loading');
      label.setAttribute('aria-busy', 'true');
      input.disabled = true;
      try {
        for (const systemId of systems) {
          cancelUnload(systemId);
          await ensureSystemLoaded(systemId);
          showSystem(systemId);
        }
      } catch {
        error.hidden = false;
      } finally {
        label.classList.remove('loading');
        label.removeAttribute('aria-busy');
        input.disabled = false;
        syncLayerControls();
      }
    });
  });

  container.querySelector('#bodyRegionSelect')?.addEventListener('change', event => {
    selectedRegion = event.target.value;
    focusOnRegion(selectedRegion, state.viewer);
  });

  container.querySelector('#sidebarResetBtn')?.addEventListener('click', () => {
    selectedRegion = 'full';
    const regionSelect = container.querySelector('#bodyRegionSelect');
    if (regionSelect) regionSelect.value = selectedRegion;
    resetView(state.viewer);
  });
}

function availableSystemsForLayer(layer) {
  return (layer?.systems || []).filter(systemId => getSystemParts(systemId).length > 0);
}

function layerLabelForSystem(systemId, lang) {
  const layer = ANATOMY_LAYERS.find(entry => entry.systems.includes(systemId));
  return layer?.label[lang] || layer?.label.en || '';
}

function syncLayerControls() {
  const container = document.getElementById('systemsList');
  if (!container) return;

  ANATOMY_LAYERS.forEach(layer => {
    const input = container.querySelector(`[data-layer-toggle="${layer.id}"]`);
    if (!input || input.disabled) return;

    const systems = availableSystemsForLayer(layer);
    const visibleCount = systems.filter(systemId =>
      state.loadedSystems.includes(systemId) && getSystemVisibilityState(systemId).visible
    ).length;
    input.checked = systems.length > 0 && visibleCount === systems.length;
    input.indeterminate = visibleCount > 0 && visibleCount < systems.length;
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

    const layer = ANATOMY_LAYERS.find(entry => entry.systems.includes(systemId));
    const loaded = state.loadedSystems.includes(systemId);
    // Ask the scene rather than the checkbox: the checkbox is a rendering of
    // this answer and can be older than it. A system with anything still on
    // screen is left alone, because showSystem() would undo every structure
    // the user hid or faded inside it.
    const hidden = loaded && !getSystemVisibilityState(systemId).visible;

    if (!loaded || hidden) {
      try {
        if (!loaded) await ensureSystemLoaded(systemId);
        showSystem(systemId);
      } catch {
        const error = layer && document.querySelector(`[data-layer-error="${layer.id}"]`);
        if (error) error.hidden = false;
        return false;
      }
    }
  }

  syncLayerControls();
  return selectPartById(partId, state.viewer);
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

async function ensureSystemLoaded(systemId) {
  if (state.loadedSystems.includes(systemId)) return;

  if (!pendingSystemLoads.has(systemId)) {
    const promise = loadModel(systemId, state.viewer)
      .catch(error => {
        console.error(`[sidebar] Failed to load ${systemId}:`, error);
        const layerId = ANATOMY_LAYERS.find(layer => layer.systems.includes(systemId))?.id;
        const message = layerId && document.querySelector(`[data-layer-error="${layerId}"]`);
        if (message) message.hidden = false;
        throw error;
      })
      .finally(() => {
        pendingSystemLoads.delete(systemId);
      });

    pendingSystemLoads.set(systemId, promise);
  }

  await pendingSystemLoads.get(systemId);
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
      closeResults();
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
            <span class="result-system">${escapeHtml(layerLabelForSystem(row.system, lang))}</span>
          </div>
        `;
      }).join('');

      results.classList.add('show');

      const choose = async (partId) => {
        input.value = '';
        results.innerHTML = '';
        closeResults();
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
      closeResults();
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
subscribe('partStates', syncLayerControls);
subscribe('systemShown', syncLayerControls);
subscribe('systemHidden', syncLayerControls);
subscribe('allPartsRestored', syncLayerControls);

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
  const copy = SIDEBAR_COPY[lang] || SIDEBAR_COPY.en;

  // Assistive technology takes pronunciation and language from the document,
  // not from the picker in the header.
  document.documentElement.lang = lang;

  // Update placeholders
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.placeholder = copy.searchPlaceholder;
    searchInput.setAttribute('aria-label', copy.searchLabel);
  }
  const searchLabel = document.getElementById('sidebarSearchLabel');
  if (searchLabel) searchLabel.textContent = copy.searchLabel;
  const sidebarHeading = document.querySelector('.sidebar-systems .sidebar-header h2');
  if (sidebarHeading) sidebarHeading.textContent = copy.heading;
  const collapseButton = document.getElementById('sidebarCollapse');
  if (collapseButton) {
    collapseButton.setAttribute('aria-label', document.getElementById('app')?.classList.contains('anatomy-collapsed') ? copy.expand : copy.collapse);
  }

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
  updateUIText(state.language);
  initSystemsSidebar();
  initSidebarCollapse();
  initToolbar(viewer);
  initFooterActions(viewer);
  initHelpModal();
  initLanguageSelector();
  initSearch();
  initDrawers();
  initDepthSlider();
}

function initSidebarCollapse() {
  const app = document.getElementById('app');
  const button = document.getElementById('sidebarCollapse');
  const content = document.getElementById('systemsContent');
  const desktopQuery = window.matchMedia('(min-width: 1025px)');
  if (!app || !button || !content) return;

  function setCollapsed(collapsed) {
    const isCollapsed = desktopQuery.matches && collapsed;
    app.classList.toggle('anatomy-collapsed', isCollapsed);
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', SIDEBAR_COPY[state.language]?.[isCollapsed ? 'expand' : 'collapse'] || SIDEBAR_COPY.en[isCollapsed ? 'expand' : 'collapse']);
    setInert(content, isCollapsed);
  }

  button.addEventListener('click', () => {
    setCollapsed(!app.classList.contains('anatomy-collapsed'));
  });
  desktopQuery.addEventListener('change', () => setCollapsed(false));
  setCollapsed(false);
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