// Compatibility shim: the intro is now js/cinematicMenu.js. Kept so a
// browser still holding an older cached main.js (static assets are cached
// for 1h) doesn't 404 on this import and lose every script on the page.
export { initCinematicMenu as initCinematicIntro } from "./cinematicMenu.js";
