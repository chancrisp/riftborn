// Prints the switches from site.config.mjs as key=value lines for the Pages workflow
// (node scripts/site-config.mjs >> "$GITHUB_OUTPUT"), so the workflow reads the same source of
// truth as the build.
import { LAUNCHED, PAGES_PROJECTS } from '../site.config.mjs';

process.stdout.write([
  `launched=${LAUNCHED ? 'true' : 'false'}`,
  `live_project=${PAGES_PROJECTS.live}`,
  `dev_project=${PAGES_PROJECTS.dev}`
].join('\n') + '\n');
