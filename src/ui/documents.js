import { BODY_REGIONS, FINDING_CATEGORIES, extractFindings, isSupportedDocumentName, parseReportDate, resolveAnatomicalMention } from '../documents/extractor.js';
import { loadDocumentReview, saveDocumentReview } from '../state/documentReview.js';
import { getMedicalStatus, MEDICAL_STATUSES, setMedicalStatus, state } from '../state/store.js';
import { selectStructureAnywhere } from './sidebar.js';
import { selectPartById } from '../viewer/selection.js';
import { getMeshRegistry } from '../viewer/loadModel.js';
import { setPartMedicalStatus } from '../viewer/visibility.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SAMPLE_REPORT = `FICTIONAL SAMPLE REPORT - NOT A REAL PATIENT
Report date: 2026-03-14
Patient: Riley Example (fictional)

The patient reports intermittent left knee pain after a long walk.
An X-ray of the left knee was requested; results are pending.
Management plan: rest, use a cold pack on the left knee, and arrange follow-up in two weeks.`;

export function initDocumentReview(viewer, partsData) {
  const panel = document.getElementById('documentsPanel');
  const cards = document.getElementById('documentFindings');
  const list = document.getElementById('reviewDocuments');
  const statusMessage = document.getElementById('documentStatus');
  const input = document.getElementById('documentInput');
  const dropzone = document.getElementById('documentDropzone');
  const regionOverlay = document.getElementById('regionEvidenceOverlay');
  if (!panel || !cards || !input || !dropzone) return;

  let review = loadDocumentReview();
  document.getElementById('sampleReportPreview').textContent = SAMPLE_REPORT;

  document.querySelectorAll('[data-info-tab]').forEach(tab => {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.infoTab));
  });

  input.addEventListener('change', async () => {
    for (const file of input.files || []) await readFile(file);
    input.value = '';
  });

  dropzone.addEventListener('dragover', event => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
  dropzone.addEventListener('dragleave', event => {
    if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
  });
  dropzone.addEventListener('drop', async event => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    for (const file of event.dataTransfer?.files || []) await readFile(file);
  });

  document.getElementById('loadSampleReport')?.addEventListener('click', () => {
    addReport({ name: 'Fictional follow-up note.txt', text: SAMPLE_REPORT, sample: true });
  });

  cards.addEventListener('click', async event => {
    const button = event.target.closest('[data-review-action]');
    if (!button) return;
    const finding = review.findings.find(item => item.id === button.closest('[data-finding]')?.dataset.finding);
    if (!finding) return;

    if (button.dataset.reviewAction === 'confirm') await confirmFinding(finding);
    if (button.dataset.reviewAction === 'reject') await rejectFinding(finding);
    if (button.dataset.reviewAction === 'edit') {
      const card = button.closest('[data-finding]');
      card.querySelector('[data-edit-form]').hidden = false;
      card.querySelector('[data-edit-location]')?.focus();
    }
    if (button.dataset.reviewAction === 'cancel-edit') render();
  });

  cards.addEventListener('change', event => {
    const targetKind = event.target.closest('[data-target-kind]');
    if (!targetKind) return;
    const form = targetKind.closest('[data-edit-form]');
    const isRegion = targetKind.value === 'region';
    form.querySelector('[data-edit-region-wrap]').hidden = !isRegion;
    form.querySelector('[data-edit-location-wrap]').hidden = targetKind.value !== 'structure';
  });

  cards.addEventListener('submit', async event => {
    const form = event.target.closest('[data-edit-form]');
    if (!form) return;
    event.preventDefault();

    const finding = review.findings.find(item => item.id === form.closest('[data-finding]')?.dataset.finding);
    if (!finding) return;

    const kind = form.querySelector('[data-target-kind]').value;
    let location = null;
    if (kind === 'structure') {
      location = resolveAnatomicalMention(form.querySelector('[data-edit-location]').value, partsData);
      if (location?.type !== 'structure') {
        setMessage('Enter a structure name or stable mesh ID found in the anatomy atlas.');
        return;
      }
    } else if (kind === 'region') {
      const region = BODY_REGIONS.find(item => item.id === form.querySelector('[data-edit-region]').value);
      if (!region) return;
      const side = form.querySelector('[data-edit-region-side]').value || null;
      location = {
        type: 'region',
        id: region.id,
        side,
        label: side ? `${side[0].toUpperCase()}${side.slice(1)} ${region.label.toLowerCase()}` : region.label
      };
    }

    const previousPartIds = partIdsOf(finding.location);
    if (finding.decision === 'confirmed') captureBaselines(location);
    finding.category = form.querySelector('[data-edit-category]').value;
    finding.statusId = form.querySelector('[data-edit-status]').value;
    finding.location = location;
    persist();

    if (finding.decision === 'confirmed') {
      await syncPartStatuses([...previousPartIds, ...partIdsOf(location)]);
      const nextPartId = partIdsOf(location)[0];
      if (nextPartId) await revealConfirmedPart(nextPartId, location);
    }
    render();
  });

  function setActiveTab(tabId) {
    document.querySelectorAll('[data-info-tab]').forEach(tab => {
      const active = tab.dataset.infoTab === tabId;
      tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-info-panel]').forEach(content => {
      content.hidden = content.dataset.infoPanel !== tabId;
    });
  }

  async function readFile(file) {
    if (!isSupportedDocumentName(file.name)) {
      setMessage(`Unsupported format: ${file.name}. Choose a .txt or .md file.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setMessage('Files must be 2 MB or smaller.');
      return;
    }

    try {
      addReport({ name: file.name, text: await file.text(), sample: false });
    } catch {
      setMessage(`Could not read ${file.name} in this browser.`);
    }
  }

  function addReport({ name, text, sample }) {
    const documentId = createId();
    const date = parseReportDate(text);
    const findings = extractFindings(text, partsData, documentId).map(finding => ({
      ...finding,
      documentId
    }));

    review.documents.unshift({
      id: documentId,
      name,
      date,
      format: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
      sample,
      addedAt: new Date().toISOString()
    });
    review.findings.unshift(...findings);
    persist();
    setMessage(findings.length
      ? `${findings.length} provisional suggestion${findings.length === 1 ? '' : 's'} ready for review.`
      : 'Document saved locally. No supported symptom, investigation, or management phrases were detected.');
    render();
  }

  async function confirmFinding(finding) {
    if (finding.location?.type === 'structure') captureBaselines(finding.location);
    finding.decision = 'confirmed';
    finding.confirmedAt = new Date().toISOString();
    persist();

    if (finding.location?.type === 'structure') {
      await syncPartStatuses(partIdsOf(finding.location));
      const partId = finding.location.partIds[0];
      if (partId) await revealConfirmedPart(partId, finding.location);
    }
    render();
  }

  async function rejectFinding(finding) {
    const wasConfirmed = finding.decision === 'confirmed';
    const affectedPartIds = partIdsOf(finding.location);
    finding.decision = 'rejected';
    finding.confirmedAt = null;
    persist();
    if (wasConfirmed) await syncPartStatuses(affectedPartIds);
    render();
  }

  function captureBaselines(location) {
    partIdsOf(location).forEach(partId => {
      if (!Object.hasOwn(review.statusBaselines, partId)) {
        review.statusBaselines[partId] = getMedicalStatus(partId);
      }
    });
  }

  async function syncPartStatuses(partIds) {
    for (const partId of new Set(partIds)) {
      const confirmed = review.findings
        .filter(finding => finding.decision === 'confirmed'
          && finding.location?.type === 'structure'
          && finding.location.partIds?.includes(partId))
        .sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt)))[0];
      const statusId = confirmed?.statusId ?? review.statusBaselines[partId] ?? null;

      if (!confirmed && !Object.hasOwn(review.statusBaselines, partId)) continue;

      if (getMeshRegistry().has(partId)) setPartMedicalStatus(partId, statusId);
      else setMedicalStatus(partId, statusId);

      if (!confirmed) delete review.statusBaselines[partId];
      if (state.selectedPart?.id === partId && getMeshRegistry().has(partId)) {
        selectPartById(partId, viewer);
      }
    }
    persist();
  }

  async function revealConfirmedPart(partId, location) {
    await selectStructureAnywhere(partId);
    for (const id of location.partIds || []) {
      if (getMeshRegistry().has(id)) setPartMedicalStatus(id, review.findings
        .filter(finding => finding.decision === 'confirmed'
          && finding.location?.type === 'structure'
          && finding.location.partIds?.includes(id))
        .sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt)))[0]?.statusId ?? getMedicalStatus(id));
    }
  }

  function persist() {
    saveDocumentReview(review);
  }

  function render() {
    const documentById = new Map(review.documents.map(document => [document.id, document]));
    list.innerHTML = review.documents.length
      ? review.documents.map(document => `
          <div class="review-document-row">
            <span class="review-document-icon" aria-hidden="true">${document.sample ? 'SAMPLE' : escapeHtml(document.format.toUpperCase())}</span>
            <span><strong>${escapeHtml(document.name)}</strong><small>${escapeHtml(document.date || 'Date not detected')} · stored in this browser</small></span>
          </div>
        `).join('')
      : '<p class="review-empty">No documents added yet.</p>';

    cards.innerHTML = review.findings.length
      ? review.findings.map(finding => renderFinding(finding, documentById.get(finding.documentId))).join('')
      : '<p class="review-empty">Add a text or Markdown report, or load the fictional sample.</p>';

    renderRegionHighlights(regionOverlay, review);
  }

  function renderFinding(finding, sourceDocument) {
    const category = FINDING_CATEGORIES.find(item => item.id === finding.category);
    const status = MEDICAL_STATUSES.find(item => item.id === finding.statusId);
    const locationText = finding.location?.type === 'region'
      ? `Region-level: ${finding.location.label} · no individual mesh assigned`
      : finding.location?.type === 'structure'
        ? finding.location.label
        : 'No anatomical reference detected';
    const decisionLabel = finding.decision === 'confirmed' ? 'Confirmed' : finding.decision === 'rejected' ? 'Rejected' : 'Provisional';
    const locationKind = finding.location?.type || 'none';
    const locationInput = finding.location?.type === 'structure' ? finding.location.label : '';
    const selectedRegion = finding.location?.type === 'region' ? finding.location.id : BODY_REGIONS[0].id;
    const selectedRegionSide = finding.location?.type === 'region' ? finding.location.side || '' : '';

    return `
      <article class="review-card ${finding.decision}" data-finding="${escapeHtml(finding.id)}">
        <div class="review-card-heading">
          <span class="review-category">${escapeHtml(category?.label || 'Finding')}</span>
          <span class="review-decision ${finding.decision}">${decisionLabel}</span>
        </div>
        <p class="review-source">${escapeHtml(sourceDocument?.name || 'Unknown document')} · ${escapeHtml(sourceDocument?.date || 'Date not detected')}</p>
        <blockquote>${escapeHtml(finding.excerpt)}</blockquote>
        <div class="review-target">${escapeHtml(locationText)}</div>
        <div class="review-status"><i style="--status-color: ${status?.color || '#A9B4B8'}"></i>Suggested: ${escapeHtml(status?.label || 'No recorded concern')}</div>
        <div class="review-actions">
          ${finding.decision === 'pending' ? '<button type="button" class="review-primary" data-review-action="confirm">Confirm</button>' : ''}
          <button type="button" data-review-action="edit">Edit</button>
          ${finding.decision !== 'rejected' ? '<button type="button" class="review-reject" data-review-action="reject">Reject</button>' : ''}
        </div>
        <form class="review-edit-form" data-edit-form hidden>
          <label>Finding type
            <select data-edit-category>${FINDING_CATEGORIES.map(item => `<option value="${item.id}" ${item.id === finding.category ? 'selected' : ''}>${item.label}</option>`).join('')}</select>
          </label>
          <label>Medical status
            <select data-edit-status>${MEDICAL_STATUSES.map(item => `<option value="${item.id}" ${item.id === finding.statusId ? 'selected' : ''}>${item.label}</option>`).join('')}</select>
          </label>
          <label>Location type
            <select data-target-kind>
              <option value="none" ${locationKind === 'none' ? 'selected' : ''}>No location</option>
              <option value="structure" ${locationKind === 'structure' ? 'selected' : ''}>Specific structure</option>
              <option value="region" ${locationKind === 'region' ? 'selected' : ''}>Body region only</option>
            </select>
          </label>
          <label data-edit-location-wrap ${locationKind !== 'structure' ? 'hidden' : ''}>Structure name or stable mesh ID
            <input data-edit-location value="${escapeHtml(locationInput)}" placeholder="e.g. Femur.l">
          </label>
          <label data-edit-region-wrap ${locationKind !== 'region' ? 'hidden' : ''}>Body region
            <select data-edit-region>${BODY_REGIONS.map(item => `<option value="${item.id}" ${item.id === selectedRegion ? 'selected' : ''}>${item.label}</option>`).join('')}</select>
            <select data-edit-region-side aria-label="Region side">
              <option value="" ${!selectedRegionSide ? 'selected' : ''}>Side not specified</option>
              <option value="left" ${selectedRegionSide === 'left' ? 'selected' : ''}>Left</option>
              <option value="right" ${selectedRegionSide === 'right' ? 'selected' : ''}>Right</option>
            </select>
          </label>
          <div class="review-actions">
            <button type="submit" class="review-primary">Save changes</button>
            <button type="button" data-review-action="cancel-edit">Cancel</button>
          </div>
        </form>
      </article>
    `;
  }

  function setMessage(message) {
    if (statusMessage) statusMessage.textContent = message;
  }

  render();
}

export function renderRegionHighlights(container, review = loadDocumentReview()) {
  if (!container) return;
  const documents = new Map(review.documents.map(document => [document.id, document]));
  const highlights = review.findings.filter(finding => finding.decision === 'confirmed' && finding.location?.type === 'region');
  container.innerHTML = highlights.length ? `
    <div class="region-highlight-heading">Confirmed region references <span>No individual mesh is marked</span></div>
    ${highlights.map(finding => {
      const status = MEDICAL_STATUSES.find(item => item.id === finding.statusId);
      const source = documents.get(finding.documentId);
      return `
        <article class="region-highlight" style="--status-color: ${status?.color || '#A9B4B8'}">
          <strong>${escapeHtml(finding.location.label)} · ${escapeHtml(status?.label || '')}</strong>
          <small>${escapeHtml(source?.name || '')} · ${escapeHtml(source?.date || 'Date not detected')}</small>
          <blockquote>${escapeHtml(finding.excerpt)}</blockquote>
        </article>
      `;
    }).join('')}
  ` : '';
}

function partIdsOf(location) {
  return location?.type === 'structure' ? location.partIds || [] : [];
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(text) {
  const element = document.createElement('div');
  element.textContent = String(text ?? '');
  return element.innerHTML;
}