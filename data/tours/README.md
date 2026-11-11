# Preview tours

A project's preview (on its release reports: the screen as a GIF, the sound) plays a tour: an fm1-lab scenario
(https://github.com/beowulf-audio/fm1-lab, `lib/scenario.mjs` has the format) of key presses, notes, knob turns and
button presses, about 7 seconds long.

The tour used, the first that exists:
1. `.fm1-preview.yaml` at the root of the firmware's own repository (its author's: they know what shows it off)
2. `OWNER__REPO.yaml` here, written for the project from its documentation
3. fm1-lab's generic tour (`scenarios/preview.yaml`: the same inputs for every firmware, three keys together, a run of
   keys, PLAY and a few preset changes; what they do depends on the firmware)

When what a project's tour plays changes (not its comments or formatting), the daily job makes its latest releases'
previews again. A tour is data, never code:
it is parsed as a scenario and must be at most 20 seconds and 200 steps.

A tour is written for one version of a firmware. Every day, for each project with its own tour (here or the author's),
the latest release's preview is compared with the previous release's through the same tour (`tools/tour-check.mjs`):
the number of distinct screens, how much of the time there is sound, how many sounds start. A newer version that shows
clearly less (its controls moved, so the tour ends on a menu or a notice) goes on `review.json` here, and the job's log
gets a warning. Nothing is changed by it: the tour needs a look, and a fixed tour makes the previews again.
