// Applies the saved theme (and the page direction for English) before the page paints, so there is no flash.
(function () {
  try { if (localStorage.getItem("hr-lang") === "en") { document.documentElement.lang = "en"; document.documentElement.dir = "ltr"; } } catch (e) { /* storage blocked: Arabic */ }
  try { var t = localStorage.getItem("hr-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked: follow the system */ }
})();
