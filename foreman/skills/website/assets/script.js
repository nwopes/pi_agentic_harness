// script.js: small, dependency-free behaviour for pages built with base.css.
// Load it with <script src="script.js" defer></script> in <head>, and put this one line in <head> too, BEFORE the CSS:
//   <script>document.documentElement.classList.add("js")</script>
// What it does: mobile nav toggle (with Escape to close), the current year in [data-year], and reveal-on-scroll for
// .reveal elements (skipped when the visitor prefers reduced motion).

(() => {
  const toggle = document.querySelector(".nav__toggle");
  const menu = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (toggle && menu) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.dataset.open = String(open);
    };
    toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
    // Close after choosing a link, on Escape, and when the screen becomes wide enough for the desktop nav.
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        toggle.focus();
      }
    });
    window.matchMedia("(min-width: 48em)").addEventListener("change", (event) => {
      if (event.matches) setOpen(false);
    });
  }

  for (const el of document.querySelectorAll("[data-year]")) el.textContent = String(new Date().getFullYear());

  const reveals = document.querySelectorAll(".reveal");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    for (const el of reveals) el.classList.add("is-visible");
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const el of reveals) observer.observe(el);
  }
})();
