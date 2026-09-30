// The social card on the github.io handoff pages (scripts/pages-templates.mjs SOCIAL_CARD, socialTags):
// people still share the old https://chancrisp.github.io/riftborn/ links, and link previews (Discord,
// X/Twitter, Slack, Facebook, WhatsApp) read a page's HTML without running its script. Proves:
//   - the root handoff page and the 404 page (both send players to https://riftborn.us/) carry every
//     Open Graph + Twitter/X tag exactly once, with absolute riftborn.us URLs and the game's copy;
//   - nothing else changes: the strict meta CSP (img-src data:), noindex, the canonical link, the
//     migration script and everything that loads nothing stay byte for byte as without the card;
//   - the classic edition, the gated test build, the privacy redirect and the private feedback inbox
//     stay untagged;
//   - the copy is plain and player-facing (length, no secret codes, no developer mode), and, once the
//     game build published in live/ carries the card, matches the game page tag for tag;
//   - the handoff pages take the card only once the game build in live/ publishes its image (before
//     that the image URL is a 404 at riftborn.us, and platforms would cache a card with no picture),
//     and the image then travels with the riftborn.us output.
// Builds into a temporary folder; local only, nothing deployed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOSTS, MIGRATION } from '../site.config.mjs';
import { SOCIAL_CARD, handoffPage, notFoundPage, prelaunchPage, redirectPage, socialTags } from '../scripts/pages-templates.mjs';
import { inlineScripts, scriptHash } from '../scripts/pages-headers.mjs';

