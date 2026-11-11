import { describe, expect, it } from 'vitest';
import { initInfoPanelTabs } from '../src/ui/panelTabs.js';

function makeTab(id, selected) {
  const handlers = {};
  return {
    dataset: { infoTab: id },
    attributes: { 'aria-selected': String(selected) },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    click() { handlers.click(); },
    keydown(event) { handlers.keydown(event); },
    handlers
  };
}

function makePanel(id, hidden) {
  return { dataset: { infoPanel: id }, hidden };
}

function makeRoot(tabs, panels) {
  return {
    querySelectorAll(selector) {
      return selector === '[data-info-tab]' ? tabs : panels;
    }
  };
}

describe('information panel tabs', () => {
  it('switches to Documents when clicked and returns to Structure when clicked', () => {
    const structureTab = makeTab('structure', true);
    const documentsTab = makeTab('documents', false);
    const structurePanel = makePanel('structure', false);
    const documentsPanel = makePanel('documents', true);
    const root = makeRoot([structureTab, documentsTab], [structurePanel, documentsPanel]);

    expect(initInfoPanelTabs(root)).toBe(true);

    documentsTab.click();
    initInfoPanelTabs(root);
    expect(documentsPanel.hidden).toBe(false);
    expect(structurePanel.hidden).toBe(true);
    expect(documentsTab.getAttribute('aria-selected')).toBe('true');

    structureTab.click();
    expect(structurePanel.hidden).toBe(false);
    expect(documentsPanel.hidden).toBe(true);
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
});