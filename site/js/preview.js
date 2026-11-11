// preview.js — a project's preview: its tour played on one of its release files on an emulated FM-1 (fm1-lab), the
// screen as a GIF and the sound; one per project (data/previews.json), shown on its card with the version it is of.
import { h } from "./ui.js";

/** The preview's sound, looping with its GIF: both come from one emulator run over the same span. Play starts both from
 *  the top (a GIF can't be paused or seeked, so a resume mid-way couldn't line up), and every time the sound comes round
 *  the GIF restarts with it, so they never drift apart. */
export function syncedAudio(src, hasGif) {
  const a = h("audio", { controls: "", preload: "none", src, class: "emu-audio" });
  if (!hasGif) { a.loop = true; return a; }
  const restartGif = () => {
    const img = a.closest(".emu")?.querySelector(".emu-shot");
    if (img) img.src = `${img.src.split("?")[0]}?t=${Date.now()}`;   // a new URL starts a GIF from its first frame
  };
  let fromTop = false;
  a.addEventListener("play", () => {
    if (!fromTop && a.currentTime > 0) { fromTop = true; a.currentTime = 0; }   // resumed mid-way: from the top instead
    fromTop = false;
    restartGif();
  });
  // the loop: from the top, the GIF with it (browsers don't always fire "play" again for a restart after the end)
  a.addEventListener("ended", () => { a.currentTime = 0; restartGif(); a.play().catch(() => {}); });
  return a;
}

export const TOUR_NOTE = {
  generic: "It plays the same inputs every firmware gets: three keys together, a quick run of keys, PLAY, then the PRESETS knob three times with a key each. What they do depends on the firmware (a synth plays a chord and a melody; a groovebox may play drums or start a pattern), so it shows the default state and the first presets, not everything it can do.",
  tailored: "It plays a tour written for this firmware from its documentation.",
  author: "It plays the tour this firmware's author wrote (.fm1-preview.yaml).",
};

/** The preview block: the GIF, the sound, and which release it is of. p: data/previews.json's entry; lab: its file's
 *  lab.json entry. */
export function previewBlock(p, lab) {
  if (!p || !lab?.gif) return null;
  return h("div", { class: "emu" },
    h("img", { class: "emu-shot", src: `data/shots/${p.sha}.gif`, loading: "lazy", width: "240", height: "240", alt: "Its screen on an emulated FM-1 during the preview" }),
    h("ul", { class: "emu-facts" },
      h("li", {}, "Previewing ", h("b", { text: p.tag }), p.asset ? h("span", { class: "muted", text: ` · ${p.asset}` }) : null),
      lab.audio ? h("li", {}, syncedAudio(`data/shots/${p.sha}.m4a`, true)) : h("li", { class: "muted", text: "No sound in the preview." }),
      h("li", { class: "muted", text: `${TOUR_NOTE[p.source] || TOUR_NOTE.generic} Made with fm1-lab${p.at ? ` on ${p.at}` : ""}: emulated, not on a real unit.` })));
}
