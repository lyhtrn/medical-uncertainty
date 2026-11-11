export const DOCUMENT_REVIEW_STORAGE_KEY = 'medical-uncertainty:document-review';

const EMPTY_REVIEW = { documents: [], findings: [], statusBaselines: {} };

export function loadDocumentReview(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(DOCUMENT_REVIEW_STORAGE_KEY);
    if (!stored) return structuredClone(EMPTY_REVIEW);

    const parsed = JSON.parse(stored);
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      statusBaselines: parsed.statusBaselines && typeof parsed.statusBaselines === 'object'
        ? parsed.statusBaselines
        : {}
    };
  } catch {
    return structuredClone(EMPTY_REVIEW);
  }
}

export function saveDocumentReview(review, storage = globalThis.localStorage) {
  try {
    storage?.setItem(DOCUMENT_REVIEW_STORAGE_KEY, JSON.stringify(review));
    return true;
  } catch {
    return false;
  }
}

export function confirmedFindingsForPart(partId, review = loadDocumentReview()) {
  const documentNames = new Map(review.documents.map(document => [document.id, document]));
  return review.findings
    .filter(finding => finding.decision === 'confirmed'
      && finding.location?.type === 'structure'
      && finding.location.partIds?.includes(partId))
    .map(finding => ({ ...finding, document: documentNames.get(finding.documentId) || null }));
}