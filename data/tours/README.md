# Preview tours

A project's preview (on its release reports: the screen as a GIF, the sound) plays a tour: an fm1-lab scenario
(https://github.com/beowulf-audio/fm1-lab, `lib/scenario.mjs` has the format) of key presses, notes, knob turns and
button presses, about 7 seconds long.

The tour used, the first that exists:
1. `.fm1-preview.yaml` at the root of the firmware's own repository (its author's: they know what shows it off)
2. `OWNER__REPO.yaml` here, written for the project from its documentation
3. fm1-lab's generic tour (`scenarios/preview.yaml`: a chord, a melody, PLAY, a few presets)

When a project's tour changes, the daily job makes its latest releases' previews again. A tour is data, never code:
it is parsed as a scenario and must be at most 20 seconds and 200 steps.
