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
];
