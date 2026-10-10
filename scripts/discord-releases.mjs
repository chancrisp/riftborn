// Release posts: what RiftBot posts in the Riftborn Discord when a new version ships, one entry per
// version, oldest first. Data only: the "releases" phase of scripts/discord-setup.mjs (the "Release
// posts" step of .github/workflows/discord-setup.yml, which runs on every push to main that changes
// this file and after every deploy of riftborn.us) posts each entry once, the announcement in
// #announcements and the patch notes in #patch-notes, and then publishes both so servers that follow
// those channels get them too. An entry is posted only once https://riftborn.us/version.json serves
// its version (or a newer one), so it can be pushed before its version is live.
//
// How a new version gets announced, at the same time as it goes live:
//   1. With the release candidate, the lead drafts both texts from its in-game patch notes.
//   2. The owner approves the candidate and the texts together, and says whether either post pings
//      (see ping below).
//   3. The lead promotes the candidate (.tools/promote-live.mjs) and adds the version's entry below
//      in the same push to main as live/. That push's run usually finds riftborn.us still on the old
//      version and leaves the entry waiting ("2.4.0 waits for riftborn.us to serve it"); once the
//      Pages deploy has put the new version live (about 1-2 minutes), the workflow runs again and
//      RiftBot posts and publishes the two messages. (If the deploy finishes first, the push's own
//      run posts them and the later run finds them already there.)
//   If riftborn.us could not be reached at that moment (the run then shows a warning), the entry
//   waits for the next deploy of main or a run by hand (Actions > Discord server setup > Run
//   workflow). Pushing an entry whose version never goes live posts nothing, and holds back every
//   entry after it.
//
// An entry:
//   version       MAJOR.MINOR.PATCH, newer than the entry above it.
//   announcement  for #announcements. Its first line starts with "**Riftborn <v> · " where <v> is the
//                 version without a ".0" patch (2.3.0 is "2.3", 2.3.1 is "2.3.1"). Link previews stay on
//                 (the riftborn.us card).
//   patchNotes    for #patch-notes. Its first line starts with "**v<v> · ". Link previews are off.
//                 Those bold first lines are how RiftBot recognises a version it has already posted, so
//                 a version is never posted twice: keep them exactly like that.
//   ping          announcement: true pings the News pings role, patchNotes: true pings Patch pings. The
//                 ping goes on its own line above the text, and that one role is all it can ping. In
//                 servers that follow the channel the ping shows as @deleted-role, so turn one on only
//                 with the owner's OK. A text itself never mentions anyone (no @everyone or @here).
//   posted: true  on entries that went out before this file existed: RiftBot recognises them in the
//                 channel and never sends them again. Also the way to retire a version whose post was
//                 deleted by hand, which RiftBot would otherwise post again: set posted: true on it
//                 and on every entry above it.
// RiftBot only recognises its own posts: a version someone posts by hand gets posted again by RiftBot.
// {#channel} becomes a link to that channel, as in the other setup posts; only public channels can
// be linked. A text may be up to 2000 characters once posted: each link and the ping add about 10
// and 25.
//
// An entry whose announcement and patchNotes are both null is a placeholder. Nothing is posted for
// it, or for any entry after it, until both texts are filled in.

