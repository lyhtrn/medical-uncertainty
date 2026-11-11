export const SUPPORTED_EXTENSIONS = ['.txt', '.md'];

export const FINDING_CATEGORIES = [
  { id: 'symptom', label: 'Symptom', statusId: 'documented-problem' },
  { id: 'investigation', label: 'Investigation', statusId: 'investigating' },
  { id: 'management', label: 'Management', statusId: 'management-progress' }
];

export const BODY_REGIONS = [
  { id: 'head', label: 'Head', terms: ['head', 'skull'] },
  { id: 'neck', label: 'Neck', terms: ['neck', 'cervical region'] },
  { id: 'chest', label: 'Chest', terms: ['chest', 'thorax', 'thoracic region'] },
  { id: 'abdomen', label: 'Abdomen', terms: ['abdomen', 'abdominal region', 'stomach area'] },
  { id: 'pelvis', label: 'Pelvis', terms: ['pelvis', 'pelvic region'] },
  { id: 'shoulder', label: 'Shoulder', terms: ['shoulder'] },
  { id: 'upper-arm', label: 'Upper arm', terms: ['upper arm', 'upper-arm'] },
  { id: 'elbow', label: 'Elbow', terms: ['elbow'] },
  { id: 'forearm', label: 'Forearm', terms: ['forearm'] },
  { id: 'wrist', label: 'Wrist', terms: ['wrist'] },
  { id: 'hand', label: 'Hand', terms: ['hand'] },
  { id: 'hip', label: 'Hip', terms: ['hip'] },
  { id: 'thigh', label: 'Thigh', terms: ['thigh'] },
  { id: 'knee', label: 'Knee', terms: ['knee', 'knees'] },
  { id: 'lower-leg', label: 'Lower leg', terms: ['lower leg', 'shin', 'calf'] },
  { id: 'ankle', label: 'Ankle', terms: ['ankle'] },
  { id: 'foot', label: 'Foot', terms: ['foot', 'feet'] },
  { id: 'back', label: 'Back', terms: ['back', 'spine'] }
];

const CATEGORY_PATTERNS = {
  symptom: /\b(pain|ache|aching|sore|swelling|swollen|numbness|tingling|weakness|fever|cough|shortness of breath|breathlessness|dizziness|rash|bleeding)\b/i,
  investigation: /\b(mri|ct scan|computed tomography|x[- ]?ray|radiograph|ultrasound|scan|imaging|blood test|laboratory test|biopsy|ecg|ekg|test requested|test ordered|investigat(?:e|ion|ing))\b/i,
  management: /\b(management|treatment|prescribed?|started on|continue|stop(?:ped)?|medication|physiotherapy|physical therapy|rest|ice pack|cold pack|follow[- ]?up|monitor(?:ing)?|review in|plan is)\b/i
};

const REGION_WORDS = new Set(BODY_REGIONS.flatMap(region => region.terms.map(normalise)));

export function isSupportedDocumentName(name) {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(extension);
}

export function normalise(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseReportDate(text) {
  const match = String(text).match(/^\s*(?:report\s+date|visit\s+date|date)\s*:\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\s*$/im);
  if (!match) return '';

  const value = match[1];
  if (/^\d{4}-/.test(value)) return value;

  const [first, second, year] = value.split(/[/-]/);
  const month = Number(first) > 12 ? second : first;
  const day = Number(first) > 12 ? first : second;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function resolveAnatomicalMention(text, partsData = {}) {
  const normalizedText = ` ${normalise(text)} `;
  const candidates = new Map();
  const explicitPartId = Object.keys(partsData).find(partId => partId.toLowerCase() === String(text).trim().toLowerCase());
  if (explicitPartId) {
    const info = partsData[explicitPartId];
    const side = info.side || (explicitPartId.endsWith('.l') ? 'left' : explicitPartId.endsWith('.r') ? 'right' : null);
    return {
      type: 'structure',
      label: info.name?.en || `${info.baseName || explicitPartId.replace(/\.[lr]$/, '')}${side ? ` (${side})` : ''}`,
      partIds: [explicitPartId]
    };
  }

  Object.entries(partsData).forEach(([partId, info]) => {
    const baseName = info.baseName || partId.replace(/\.[lr]$/, '');
    const normalizedName = normalise(baseName.replace(/^\((.*)\)$/, '$1'));
    if (!normalizedName || REGION_WORDS.has(normalizedName)) return;

    const aliases = [normalizedName, normalise(info.latinName)].filter(term => term.length >= 3);
    if (!aliases.some(term => normalizedText.includes(` ${term} `))) return;

    const group = candidates.get(normalizedName) || { baseName, parts: [], length: normalizedName.length };
    group.parts.push({ partId, side: info.side || (partId.endsWith('.l') ? 'left' : partId.endsWith('.r') ? 'right' : null) });
    candidates.set(normalizedName, group);
  });

  const structure = [...candidates.values()].sort((a, b) => b.length - a.length)[0];
  if (structure) {
    const side = /\bleft\b/i.test(text) ? 'left' : /\bright\b/i.test(text) ? 'right' : null;
    const matchingParts = structure.parts.filter(part => !side || !part.side || part.side === side);
    return {
      type: 'structure',
      label: `${structure.baseName}${side ? ` (${side})` : structure.parts.length > 1 && matchingParts.length > 1 ? ' (side not specified)' : ''}`,
      partIds: matchingParts.map(part => part.partId)
    };
  }

  const region = BODY_REGIONS
    .flatMap(item => item.terms.map(term => ({ item, term: normalise(term) })))
    .filter(({ term }) => term && normalizedText.includes(` ${term} `))
    .sort((a, b) => b.term.length - a.term.length)[0]?.item;

  if (!region) return null;
  const side = /\bleft\b/i.test(text) ? 'left' : /\bright\b/i.test(text) ? 'right' : null;
  return {
    type: 'region',
    id: region.id,
    side,
    label: side ? `${side[0].toUpperCase()}${side.slice(1)} ${region.label.toLowerCase()}` : region.label
  };
}

export function extractFindings(text, partsData = {}, documentId = 'document') {
  const excerpts = String(text)
    .split(/(?<=[.!?;])\s+|\r?\n+/u)
    .map(excerpt => excerpt.trim())
    .filter(Boolean);
  const findings = [];

  excerpts.forEach(excerpt => {
    FINDING_CATEGORIES.forEach(category => {
      if (!CATEGORY_PATTERNS[category.id].test(excerpt)) return;

      findings.push({
        id: `${documentId}:${findings.length}`,
        category: category.id,
        excerpt,
        location: resolveAnatomicalMention(excerpt, partsData),
        statusId: category.statusId,
        decision: 'pending',
        confirmedAt: null
      });
    });
  });

  return findings;
}