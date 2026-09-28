import fs from 'node:fs';

const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
if (!/^[0-9a-f-]{36}$/i.test(databaseId || '')) throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the D1 database UUID.');
const source = fs.readFileSync('cloudflare/wrangler.jsonc', 'utf8');
fs.writeFileSync('cloudflare/.wrangler.deployment.jsonc', source.replace('__D1_DATABASE_ID__', databaseId));