export const RELEASES = [
  {
    version: '2.2.0',
    posted: true, // posted on 30 Sep 2026 by the setup's posts phase, before this file existed
    ping: { announcement: false, patchNotes: false },
    announcement: `**Riftborn 2.2 · Riftborn Accounts is live at riftborn.us** 🌋
Riftborn has a new home, and your progress can now follow you everywhere.

🔑 **Riftborn Accounts:** sign in with Google, Discord or GitHub and pick your own username. Your progress, characters, cosmetics and settings follow you to every device. Signing in is optional: you can always play as a guest.
🏠 **New home:** Riftborn now lives at https://riftborn.us. Open your old chancrisp.github.io link once and your progress moves over automatically. Nothing is deleted.
🔥 **New loading screen:** a molten wordmark, a turning rift ring and drifting embers, with real loading stages.
🔍 **UI scale slider:** anywhere from 50% to 150%, held to what fits your screen.
🎨 **Colour-coded patch notes:** names, buttons and numbers picked out so every update is easy to skim.

🛡️ Only your username, a scrambled platform ID, your progress and your settings are stored. No emails, real names or pictures, and no ads or trackers: https://riftborn.us/privacy/

Highlights in {#patch-notes}, full notes in-game. See you in the rift. ▶️ https://riftborn.us`,
    patchNotes: `**v2.2 · Riftborn Accounts** (30 Sep 2026)
- **Riftborn accounts:** sign in with Google, Discord or GitHub and your progress, cosmetics and settings follow you to every device. You can always play as a guest.
- **Your own username:** 3 to 16 characters and unique. Nothing is taken from your platform: no email, no real name, no picture. Rename once every 30 days in Settings.
- **Link platforms:** put Google, Discord and GitHub on one account and sign in with any of them.
- **Guest progress merges in** the first time you sign in. Nothing is lowered or replaced.
- **Verified mark:** leaderboard scores from an account show a check mark, and guests can't post under an account's name.
- **New ACCOUNT tab** in Settings: your username, linked platforms, sync status and sign-out options, including SIGN OUT OTHER DEVICES.
- **New home at https://riftborn.us:** your old chancrisp.github.io link hands your progress over automatically. The classic edition is at https://riftborn.us/classic/.
- **Loading screen:** molten wordmark, rift ring, embers and real loading stages. It holds still with reduced motion on.
- **UI scale slider:** 50% to 150% in 5% steps. Touch screens stay at 100% or more, and small screens are held to what fits.
- **Colour-coded patch notes:** each kind of note has its own colour, so long lists are easy to skim.
- **Fixes:** phone HUD buttons no longer slip under the portal compass, and panels and the title fit at every UI scale.
- **Balance:** no gameplay changes.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },

  // 2.3.0, owner-approved 2026-10-01 ("wording looks fine, automate it yes and ping the roles yes"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.3.0',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.3 · Bigger Worlds is live!**
- KEEPERS worlds are **50% bigger**
- A brand-new logo and an animated arcade title
- Difficulty that follows your progress, and no more farming at the portal
- Quieter worlds with a new **Ambience** slider

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.3 · Bigger Worlds** (1 Oct 2026)
- **Bigger KEEPERS worlds:** all five worlds cover 50% more ground. ORIGINAL keeps its original size.
- **Fresh KEEPERS leaderboard** for the new worlds. Your older scores are kept on your device.
- **No more portal farming:** after a stage's goal, ordinary kills fade to nothing over 30 seconds. Keepers, elites and trial targets still pay in full.
- **Difficulty follows progress:** exploring the bigger worlds no longer lets the monsters outpace you. Death Mode stays relentless.
- **Pausing** no longer makes you untouchable.
- **New logo and title:** an arcade-style logo with the red skull, and a main-menu title with its own animation. Title themes will change with big updates.
- **Death Mode skull:** it cycles through every colour, glitches when you hover it, and has new flame eyes.
- **Ambience slider** in Settings › Audio, and world background sounds are much quieter.
- **Link previews** when you share riftborn.us, plus a new skull tab icon.
- **Fixes:** Phased, Detonation and Skewer counting, the Rift Warden's 25% gate, and the Bone Lantern preview.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.3.1, owner-approved 2026-10-01 ("Yes, post them as drafted"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.3.1',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.3.1 · Play Again is live!**
- A **Fullscreen** switch in Settings
- The death screen now tells you **what killed you**, with a tip for next time
- **PLAY AGAIN** jumps straight into your next run
- Older KEEPERS scores are back when you switch off **CURRENT RULES ONLY**

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.3.1 · Play Again** (1 Oct 2026)
- **Fullscreen:** a new switch in Settings › Graphics. In Chrome and Edge, Esc still pauses; hold Esc to leave fullscreen.
- **What killed you:** the results show the final hit and a tip for your next attempt.
- **Instant PLAY AGAIN** with the same name, ruleset and practice setting (Death Mode stays on until you turn it off).
- **Assist tip** after two quick early deaths, shown once.
- **Older KEEPERS scores** appear when you switch off CURRENT RULES ONLY.
- **Tutorial:** the button shows it unlocks Quackshot, and the toll step can be skipped.
- **Practice runs** no longer need a name.
- **Bellwether bell** now warns that its shade returns in the finale.
- **First-time hazard tips** are no longer lost in busy fights.
- **Fixes:** phone HUD overlaps, Settings tab names cut off on small screens, and the update message for look-only updates.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.3.2, owner-approved 2026-10-02 ("ship it"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.3.2',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.3.2 · Sound Check is live!**
- A cleaner, punchier **sound mix**, louder on phone speakers
- Pick your **cursor**: four pixel cursors, each with its own effect
- **Full screen on iPhone**: add Riftborn to your Home Screen
- A **stacked title**, and a choice of where your **weapon slots** sit

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.3.2 · Sound Check** (2 Oct 2026)
- **Sound mix:** louder and clearer, especially on phones, with no volume jump between the title and a run. Calmer world ambience and subtler interface sounds.
- **Cursors:** a new CURSOR tab in Settings: Bevel Arrow, Rift Shard, Skull Tip, Gauntlet or your System cursor, each with its own effect (Full, Calm or Off).
- **Full screen on iPhone:** Share › Add to Home Screen opens Riftborn with no browser bars. Android can install it too.
- **Interface volume** slider and **Play on silent** (iPhone) in the Audio tab.
- **Backspace goes back** like Esc, so Firefox and Safari players can back out without leaving fullscreen.
- **Weapon slots:** keep the classic bottom row, or move them into a column under the radar in Settings › Graphics.
- **Stacked title:** the skull badge now sits over the RIFTBORN wordmark.
- **Pixelation** now goes down to 64 lines for an extra-chunky look.
- **Phones held sideways:** a new compact layout with smaller pads and nothing overlapping.
- **Fixes:** iPhone HUD overlaps, small-window and tablet HUD overlaps, a Rift Echo stutter, music dropping notes, a quiet first sound, and grey textures on slow connections.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.4.0, owner-approved 2026-10-05 (texts approved, "ping both", "ship it"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.4.0',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.4 · Pumpkin Hill is live!**
- A sixth world, **Pumpkin Hill**, with a new keeper, **The Cairn**, and a new Skull Trial
- A new wide monster, the **Gourd**, while the crawlers are gone
- New music: a Pumpkin Hill song, a second battle song and a keeper boss theme
- A **Textures** setting, and a spooky **Hollow Rift** title for October

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.4 · Pumpkin Hill** (5 Oct 2026)
- **Pumpkin Hill:** a sixth world, the third stop of the KEEPERS run (Death Mode included): rust-brown hills and olive rock, a grey-blue church, a ghost train and jack-o'-lantern spires. ORIGINAL keeps its five worlds.
- **The Cairn:** Pumpkin Hill's keeper. Stay off its front, step beside its Ember Breath and shoot the grin. Break it and its shade joins the Rift Warden's finale. New mastery: Unsinged (Spire badge).
- **Patch Harvest:** Pumpkin Hill's Skull Trial, with a new pumpkin skull statue. Smash eight lit pumpkins, and mind the rotten ones.
- **The Gourd:** a new wide, tough monster. Walk round it.
- **Crawlers removed:** the Skitter, Leaper and Broodmother are gone from every ruleset. Splitters now release two Restless.
- **New music:** a Pumpkin Hill song, a second battle song for the Caldera, Citadel and Void Crown, and a boss theme for every keeper fight.
- **Textures:** a new setting in Settings › Graphics: Classic (the default), Remastered, Gritty, Vivid or Hollow, with a preview. A Character outline switch joins it.
- **Hollow Rift:** an October-only title: ash letters round a pumpkin skull with green flame eyes.
- **Chapel of the Last Lantern:** a sixth landmark for the Journal's WORLDS map.
- **Fresh KEEPERS leaderboard** for the new route. Older runs show when you switch off CURRENT RULES ONLY. ORIGINAL personal bests start fresh too.
- **The Void Crown:** far more open in KEEPERS, with no narrow lanes, and the Crown Dais now glows teal to show where to stand.
- **Fixes:** a thumb on the status panel of an upright phone now still moves the hero, phone power-ups and omen chips fit, and the tablet unlock popup clears the captions.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.5.0, owner-approved 2026-10-08 (texts approved, "ping both", "go live"):
  // News pings on the announcement, Patch pings on the patch notes (the owner's call, as for 2.3 and 2.4).
  {
    version: '2.5.0',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.5 · Shifting Worlds is live!**
- Five worlds **shift their layout** between runs, and you can now **drop off ledges**
- Upgrades roll **Common, Rare or Epic**, and Skull Trials come in three versions
- A deck of twenty **omens** on the statues, and **far tougher keepers**
- A redrawn HUD, pause card, results screen and leaderboard, plus a **crosshair** you can style
- **ORIGINAL** is retired, and the KEEPERS leaderboard starts fresh

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.5 · Shifting Worlds** (8 Oct 2026)
- **New layouts:** the Meadows, Shattered Quarry, Ember Caldera, Aurora Citadel and Void Crown build a fresh layout each run, moving the rift portal, the paths and the skull statues. If one cannot be built, the world uses its classic map. Pumpkin Hill keeps its landscape and portal.
- **Ledge drops:** step or dash off a ledge and drop to the ground below, with no fall damage. You cannot climb back up a cliff.
- **Upgrade rarities:** cards roll Common, Rare or Epic (75%, 20% and 5% to start). Rare is about 1.5x as strong, Epic 2x, and every Epic adds a bonus.
- **Skull Trials:** the Meadows, Quarry, Pumpkin Hill, Caldera and Citadel hold 2 or 3 each, in one of three versions. Every trial you start adds luck that improves your odds.
- **Omen deck:** ten new omens, twenty in all. Each run deals 10 to 20 omen statues and none repeats.
- **Tougher keepers:** far more health, faster moves and shorter pauses. Iron Maw now leaps instead of charging.
- **Rift Warden:** redrawn as a hooded jailer, with a new Rift Lance beam and an Unbound phase at 35% health.
- **Landmark hint:** SOMETHING OLD STIRS NEARBY shows within 20 m of an undiscovered landmark.
- **Redrawn:** the HUD, stage banners, pause card (with a new LEGEND button), results screen, Journal, Patch Notes and Settings.
- **Leaderboard:** a ladder with headshots and route pips. Pick a row to open its run card.
- **Settings:** HUD opacity, a CROSSHAIR group, search and reset, and graphics presets: LOW, BALANCED, PIXEL-AUTHENTIC or five of your own.
- **Changes:** ORIGINAL is retired (old scores stay on its tab) and the radar is removed.
- **Fresh KEEPERS leaderboard** and personal bests. Older runs show when you switch off CURRENT RULES ONLY.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.5.1, owner-approved 2026-10-08 (texts approved after the release went live, "ping both"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.5.1',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.5.1 · Small Fixes is live!**
- **Pumpkin Hill:** the ghost train yard floor no longer flickers
- The browser's **right-click menu** stays out of the game
- Menu text no longer **highlights on phones and tablets**

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.5.1 · Small Fixes** (8 Oct 2026)
- **Pumpkin Hill:** the floor of the ghost train yard no longer flickers between two textures as you move.
- **Right-click menu:** the browser's own menu no longer pops up over the game or its card screens. Text fields, such as the Settings search, keep theirs so copy and paste still work.
- **Phones and tablets:** menu text no longer gets highlighted when you double-tap, press and hold, or drag across it. Text fields, such as the Settings search, still select as normal.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.5.2, owner-approved 2026-10-10 (texts approved, "ping both", "go live"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.5.2',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.5.2 · Play Stats is live!**
- Riftborn now counts **finished runs anonymously**: game version, device type, character, weapon, stage and result. No names, no IDs
- Cloudflare's **visit counter** now loads on riftborn.us
- One new switch, **Share play stats**, turns both off (Settings › Accessibility › Privacy)
- A short note explains it the first time you open the menu

Full notes in {#patch-notes} · What is counted: https://riftborn.us/privacy/ · Play now: https://riftborn.us`,
    patchNotes: `**v2.5.2 · Play Stats** (10 Oct 2026)
- **Play stats:** finished runs on riftborn.us are counted anonymously: game version, device type, character, weapon, stage reached, win or death and a run-length range, and nothing else. No names, no IDs, no IP addresses. Practice runs, the Tutorial, the demo and the test build count nothing.
- **Share play stats:** a new PRIVACY group at the end of the Accessibility tab has one switch, Share play stats. Off stops the counts and Cloudflare's visit counter (from the next page load) and clears anything waiting to be sent. It stays on this device, RESET ALL leaves it alone, and a browser that sends Global Privacy Control starts with it off and locked.
- **First-run note:** the first time you open the main menu a short toast shows once with what is counted and where the switch is. Nothing is counted before you have seen it.
- **Privacy policy:** the privacy page now lists exactly what is counted, what is not, and how the switch works.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
  // 2.5.3, owner-approved 2026-10-10 (texts approved, "ping both", "ship it"):
  // News pings on the announcement, Patch pings on the patch notes.
  {
    version: '2.5.3',
    ping: { announcement: true, patchNotes: true },
    announcement: `**Riftborn 2.5.3 · Small Fixes is live!**
- **Settings search** lists its results in one column
- The **presets bar** lines up on wide screens
- The results card shows your **leaderboard place** beside the score, and a labelled **DEATH MODE** button
- The **Shattered Quarry** and **Aurora Citadel** fall back to their classic map far less often

Full notes in {#patch-notes} · Play now: https://riftborn.us`,
    patchNotes: `**v2.5.3 · Small Fixes** (10 Oct 2026)
- **Settings search:** results now stack in one full-width column, in tab order, so a single match is no longer left in one half of the page.
- **Graphics presets:** the PRESETS bar now lines up in two rows on wide screens, the label and the preset chips on top and the actions and note below, however many presets you have saved.
- **Rank medal:** the results card now shows your leaderboard place, such as #3 OF 41, as a medal in the SCORE tile once the run's score is saved and the board is read. A run that does not place on the board shows no medal.
- **Death Mode button:** on the results card the DEATH MODE skull no longer drifts over the card. It sits in the outcome band as a labelled button that still turns the mode off.
- **Aurora Citadel ramps:** a route that brushed a ramp part-way up could leave a steep step in it on some layouts. Those ramps are no longer built that way.
- **Layout fallback:** the Shattered Quarry and Aurora Citadel use their classic map much less often. A layout that cannot be built with its first theme now gets a fresh theme before the classic map is used.

Full notes in-game: **PATCH NOTES** on the main menu.`,
  },
];
