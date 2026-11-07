// Scroll scenes only. Nothing here may be needed to read the page: the default
// CSS hides nothing, and a hiding class is set only from an observer callback.
(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches || typeof IntersectionObserver !== "function") return;

  const stage = document.querySelector(".stage");
  const steps = document.querySelectorAll(".step");
  const reveals = document.querySelectorAll(".reveal");

  const showAll = () => {
    document.documentElement.classList.remove("motion");
    reveals.forEach((element) => element.classList.remove("pre"));
  };

  try {
    const sceneObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        steps.forEach((step) => step.classList.toggle("on", step === entry.target));
        stage.dataset.scene = entry.target.dataset.scene;
      }
    }, { rootMargin: "-45% 0px -45% 0px" });

    const revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.remove("pre");
          revealObserver.unobserve(entry.target);
        } else if (entry.boundingClientRect.top > window.innerHeight) {
          entry.target.classList.add("pre");
        }
      }
    }, { rootMargin: "0px 0px -8% 0px" });

    steps.forEach((step) => sceneObserver.observe(step));
    reveals.forEach((element) => revealObserver.observe(element));
    document.documentElement.classList.add("motion");
  } catch {
    showAll();
  }
})();
