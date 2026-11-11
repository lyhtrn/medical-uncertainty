import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { confirmedMeshStatuses } from '../src/documents/meshStatuses.js';
import { applyMedicalColor } from '../src/viewer/medicalColor.js';

describe('document-to-mesh colouring', () => {
  it('colours only the exact meshes in confirmed, side-specific findings', () => {
    const findings = [
      {
        decision: 'pending',
        statusId: 'documented-problem',
        location: { type: 'structure', partIds: ['Femur.l'] }
      },
      {
        decision: 'confirmed',
        statusId: 'documented-problem',
        confirmedAt: '2026-03-14T10:00:00.000Z',
        location: { type: 'structure', partIds: ['Femur.l'] }
      },
      {
        decision: 'confirmed',
        statusId: 'investigating',
        confirmedAt: '2026-03-14T11:00:00.000Z',
        location: { type: 'structure', partIds: ['Femur.r'] }
      },
      {
        decision: 'confirmed',
        statusId: 'management-progress',
        confirmedAt: '2026-03-14T12:00:00.000Z',
        location: { type: 'structure', partIds: ['Patella.l'] }
      }
    ];
    const statuses = confirmedMeshStatuses(findings);
    const meshes = new Map([
      ['Femur.l', new THREE.MeshBasicMaterial({ color: '#ffffff' })],
      ['Femur.r', new THREE.MeshBasicMaterial({ color: '#ffffff' })],
      ['Patella.l', new THREE.MeshBasicMaterial({ color: '#ffffff' })],
      ['Tibia.l', new THREE.MeshBasicMaterial({ color: '#ffffff' })]
    ]);

    statuses.forEach((statusId, partId) => applyMedicalColor([meshes.get(partId)], statusId));

    expect(statuses).toEqual(new Map([
      ['Femur.l', 'documented-problem'],
      ['Femur.r', 'investigating'],
      ['Patella.l', 'management-progress']
    ]));
    expect(meshes.get('Femur.l').color.getHexString()).toBe('e95858');
    expect(meshes.get('Femur.r').color.getHexString()).toBe('45b9b4');
    expect(meshes.get('Patella.l').color.getHexString()).toBe('f5a34c');
    expect(meshes.get('Tibia.l').color.getHexString()).toBe('ffffff');
  });

  it('uses the grey no-concern colour when a mesh has no confirmed finding', () => {
    const material = new THREE.MeshBasicMaterial({ color: '#ffffff' });

    applyMedicalColor([material], null);

    expect(material.color.getHexString()).toBe('a9b4b8');
  });
});
