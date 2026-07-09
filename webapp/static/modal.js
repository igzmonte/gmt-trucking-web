document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-dialog-open]").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      const dialog = document.getElementById(trigger.dataset.dialogOpen);
      if (!dialog || typeof dialog.showModal !== "function") return;
      event.preventDefault();
      dialog.showModal();
      dialog.querySelector("input:not([type=hidden]), select, textarea")?.focus();
    });
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });
    dialog.addEventListener("click", (event) => {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    if (dialog.hasAttribute("data-open-on-load") && typeof dialog.showModal === "function") dialog.showModal();
  });
});
