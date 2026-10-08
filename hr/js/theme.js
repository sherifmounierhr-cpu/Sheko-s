// Applies the saved theme before the page paints, so there is no flash.
(function () {
  try { var t = localStorage.getItem("hr-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked: follow the system */ }
})();
