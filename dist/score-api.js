// Keep score requests same-origin for Sites/local preview, or route them to the
// separately deployed Worker when the static game is built for GitHub Pages.
const configuredBase = String(window.RIFTBORN_SCORE_API_BASE || '').trim().replace(/\/+$/, '');

export function scoreApiUrl(query = '') {
  return `${configuredBase}/api/scores${query.startsWith('?') ? query : ''}`;
}
