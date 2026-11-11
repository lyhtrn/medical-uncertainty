import { describe, expect, it } from 'vitest';
import { activateInfoPanelTab, initInfoPanelTabs, initInfoPanelTabsWhenReady } from '../src/ui/panelTabs.js';
import { shouldSetInert } from '../src/ui/focus.js';

function makeTab(id, selected, root) {
  const handlers = {};
  return {
    dataset: { infoTab: id },
    attributes: { 'aria-selected': String(selected) },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    click() {
      if (!root.inert) handlers.click();
    },
    keydown(event) { handlers.keydown(event); },
    handlers
  };
}

function makePanel(id, hidden) {
  return { dataset: { infoPanel: id }, hidden };
}

function makeRoot(tabs, panels, readyState = 'interactive') {
  let domReadyHandler;
  return {
    readyState,
    inert: false,
    querySelectorAll(selector) {
      return selector === '[data-info-tab]' ? tabs : panels;
    },
    addEventListener(type, handler) {
      if (type === 'DOMContentLoaded') domReadyHandler = handler;
    },
    fireDomReady() {
      this.readyState = 'interactive';
      domReadyHandler?.();
    }
  };
}

describe('information panel tabs', () => {
  it('initializes after DOM ready and switches visible content when both tabs are clicked', () => {
    const root = makeRoot([], [], 'loading');
    const structureTab = makeTab('structure', true, root);
    const documentsTab = makeTab('documents', false, root);
    const structurePanel = makePanel('structure', false);
    const documentsPanel = makePanel('documents', true);
    root.querySelectorAll = selector => selector === '[data-info-tab]'
      ? [structureTab, documentsTab]
      : [structurePanel, documentsPanel];

    root.inert = shouldSetInert(false, false);
    initInfoPanelTabsWhenReady(root);
    expect(documentsPanel.hidden).toBe(true);
    root.fireDomReady();

    documentsTab.click();
    expect(documentsPanel.hidden).toBe(false);
    expect(structurePanel.hidden).toBe(true);
    expect(documentsTab.getAttribute('aria-selected')).toBe('true');

    structureTab.click();
    expect(structurePanel.hidden).toBe(false);
    expect(documentsPanel.hidden).toBe(true);
    expect(structureTab.getAttribute('aria-selected')).toBe('true');
    expect(shouldSetInert(true, false)).toBe(true);
    expect(shouldSetInert(true, true)).toBe(false);
  });

  it('supports arrow-key navigation between tabs', () => {
    const structureTab = makeTab('structure', true);
    const documentsTab = makeTab('documents', false);
    const structurePanel = makePanel('structure', false);
    const documentsPanel = makePanel('documents', true);
    initInfoPanelTabs(makeRoot([structureTab, documentsTab], [structurePanel, documentsPanel]));

    let prevented = false;
    structureTab.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });

    expect(prevented).toBe(true);
    expect(documentsPanel.hidden).toBe(false);
    expect(documentsTab.focused).toBe(true);
  });

  it('returns to Structure when an anatomical structure is selected', () => {
    const structureTab = makeTab('structure', true);
    const documentsTab = makeTab('documents', false);
    const structurePanel = makePanel('structure', false);
    const documentsPanel = makePanel('documents', true);
    const root = makeRoot([structureTab, documentsTab], [structurePanel, documentsPanel]);
    initInfoPanelTabs(root);
    activateInfoPanelTab('documents', root);

    expect(activateInfoPanelTab('structure', root)).toBe(true);
    expect(structurePanel.hidden).toBe(false);
    expect(documentsPanel.hidden).toBe(true);
    expect(structureTab.getAttribute('aria-selected')).toBe('true');
  });
});