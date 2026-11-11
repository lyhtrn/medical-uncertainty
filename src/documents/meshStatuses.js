export function confirmedMeshStatuses(findings) {
  const statuses = new Map();
  const latestConfirmations = new Map();

  findings.forEach(finding => {
    if (finding.decision !== 'confirmed'
      || finding.location?.type !== 'structure'
      || !Array.isArray(finding.location.partIds)) return;

    finding.location.partIds.forEach(partId => {
      if (!partId) return;
      const current = latestConfirmations.get(partId);
      if (!current || String(finding.confirmedAt).localeCompare(String(current.confirmedAt)) > 0) {
        latestConfirmations.set(partId, finding);
      }
    });
  });

  latestConfirmations.forEach((finding, partId) => statuses.set(partId, finding.statusId));
  return statuses;
}
