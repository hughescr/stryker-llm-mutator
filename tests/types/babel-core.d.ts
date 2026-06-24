/*
 * Ambient module shim for `@babel/core` (TEST-ONLY).
 *
 * `@babel/core` ships no typings and `@types/babel__core` / `@types/babel__traverse`
 * are not installed (and must not be added for this milestone). Production source
 * sources its Babel types from `@babel/types` (which IS typed) and never imports
 * `@babel/core` from `.ts` — only the untyped `.mjs` worker does. The offline
 * tests, however, need Babel's `parse`/`traverse` runtime to build real
 * `NodePath`s, so we declare the module as `any` here. Tests narrow the surface
 * they use via their own local casts; this shim only silences TS7016.
 */

declare module '@babel/core' {
    // The default export is Babel's CJS namespace object (parse, traverse,
    // types, transform, …). Typed as `any` on purpose — tests cast the exact
    // slice they consume.
    // oxlint-disable-next-line typescript/no-explicit-any -- untyped third-party module
    const babel: any;
    export default babel;
}
