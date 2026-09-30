// Minimal ambient types for the GSAP globals loaded from cdnjs in
// public/index.html — only the surface js/cinematicMenu.js uses.
interface Window {
  gsap: {
    registerPlugin(...plugins: unknown[]): void;
    to(target: object, vars: Record<string, unknown>): { scrollTrigger?: { start: number; end: number } };
  };
  ScrollTrigger: {
    config(vars: { ignoreMobileResize?: boolean }): void;
  };
}
