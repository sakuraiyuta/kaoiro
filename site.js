// Scroll scenes only. Nothing here may be needed to read the page: the default
// CSS hides nothing, and a hiding class is set only from an observer callback.
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
  const reveals = document.querySelectorAll(".reveal");

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
})();