const ORIGIN = 'https://riftborn.us';
const OG = ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description', 'og:image', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt'];
const TWITTER = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
const metas = html => [...html.matchAll(/<meta\s+(property|name)="([^"]+)"\s+content="([^"]*)">/g)].map(m => ({ attr: m[1], key: m[2], content: decode(m[3]) }));
const values = (html, key) => metas(html).filter(m => m.key === key);
const one = (html, key) => {
  const found = values(html, key);
  assert.equal(found.length, 1, `${key} exactly once (found ${found.length})`);
  return found[0];
};
const canonicals = html => [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map(m => decode(m[1]));
const cspOf = html => /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
const hasCard = html => /(property="og:|name="twitter:)/.test(html);
const CARD_KEYS = ['description', 'theme-color', ...OG, ...TWITTER];

// ---- the tags --------------------------------------------------------------------------------------------
{
  const tags = socialTags(ORIGIN + '/');
  assert.equal(tags.endsWith('\n'), true);
  for (const key of OG) assert.equal(one(tags, key).attr, 'property', key + ' uses property=');
  for (const key of [...TWITTER, 'description', 'theme-color']) assert.equal(one(tags, key).attr, 'name', key + ' uses name=');
  assert.equal(metas(tags).length, CARD_KEYS.length, 'No stray tags');
  const image = `${ORIGIN}/assets/riftborn-card.jpg?v=${SOCIAL_CARD.imageVersion}`;
  assert.deepEqual(Object.fromEntries(metas(tags).map(m => [m.key, m.content])), {
    description: SOCIAL_CARD.description,
    'theme-color': '#8F5BFF',
    'og:type': 'website',
    'og:site_name': 'Riftborn',
    'og:url': ORIGIN + '/',
    'og:title': 'Riftborn – a PS1-style browser shooter',
    'og:description': SOCIAL_CARD.description,
    'og:image': image,
    'og:image:type': 'image/jpeg',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': SOCIAL_CARD.imageAlt,
    'twitter:card': 'summary_large_image',
    'twitter:title': 'Riftborn – a PS1-style browser shooter',
    'twitter:description': SOCIAL_CARD.description,
    'twitter:image': image,
    'twitter:image:alt': SOCIAL_CARD.imageAlt
  });
  assert.match(SOCIAL_CARD.imagePath, /^\/assets\/[a-z0-9-]+\.jpg$/, 'The image is a JPEG in the game assets folder, which the game build copies as is');
  assert.ok(Number.isInteger(SOCIAL_CARD.imageVersion) && SOCIAL_CARD.imageVersion >= 1, 'Versioned: platforms cache a card by its image URL');

  // A test host works the same way (the launched-build tests point the new host at localhost).
  assert.equal(one(socialTags('http://localhost:8791/'), 'og:image').content, `http://localhost:8791/assets/riftborn-card.jpg?v=${SOCIAL_CARD.imageVersion}`);
  // Only the root of a host: a card for the classic edition or a tracking URL would be a different page.
  for (const bad of [ORIGIN + '/classic/', ORIGIN + '/?x=1', ORIGIN + '/#frag', 'ftp://riftborn.us/', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => socialTags(bad), undefined, bad);
  }
  // Copy is escaped, never raw markup.
  const hostile = socialTags(ORIGIN + '/', { ...SOCIAL_CARD, title: 'A "quoted" <b>title</b> & more', description: '<script>x</script>' });
  assert.ok(!hostile.includes('<b>') && !hostile.includes('<script>'));
  assert.equal(one(hostile, 'og:title').content, 'A "quoted" <b>title</b> & more', 'and round-trips through the attribute');
}
console.log('PASS social tags: Open Graph (property=) + Twitter/X (name=) + description, each once, absolute https URLs, versioned image URL, only a host root accepted, copy escaped.');

// ---- the copy ------------------------------------------------------------------------------------------------
{
  assert.ok(SOCIAL_CARD.description.length >= 110 && SOCIAL_CARD.description.length <= 170, `Description: ${SOCIAL_CARD.description.length} characters`);
  assert.ok(SOCIAL_CARD.title.length <= 60);
  assert.ok(SOCIAL_CARD.imageAlt.length >= 40 && SOCIAL_CARD.imageAlt.length <= 420, 'Alt text fits Twitter/X (420) and says something');
  assert.match(SOCIAL_CARD.imageAlt, /Riftborn/);
  assert.match(SOCIAL_CARD.imageAlt, /logo/i);
  assert.match(SOCIAL_CARD.imageAlt, /screenshot/i);
  assert.match(SOCIAL_CARD.description, /PS1-style/);
  assert.match(SOCIAL_CARD.description, /browser/i);
  assert.match(SOCIAL_CARD.description, /Rift Warden/);
  assert.match(SOCIAL_CARD.description, /no download/i);
  for (const text of [SOCIAL_CARD.title, SOCIAL_CARD.description, SOCIAL_CARD.imageAlt]) {
    assert.ok(!/\b(secret|cheat|dev(eloper)?[ -]?mode|practice|debug|password|unlock code)\b/i.test(text), 'Plain, player-facing copy: ' + text);
  }
}
console.log('PASS social copy: title, 110-170 character description and alt text are plain and player-facing (the game repository\'s own test also checks them against the secret-code digests).');

// ---- the handoff page ----------------------------------------------------------------------------------------
const liveRoot = ORIGIN + '/';
const plain = handoffPage({ target: liveRoot, migration: MIGRATION });
const carded = handoffPage({ target: liveRoot, migration: MIGRATION, social: true });
{
  assert.ok(!hasCard(plain) && !/<meta name="description"/.test(plain), 'Without the card the page is what it always was');
  assert.equal(carded.replace(socialTags(liveRoot), ''), plain, 'The card is the only difference: CSP, noindex, canonical, script and markup are untouched');
  assert.equal(cspOf(carded), cspOf(plain));
  assert.equal(cspOf(carded), ["default-src 'none'", `script-src ${scriptHash(inlineScripts(carded)[0])}`, "style-src 'unsafe-inline'", 'img-src data:', "base-uri 'none'", "form-action 'none'"].join('; '), 'Nothing loaded, nothing widened');
  assert.ok(carded.indexOf('http-equiv="Content-Security-Policy"') < carded.indexOf('og:title'), 'The CSP meta stays ahead of everything else');
  assert.match(carded, /<meta name="robots" content="noindex">/, 'Still noindex');
  assert.deepEqual(canonicals(carded), [liveRoot]);
  assert.equal(one(carded, 'og:url').content, canonicals(carded)[0], 'og:url is the canonical address');
  assert.deepEqual(inlineScripts(carded), inlineScripts(plain), 'The migration script is the same script');
  assert.equal(inlineScripts(carded).length, 1);
  assert.ok(!/\ssrc=/i.test(carded), 'Nothing loaded by src');
  for (const link of carded.match(/<link [^>]*>/g)) assert.match(link, /rel="(canonical|icon)"/, 'No new link tags');
  assert.match(carded, /<link rel="icon" href="data:,">/);
  for (const key of CARD_KEYS) one(carded, key);
  for (const raw of [one(carded, 'og:url').content, one(carded, 'og:image').content, one(carded, 'twitter:image').content]) {
    assert.match(raw, /^https:\/\/riftborn\.us\//, raw);
  }
  assert.equal(one(carded, 'twitter:image').content, one(carded, 'og:image').content);

  // The other handoff targets and pages stay as they are.
  const classic = handoffPage({ target: ORIGIN + '/classic/', migration: MIGRATION });
  const gated = handoffPage({ target: HOSTS.dev + '/', migration: MIGRATION });
  assert.ok(!hasCard(classic) && !hasCard(gated), 'No card unless asked for');
  assert.throws(() => handoffPage({ target: ORIGIN + '/classic/', migration: MIGRATION, social: true }), /not the root of a host/, 'The classic edition cannot take the public game\'s card');
  for (const other of [redirectPage({ target: ORIGIN + '/privacy/' }), notFoundPage(), prelaunchPage({ legacyUrl: HOSTS.legacyOrigin + HOSTS.legacyPath, param: MIGRATION.param })]) {
    assert.ok(!hasCard(other), 'Redirects, the 404 of the game host and the pre-launch page are untagged');
  }
}
console.log('PASS handoff template: the card is the only difference (CSP, noindex, canonical, script identical), only for the game root; classic, test build, privacy redirect, game-host 404 and pre-launch pages untagged.');

// ---- the built outputs ---------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-social-'));
try {
  const { CI, GITHUB_ACTIONS, ...baseEnv } = process.env; // test overrides are refused in CI; this goes to a temporary folder
  const built = spawnSync(process.execPath, ['scripts/build-pages.mjs'], {
    env: { ...baseEnv, RIFTBORN_PAGES_OUT: tmp, RIFTBORN_SCORE_API_BASE: HOSTS.workersDev, RIFTBORN_FORCE_LAUNCHED: '1' }, encoding: 'utf8'
  });
  assert.equal(built.status, 0, `build failed:\n${built.stdout}\n${built.stderr}`);
  const site = path.join(tmp, '_site');
  const read = (...parts) => fs.readFileSync(path.join(tmp, ...parts), 'utf8');

  // github.io after the launch: the root page and the catch-all 404 stand for the public game, and
  // carry its card once the game build in live/ publishes the image (scripts/build-pages.mjs cardShipped).
  const liveHasCard = fs.existsSync(path.join('live', 'index.html')) && fs.existsSync(path.join('live', SOCIAL_CARD.imagePath));
  for (const file of ['index.html', '404.html']) {
    const html = read('_site', file);
    assert.equal(html, liveHasCard ? carded : plain, `_site/${file} is the root handoff page ${liveHasCard ? 'with' : 'without'} the card`);
    assert.ok(/<meta name="robots" content="noindex">/.test(html) && /default-src 'none'/.test(cspOf(html)), file + ': noindex and the meta CSP stay');
  }
  for (const file of ['classic/index.html', 'dev/index.html', 'privacy/index.html']) {
    assert.ok(!hasCard(read('_site', file)), `_site/${file} has no card`);
  }
  assert.ok(read('_site', 'dev', 'index.html').includes(HOSTS.dev), 'the test build handoff still points at the gated host');
  // The private feedback inbox: untagged (and still noindex).
  const inboxFiles = fs.readdirSync(path.join(site, 'feedback')).filter(name => name.endsWith('.html'));
  assert.ok(inboxFiles.length > 0);
  for (const name of inboxFiles) {
    const html = read('_site', 'feedback', name);
    assert.ok(!hasCard(html) && !canonicals(html).length, `feedback/${name} has no card and no canonical`);
    assert.match(html, /noindex/, `feedback/${name} stays noindex`);
  }
  // The Cloudflare outputs: the game host's unknown-path page and the gated build's 404 are untagged.
  assert.ok(!hasCard(read('_cf', 'live', '404.html')) && !hasCard(read('_cf', 'dev', '404.html')));
  // The card image, in a game build that ships it, is served with riftborn.us.
  const liveGame = path.resolve('live', 'index.html');
  if (fs.existsSync(liveGame) && hasCard(fs.readFileSync(liveGame, 'utf8'))) {
    const game = fs.readFileSync(liveGame, 'utf8');
    // The published game page and the handoff page say the same thing, tag for tag.
    for (const key of CARD_KEYS) assert.equal(one(game, key).content, one(carded, key).content, `live/index.html ${key} matches the handoff page`);
    assert.deepEqual(canonicals(game), canonicals(carded), 'same canonical link');
    const image = new URL(one(game, 'og:image').content);
    assert.equal(image.origin, ORIGIN);
    assert.ok(fs.existsSync(path.join('live', image.pathname)), `live${image.pathname} is published with the game`);
    assert.ok(fs.existsSync(path.join(tmp, '_cf', 'live', image.pathname)), `riftborn.us serves ${image.pathname}`);
    assert.ok(!/id="devGate"/.test(game), 'the published game page is the public one, not the gated test build');
    console.log('PASS live game page: its card matches the handoff pages tag for tag and its image is published.');
  } else {
    assert.ok(!liveHasCard, 'live/ publishes the card image but its page has no card tags');
    console.log('NOTE live/ has no social card yet (it arrives with the next game deploy): the handoff pages stay without it until then, and the two are compared once it does.');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('PASS built outputs: _site root + 404 carry the card exactly when live/ publishes its image; classic, dev, privacy, feedback inbox and the Cloudflare 404s do not; noindex and the meta CSP intact.');
