import { MEDICAL_STATUSES } from '../state/store.js';

export function medicalStatusColor(statusId) {
  return MEDICAL_STATUSES.find(status => status.id === statusId)?.color
    || MEDICAL_STATUSES.find(status => status.id === 'no-concern').color;
}

export function applyMedicalColor(materials, statusId) {
  materials.forEach(material => {
    if (!material.color) return;
    material.color.set(medicalStatusColor(statusId));
    material.needsUpdate = true;
  });
}
