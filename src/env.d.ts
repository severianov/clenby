/** Vite asset-import shims used by the extension bundle. */

declare module "*.css?inline" {
  const css: string;
  export default css;
}
