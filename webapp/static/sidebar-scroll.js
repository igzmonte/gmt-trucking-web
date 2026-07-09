document.addEventListener("DOMContentLoaded", () => {
  const menu = document.querySelector(".sidebar-menu");
  const controls = document.querySelector("[data-sidebar-scroll-controls]");
  const track = document.querySelector("[data-sidebar-scroll-track]");
  const thumb = document.querySelector("[data-sidebar-scroll-thumb]");
  const up = document.querySelector("[data-sidebar-scroll-up]");
  const down = document.querySelector("[data-sidebar-scroll-down]");
  if (!menu || !controls || !track || !thumb) return;

  const update = () => {
    const overflow = Math.max(0, menu.scrollHeight - menu.clientHeight);
    controls.hidden = overflow === 0;
    if (!overflow) return;
    const trackHeight = track.clientHeight;
    const thumbHeight = Math.max(38, trackHeight * (menu.clientHeight / menu.scrollHeight));
    const travel = Math.max(0, trackHeight - thumbHeight);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${travel * (menu.scrollTop / overflow)}px)`;
  };
  const step = (amount) => menu.scrollBy({ top: amount, behavior: "smooth" });
  up?.addEventListener("click", () => step(-120));
  down?.addEventListener("click", () => step(120));
  track.addEventListener("click", (event) => {
    if (event.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    menu.scrollTo({ top: ratio * (menu.scrollHeight - menu.clientHeight), behavior: "smooth" });
  });
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startScroll = menu.scrollTop;
    const available = Math.max(1, track.clientHeight - thumb.offsetHeight);
    const overflow = Math.max(0, menu.scrollHeight - menu.clientHeight);
    const move = (moveEvent) => { menu.scrollTop = startScroll + ((moveEvent.clientY - startY) / available) * overflow; };
    const finish = () => { thumb.removeEventListener("pointermove", move); thumb.removeEventListener("pointerup", finish); thumb.removeEventListener("pointercancel", finish); };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", finish);
    thumb.addEventListener("pointercancel", finish);
  });
  menu.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(update).observe(menu);
  update();
});
