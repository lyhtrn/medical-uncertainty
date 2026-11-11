import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmedFindingsForPart,
  DOCUMENT_REVIEW_STORAGE_KEY,
  loadDocumentReview,
  saveDocumentReview
} from '../src/state/documentReview.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

describe('document review persistence', () => {
  let storage;

  beforeEach(() => {
    storage = createStorage();
  });

  it('round-trips documents, finding decisions, and status baselines', () => {
    const review = {
      documents: [{ id: 'doc-1', name: 'note.txt', date: '2026-03-14' }],
      findings: [{ id: 'finding-1', documentId: 'doc-1', excerpt: 'Exact source.', decision: 'confirmed' }],
      statusBaselines: { 'Femur.l': null }
    };

    expect(saveDocumentReview(review, storage)).toBe(true);
    expect(storage.getItem(DOCUMENT_REVIEW_STORAGE_KEY)).toContain('Exact source.');
    expect(loadDocumentReview(storage)).toEqual(review);
  });

  it('returns evidence only for confirmed findings mapped to that stable part ID', () => {
    const review = {
      documents: [{ id: 'doc-1', name: 'note.txt', date: '2026-03-14' }],
      findings: [
        { id: 'a', documentId: 'doc-1', decision: 'confirmed', location: { type: 'structure', partIds: ['Femur.l'] } },
        { id: 'b', documentId: 'doc-1', decision: 'pending', location: { type: 'structure', partIds: ['Femur.l'] } },
        { id: 'c', documentId: 'doc-1', decision: 'confirmed', location: { type: 'region', id: 'knee' } }
      ],
      statusBaselines: {}
    };

    expect(confirmedFindingsForPart('Femur.l', review).map(item => item.id)).toEqual(['a']);
    expect(confirmedFindingsForPart('Femur.l', review)[0].document.name).toBe('note.txt');
  });
});