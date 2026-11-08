// Scroll scenes only. Nothing here may be needed to read the page: the default
// CSS keeps content visible; only the optional indicator can be hidden.
(() => {
  "use strict";

  if (typeof IntersectionObserver !== "function") return;

  // The section indicator works with reduced motion too; it only hides near
  // the hero and the footer, and marks the current section.
  const toc = document.querySelector(".toc");
  const links = toc.querySelectorAll("a");
  const edgesInView = new Set();
  const edgeObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) edgesInView.add(entry.target);
      else edgesInView.delete(entry.target);
    }
    toc.classList.toggle("off", edgesInView.size > 0);
  });
  const sectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.getAttribute("aria-labelledby");
      links.forEach((link) => {
        if (link.hash === "#" + id) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      });
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  document.querySelectorAll(".hero, footer").forEach((edge) => edgeObserver.observe(edge));
  document.querySelectorAll("main section").forEach((section) => sectionObserver.observe(section));

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) return;

  const stage = document.querySelector(".stage");
  const steps = document.querySelectorAll(".step");
  const sceneObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      steps.forEach((step) => step.classList.toggle("on", step === entry.target));
      stage.dataset.scene = entry.target.dataset.scene;
    }
  }, { rootMargin: "-45% 0px -45% 0px" });

  steps.forEach((step) => sceneObserver.observe(step));
  document.documentElement.classList.add("motion");
})();

// The link remains a direct-file fallback when enhancement is unavailable.
(() => {
  const video = document.querySelector(".intro-film video");
  const play = document.querySelector(".film-play");
  const file = document.querySelector(".film-file");
  if (!video || !play || typeof video.play !== "function") return;
  play.addEventListener("click", (event) => {
    event.preventDefault();
    try {
      const started = video.play();
      if (started && typeof started.catch === "function") started.catch(() => file.focus());
    } catch {
      file.focus();
    }
  });
})();
