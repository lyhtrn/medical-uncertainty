const initializedRoots = new WeakSet();

export function initInfoPanelTabs(root = document) {
  if (initializedRoots.has(root)) return true;

  const tabs = [...root.querySelectorAll('[data-info-tab]')];
  const panels = [...root.querySelectorAll('[data-info-panel]')];
  if (!tabs.length || !panels.length) return false;

  function activate(tab, focus = false) {
    tabs.forEach(item => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    panels.forEach(panel => {
      panel.hidden = panel.dataset.infoPanel !== tab.dataset.infoTab;
    });
    if (focus) tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      activate(tabs[nextIndex], true);
    });
  });

  initializedRoots.add(root);
  activate(tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
  return true;
}