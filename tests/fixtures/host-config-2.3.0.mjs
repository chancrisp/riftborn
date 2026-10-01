// The HOST CONFIG block of 2.3.0 (dev/index.html and live/index.html at 76665eb), verbatim: the last
// page before the read base (RIFTBORN_SCORE_READ_BASE, 2.3.1). tests/pages-previews.mjs runs the
// preview check against it, so a missing read base keeps meaning "the score base" after dev/ and
// live/ move on. The game repo keeps the same block (riftborn tests/fixtures/host-config-2.3.0.mjs).
export const HOST_CONFIG_2_3_0 = String.raw`<script>/* HOST CONFIG (v2.2): the one place that decides which services each address uses. Scores
(RIFTBORN_SCORE_API_BASE), player feedback (RIFTBORN_FEEDBACK_API_BASE) and accounts
(RIFTBORN_ACCOUNT_API_BASE, src/meta/account.js). "" turns a service off: scores and feedback stay on
the device, accounts vanish (no welcome popup, no Account settings, no requests; the game plays like 2.1).
  riftborn.us          the live game: all three through api.riftborn.us; scores only from the root
                       game page, never /classic/ or any other path.
  dev.riftborn.us      the password-gated test build: accounts and feedback through api.riftborn.us,
                       NEVER scores.
  chancrisp.github.io  the old address, before the move only: scores from /riftborn/ and feedback
                       through the workers.dev URL, as in 2.1. Accounts OFF: never on a shared origin.
  localhost etc.       nothing, unless ?accounts=local (kept for the tab, so the sign-in round trip
                       returns to it) or localStorage "riftborn-reborn-dev-accounts" names a loopback
                       accounts harness (site server/dev-accounts.mjs).
  anywhere else        nothing (a claude.ai artifact, a copy on another host).
A value set before this block (a test page) wins for scores and feedback. .tools/host-config.mjs
checks this table before every deploy. */
(function () {
  var API = "https://api.riftborn.us", OLD_API = "https://riftborn-leaderboard.chanmanc10.workers.dev";
  var h = location.hostname, p = location.pathname, scores = "", feedback = "", accounts = "";
  if (h === "riftborn.us") {
    accounts = feedback = API;
    if (p === "/" || p === "/index.html") scores = API;
  } else if (h === "dev.riftborn.us") {
    accounts = feedback = API;
  } else if (h === "chancrisp.github.io") {
    feedback = OLD_API;
    if (p === "/riftborn/" || p === "/riftborn/index.html") scores = OLD_API;
  } else if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") {
    var key = "riftborn-reborn-dev-accounts", local = "";
    try {
      if (new URLSearchParams(location.search).get("accounts") === "local") sessionStorage.setItem(key, "http://127.0.0.1:8787");
      local = sessionStorage.getItem(key) || localStorage.getItem(key) || "";
    } catch (e) {}
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(local)) accounts = local;
  }
  window.RIFTBORN_SCORE_API_BASE = window.RIFTBORN_SCORE_API_BASE || scores;
  window.RIFTBORN_FEEDBACK_API_BASE = window.RIFTBORN_FEEDBACK_API_BASE || feedback;
  window.RIFTBORN_ACCOUNT_API_BASE = accounts;
})();
</script>`;

// `html` with its HOST CONFIG block swapped for 2.3.0's.
export const withHostConfig2_3_0 = html => html.replace(/<script>\/\* HOST CONFIG[\s\S]*?<\/script>/,() => HOST_CONFIG_2_3_0);
