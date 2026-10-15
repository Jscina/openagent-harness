// OpenCode v2 resolves a directory plugin via `<dir>/server` or `<dir>/index`
// (not package.json `exports`), so re-export the real entrypoint here.
export { default } from "./harness.js";
