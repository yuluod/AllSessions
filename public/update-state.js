export function progressPercent(downloaded, total) {
  const current = Number(downloaded);
  const maximum = Number(total);
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((current / maximum) * 100)));
}

export function shouldShowAvailableVersion(phase, version) {
  return (
    Boolean(version) &&
    ["available", "downloading", "installing"].includes(phase)
  );
}
