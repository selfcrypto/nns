/**
 * `solc` ships no type declarations and there is no `@types/solc`. This is
 * the whole surface {@link ./compile.ts} uses: standard JSON in, standard
 * JSON out, plus the version banner.
 *
 * Kept deliberately thin. Typing the standard-JSON schema in full would be a
 * second, unverified copy of the compiler's documentation living in this
 * repo; `compile.ts` parses the result and asserts what it needs instead, so
 * a shape change surfaces as a thrown error naming the missing field rather
 * than as a type that quietly stopped matching reality.
 */
declare module 'solc' {
  /** Takes a standard-JSON input string, returns a standard-JSON output string. */
  export function compile(input: string): string
  /** e.g. `0.8.30+commit.73712a01.Emscripten.clang` */
  export const version: () => string
}
