// Keyboard and screen-reader plumbing shared by the panels and the modal.
//
// Two rules drive everything here: something that is off screen must not be
// reachable by Tab, and whatever opened a surface gets the focus back when it
// closes.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function focusableWithin(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(element => {
    return element.offsetParent !== null || element === document.activeElement;
  });
}

export function shouldSetInert(isDrawer, isOpen) {
  return isDrawer && !isOpen;
}

// A closed drawer is still in the DOM; `inert` is what keeps Tab out of it.
export function setInert(element, inert) {
  if (!element) return;

  if (inert) {
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
  } else {
    element.removeAttribute('inert');
    element.removeAttribute('aria-hidden');
  }
}

export function focusFirst(container) {
  const [first] = focusableWithin(container);
  if (first) first.focus();
  return Boolean(first);
}

// Keeps Tab inside `container` until released. Returns the release function.
export function trapFocus(container, { onEscape, returnFocusTo } = {}) {
  const previouslyFocused = returnFocusTo || document.activeElement;

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape?.();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = focusableWithin(container);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener('keydown', onKeydown);
  focusFirst(container);

  return function release({ restoreFocus = true } = {}) {
    container.removeEventListener('keydown', onKeydown);
    if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
  };
}

// Roving tabindex: one stop for the whole list, arrows move within it. Without
// this a 669-row system would put 669 stops in the tab order.
export function rovingList(container, { itemSelector, onActivate }) {
  function items() {
    return [...container.querySelectorAll(itemSelector)];
  }

  function focusItem(list, index) {
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    const target = list[clamped];
    if (!target) return;

    list.forEach(item => item.setAttribute('tabindex', item === target ? '0' : '-1'));
    target.focus();
  }

  container.addEventListener('keydown', event => {
    const current = event.target.closest(itemSelector);
    if (!current) return;

    const list = items();
    const index = list.indexOf(current);

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusItem(list, index + 1); break;
      case 'ArrowUp': event.preventDefault(); focusItem(list, index - 1); break;
      case 'Home': event.preventDefault(); focusItem(list, 0); break;
      case 'End': event.preventDefault(); focusItem(list, list.length - 1); break;
      case 'Enter':
      case ' ':
        // Only when the row itself has the focus. A checkbox or an action
        // button inside it handles its own activation, and taking the key
        // here left every one of them inert from the keyboard.
        if (event.target !== current) break;
        event.preventDefault();
        onActivate?.(current);
        break;
      default:
    }
  });

  // Only the first row is a tab stop; the rest are reached with the arrows.
  return function refresh() {
    const list = items();
    const alreadySet = list.some(item => item.getAttribute('tabindex') === '0');
    if (!alreadySet && list.length) {
      list.forEach((item, i) => item.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    }
  };
}
