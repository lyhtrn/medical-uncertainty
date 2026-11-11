// Selection - Raycasting, highlighting, and selection management
import * as THREE from 'three';
import { state, setSelectedPart, getStructureInfo, translate, getMedicalStatus, MEDICAL_STATUSES } from '../state/store.js';
import { getMeshRegistry, getPickTargets, getStructure } from './loadModel.js';
import { highlightMesh, clearHighlight, ghostAllExcept, clearGhost, isolatePart, hidePart, setPartMedicalStatus } from './visibility.js';
import { focusOnMesh } from './camera.js';
import { showCallout, hideCallout } from '../ui/callout.js';
import { loadDefinitions } from '../data/anatomy.js';
import { confirmedFindingsForPart } from '../state/documentReview.js';

// Distinguishes a tap from the end of an orbit gesture.
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_DURATION_MS = 300;
// The mouse gets a smaller threshold: a deliberate click barely moves, but an
// orbit drag is unbounded, and there is no duration limit because rotating
// slowly is still rotating.
const CLICK_MAX_MOVE_PX = 5;

let raycaster = new THREE.Raycaster();
// With a BVH in place, stopping at the nearest hit is much cheaper than
// sorting every intersection along the ray.
raycaster.firstHitOnly = true;
let mouse = new THREE.Vector2();
let lastSelectedMesh = null;
let lastIntersectedMesh = null;
let touchStart = null;
let pointerDown = null;
let hoverEvent = null;
let hoverFrame = null;
let orbiting = false;

// Raycasting against the model roots tests each subtree once; the registry
// holds nested structures, so it would test shared geometry repeatedly.
function pickAt(event, viewer) {
  getEventPosition(event, viewer.canvas);
  raycaster.setFromCamera(mouse, viewer.camera);

  const intersects = raycaster.intersectObjects(getPickTargets(), true);
  for (const hit of intersects) {
    if (!hit.object.visible) continue;
    const structure = findParentMesh(hit.object);
    if (structure) return structure;
  }
  return null;
}

export function initSelection(viewer) {
  const { canvas, controls } = viewer;

  // Picking during an orbit is wasted work: the pointer is dragging, not
  // pointing at anything.
  controls?.addEventListener('start', () => { orbiting = true; });
  controls?.addEventListener('end', () => { orbiting = false; });

  // Mouse events
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('pointermove', onPointerMove);

  // Touch events for mobile
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchend', onTouchEnd);
  };
}

function getEventPosition(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.clientX || (event.touches && event.touches[0].clientX) || 0;
  const clientY = event.clientY || (event.touches && event.touches[0].clientY) || 0;

  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

// A rotate gesture ends with a click event wherever the pointer happens to be,
// so without this every attempt to change the angle selected whatever was under
// the cursor. Touch had this discrimination from the start; the mouse did not.
function onPointerDown(event) {
  // Only the primary button produces a click. Recording a right-press would
  // leave stale coordinates behind — no click ever arrives to clear them — and
  // the next genuine click would be measured against them and dismissed as a
  // drag.
  if (event.button !== 0) {
    pointerDown = null;
    return;
  }
  pointerDown = { x: event.clientX, y: event.clientY, type: event.pointerType };
}

function onPointerCancel() {
  pointerDown = null;
}

function wasDrag(event, gesture) {
  if (!gesture) return false;

  const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
  return moved > CLICK_MAX_MOVE_PX;
}

function onClick(event) {
  const viewer = state.viewer;
  if (!viewer) return;

  const gesture = pointerDown;
  pointerDown = null;

  // Touch selects from the tap handler; the click the browser synthesises
  // afterwards would select a second time.
  if (gesture && gesture.type !== 'mouse') return;
  if (wasDrag(event, gesture)) return;

  const structure = pickAt(event, viewer);
  if (structure) {
    selectPart(structure.userData.partId, viewer);
  } else {
    // Clicked on background - deselect
    deselectPart();
  }
}

function onDoubleClick(event) {
  const viewer = state.viewer;
  if (!viewer) return;

  const structure = pickAt(event, viewer);
  if (structure) {
    focusOnMesh(structure, viewer, true);
  }
}

// Pointer events fire far more often than frames; coalescing to one pick per
// animation frame keeps a full-scene raycast off the critical path.
function onPointerMove(event) {
  // Touch drives selection through the tap handler; hovering with a finger is
  // not a gesture.
  if (event.pointerType && event.pointerType !== 'mouse') return;
  if (orbiting) return;

  hoverEvent = { clientX: event.clientX, clientY: event.clientY };
  if (hoverFrame) return;

  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = null;
    const pending = hoverEvent;
    hoverEvent = null;
    if (pending) processHover(pending);
  });
}

