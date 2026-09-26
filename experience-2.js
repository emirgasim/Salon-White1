
/* =========================================================
   SALON WHITE — WOMAN / MAN EXPERIENCE 2.0
   Works with the existing app.js without replacing it.
   ========================================================= */
(() => {
  const root = document.documentElement;
  const body = document.body;
  const overlay = document.getElementById("experienceTransition");
  const buttons = [...document.querySelectorAll("[data-mode-switch]")];
  if (!overlay || !buttons.length) return;

  let locked = false;
  let lastX = 50;
  let lastY = 50;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function setLight(x, y) {
    lastX = Math.max(0, Math.min(100, x));
    lastY = Math.max(0, Math.min(100, y));
    root.style.setProperty("--sw-mx", `${lastX}%`);
    root.style.setProperty("--sw-my", `${lastY}%`);
  }

  function pointerLight(e) {
    const p = e.touches ? e.touches[0] : e;
    if (!p) return;
    setLight((p.clientX / window.innerWidth) * 100,
             (p.clientY / window.innerHeight) * 100);
  }

  window.addEventListener("pointermove", pointerLight, {passive:true});
  window.addEventListener("touchmove", pointerLight, {passive:true});

  function finish(next) {
    // Let the existing app.js own the actual mode state, translations,
    // localStorage and service rendering.
    if (typeof window.setMode === "function") {
      window.setMode(next);
    } else {
      body.dataset.mode = next;
    }

    requestAnimationFrame(() => {
      body.classList.remove("experience-switching");
    });

    window.setTimeout(() => {
      overlay.style.opacity = "";
      overlay.style.visibility = "";
      locked = false;
    }, reduced.matches ? 80 : 980);
  }

  function cinematicSwitch(next) {
    if (locked || next === body.dataset.mode) return;
    locked = true;

    const scrollY = window.scrollY;
    body.classList.add("experience-switching");
    overlay.style.visibility = "visible";
    overlay.style.opacity = "1";

    // Preserve the exact scroll position throughout the transition.
    window.scrollTo({top:scrollY, left:0, behavior:"auto"});

    if (reduced.matches) {
      finish(next);
      return;
    }

    // Mode changes at the visual midpoint, when the glass layer is opaque.
    window.setTimeout(() => {
      finish(next);
      // Defensive scroll restoration in case a browser/plugin changed it.
      window.scrollTo({top:scrollY, left:0, behavior:"auto"});
    }, 330);
  }

  // Capture the click before the original app.js listener.
  // We then call its existing setMode at the visual midpoint.
  buttons.forEach(btn => {
    btn.addEventListener("click", (event) => {
      const next = btn.dataset.modeSwitch;
      if (locked) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      cinematicSwitch(next);
    }, true);
  });

  // Give the transition a real liquid response when the user presses the pill.
  const pill = document.querySelector(".mode-switch");
  if (pill) {
    pill.addEventListener("pointerdown", pointerLight, {passive:true});
  }

  // Keep the active state in sync if the existing application changes it elsewhere.
  const observer = new MutationObserver(() => {
    if (!locked) {
      const current = body.dataset.mode;
      buttons.forEach(b => b.classList.toggle("active", b.dataset.modeSwitch === current));
    }
  });
  observer.observe(body, {attributes:true, attributeFilter:["data-mode"]});
})();