function processHover(event) {
  const viewer = state.viewer;
  if (!viewer) return;

  const structure = pickAt(event, viewer);

  if (structure === lastIntersectedMesh) return;

  // Clear previous hover
  if (lastIntersectedMesh && lastIntersectedMesh !== lastSelectedMesh) {
    clearHighlight(lastIntersectedMesh.userData.partId);
  }

  if (structure) {
    if (structure !== lastSelectedMesh) {
      highlightMesh(structure.userData.partId, 0xffdf5d, 0.3);
    }
    lastIntersectedMesh = structure;
    viewer.canvas.style.cursor = 'pointer';
  } else {
    lastIntersectedMesh = null;
    viewer.canvas.style.cursor = 'grab';
  }

  // Hovering only mutates materials, and frames are drawn on demand: over an
  // idle scene the tint would sit in the material until something else asked
  // for a frame. Everything above changed what the next one looks like.
  viewer.render();
}

function onTouchStart(event) {
  if (event.touches.length !== 1) {
    // Pinch or two-finger pan belongs to OrbitControls.
    touchStart = null;
    return;
  }

  const touch = event.touches[0];
  touchStart = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
}

function onTouchEnd(event) {
  const start = touchStart;
  touchStart = null;

  if (!start || event.changedTouches.length !== 1) return;

  const touch = event.changedTouches[0];
  const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
  const elapsed = event.timeStamp - start.time;

  // Only a short, stationary touch is a selection; anything else was an orbit.
  if (moved > TAP_MAX_MOVE_PX || elapsed > TAP_MAX_DURATION_MS) return;

  const viewer = state.viewer;
  if (!viewer) return;

  const structure = pickAt({ clientX: touch.clientX, clientY: touch.clientY }, viewer);
  if (structure) {
    selectPart(structure.userData.partId, viewer);
  } else {
    deselectPart();
  }
}

// A structure exported with several materials becomes a group of meshes, so the
// raycast hit may be a child; the partId lives on the node above it.
function findParentMesh(object) {
  let current = object;
  while (current) {
    if (current.userData?.partId) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function selectPart(partId, viewer) {
  // Clear previous selection highlight
  if (lastSelectedMesh) {
    clearHighlight(lastSelectedMesh.userData.partId);
  }

  const mesh = getMeshRegistry().get(partId);
  if (!mesh) return;

  // Get structure info
  const info = getStructureInfo(partId);
  const partData = {
    id: partId,
    meshName: mesh.userData.originalName || mesh.name,
    displayName: info?.name?.[state.language] || info?.name?.en || partId,
    system: info?.system || mesh.userData.system || 'unknown',
    region: info?.region || 'unknown',
    info: info
  };

  // Highlight selected mesh
  highlightMesh(partId, 0xffdf5d, 0.8);
  lastSelectedMesh = mesh;

  // Everything else drops to a ghost, so an occluded structure is still
  // readable, and the camera eases in to answer "where is it".
  ghostAllExcept(partId);

  showCallout(partId, partData.displayName, {
    isolate: id => isolatePart(id),
    hide: id => { hidePart(id); deselectPart(); },
    close: () => deselectPart()
  });

  // Update part state
  getMeshRegistry().forEach((m, id) => {
    const partState = state.partStates.get(id);
    if (partState) {
      partState.selected = (id === partId);
    }
  });

  // Notify state change
  setSelectedPart(partData);

  // Show info panel
  showInfoPanel(partData);

  // Show footer actions
  showFooterActions();
}

export function deselectPart() {
  if (lastSelectedMesh) {
    clearHighlight(lastSelectedMesh.userData.partId);
    lastSelectedMesh = null;
  }

  clearGhost();
  hideCallout();

  // Clear selection state
  getMeshRegistry().forEach((m, id) => {
    const partState = state.partStates.get(id);
    if (partState) {
      partState.selected = false;
    }
  });

  setSelectedPart(null);
  hideInfoPanel();
  hideFooterActions();
}

function showInfoPanel(partData) {
  const placeholder = document.querySelector('.info-placeholder');
  const structureInfo = document.getElementById('structureInfo');

  if (placeholder) placeholder.style.display = 'none';
  if (structureInfo) structureInfo.classList.remove('hidden');

  const lang = state.language || 'en';
  const info = partData.info || {};

  const name = info.name?.[lang] || info.name?.en || partData.displayName;
  const systemLabel = getSystemLabel(info.system || partData.system, lang);

  const sideKey = info.side === 'left' ? 'side_left' : info.side === 'right' ? 'side_right' : null;

  structureInfo.innerHTML = `
    <div class="structure-header">
      <div class="structure-title">
        <h3>${escapeHtml(name)}</h3>
        ${info.latinName ? `<span class="structure-latin">${escapeHtml(info.latinName)}</span>` : ''}
        <div class="structure-tags">
          <span class="structure-system">${escapeHtml(systemLabel)}</span>
          ${sideKey ? `<span class="structure-tag">${escapeHtml(translate(sideKey, lang))}</span>` : ''}
          ${info.official === false ? `<span class="structure-tag warn" title="${escapeHtml(translate('non_official_hint', lang))}">${escapeHtml(translate('non_official', lang))}</span>` : ''}
        </div>
      </div>
    </div>
    <section class="medical-status" aria-labelledby="medicalStatusTitle">
      <div class="medical-status-heading">
        <h4 id="medicalStatusTitle">Medical status</h4>
        <span data-current-status>${escapeHtml(MEDICAL_STATUSES.find(status => status.id === getMedicalStatus(partData.id))?.label || 'Not assigned')}</span>
      </div>
      <div class="medical-status-options" role="group" aria-label="Assign a medical status">
        ${MEDICAL_STATUSES.map(status => `
          <button type="button" class="medical-status-option" data-medical-status="${status.id}" aria-pressed="${getMedicalStatus(partData.id) === status.id}" style="--status-color: ${status.color}">
            <span class="medical-status-swatch" aria-hidden="true"></span>
            <span>${escapeHtml(status.label)}</span>
          </button>
        `).join('')}
      </div>
    </section>
    ${confirmedEvidenceMarkup(partData.id)}
    ${relationMarkup(partData.id, lang)}
    <div class="structure-description" data-definition>${escapeHtml(translate('loading_definition', lang))}</div>
  `;

  structureInfo.querySelectorAll('[data-relation]').forEach(link => {
    link.addEventListener('click', () => selectPartById(link.dataset.relation, state.viewer));
  });

  structureInfo.querySelectorAll('[data-medical-status]').forEach(button => {
    button.addEventListener('click', () => {
      const statusId = button.dataset.medicalStatus;
      if (!setPartMedicalStatus(partData.id, statusId)) return;

      structureInfo.querySelectorAll('[data-medical-status]').forEach(option => {
        option.setAttribute('aria-pressed', String(option.dataset.medicalStatus === statusId));
      });
      structureInfo.querySelector('[data-current-status]').textContent = MEDICAL_STATUSES.find(status => status.id === statusId)?.label || 'Not assigned';
    });
  });

  fillDefinition(partData, lang);
}

function confirmedEvidenceMarkup(partId) {
  const findings = confirmedFindingsForPart(partId);
  if (!findings.length) return '';

  return `
    <section class="confirmed-evidence" aria-labelledby="confirmedEvidenceTitle">
      <h4 id="confirmedEvidenceTitle">Confirmed document evidence</h4>
      ${findings.map(finding => `
        <article>
          <small>${escapeHtml(finding.document?.name || 'Document')} · ${escapeHtml(finding.document?.date || 'Date not detected')}</small>
          <blockquote>${escapeHtml(finding.excerpt)}</blockquote>
        </article>
      `).join('')}
    </section>
  `;
}

// Z-Anatomy's collections are flat, so there is no tree to show — but the glTF
// graph does record which structure contains which, and that relation is worth
// surfacing: 868 of the 2827 structures sit inside another one.
function relationMarkup(partId, lang) {
  const entry = getStructure(partId);
  if (!entry) return '';

  const label = id => {
    const info = getStructureInfo(id);
    return escapeHtml(info?.name?.[lang] || info?.name?.en || id);
  };

  const parts = [];

  if (entry.parentId) {
    parts.push(`
      <div class="relation">
        <span class="relation-label">${escapeHtml(translate('part_of', lang))}</span>
        <button type="button" class="relation-link" data-relation="${escapeHtml(entry.parentId)}">${label(entry.parentId)}</button>
      </div>
    `);
  }

  if (entry.childIds.length) {
    parts.push(`
      <div class="relation">
        <span class="relation-label">${escapeHtml(translate('contains', lang))}</span>
        <span class="relation-links">
          ${entry.childIds.slice(0, 8).map(id => `<button type="button" class="relation-link" data-relation="${escapeHtml(id)}">${label(id)}</button>`).join('')}
          ${entry.childIds.length > 8 ? `<span class="relation-more">+${entry.childIds.length - 8}</span>` : ''}
        </span>
      </div>
    `);
  }

  return parts.length ? `<div class="structure-relations">${parts.join('')}</div>` : '';
}

// Definitions arrive from a separate file that is still downloading on a cold
// start, so the panel renders first and fills in when the text is available.
async function fillDefinition(partData, lang) {
  const definitions = await loadDefinitions();
  const target = document.querySelector('#structureInfo [data-definition]');

  // The user may have selected something else in the meantime.
  if (!target || state.selectedPart?.id !== partData.id) return;

  const base = partData.info?.baseName || partData.id;
  const text = definitions[base];

  if (!text) {
    target.classList.add('is-empty');
    target.textContent = translate('no_definition', lang);
    return;
  }

  target.classList.remove('is-empty');
  target.innerHTML = `
    ${escapeHtml(text)}
    <a class="definition-source" href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(base)}"
       target="_blank" rel="noopener">${escapeHtml(translate('read_more', lang))}</a>
  `;
}

function hideInfoPanel() {
  const placeholder = document.querySelector('.info-placeholder');
  const structureInfo = document.getElementById('structureInfo');

  if (placeholder) placeholder.style.display = 'flex';
  if (structureInfo) structureInfo.classList.add('hidden');
}

function showFooterActions() {
  const footer = document.getElementById('footerBar');
  if (footer) footer.style.display = 'flex';
}

function hideFooterActions() {
  const footer = document.getElementById('footerBar');
  if (footer) footer.style.display = 'none';
}

// System labels come from the shared dictionary; there used to be a private
// copy here that drifted from the one in the sidebar.
function getSystemLabel(system, lang) {
  const label = translate(`system_${system}`, lang);
  return label === `system_${system}` ? system : label;
}


function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function getSelectedPart() {
  return state.selectedPart;
}

export function selectPartById(partId, viewer) {
  const mesh = getMeshRegistry().get(partId);
  if (mesh) {
    selectPart(partId, viewer);
    return true;
  }
  return false;
}