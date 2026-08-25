import { describe, expect, it } from "vitest";

import type { RecentEdit } from "../src/context/recent-edits";
import type { EditTarget } from "../src/format/next-edit";
import { renameSpreadFor } from "../src/format/rename";

const cart = [
  "export const grandTotal = (items: Item[]): number => {",
  "  let sum = 0;",
  "  return sum;",
  "};",
  "",
  "export const freeShipping = (cart: Cart): boolean => {",
  "  return total(cart.items) >= 50;",
  "};",
];

const targetOf = (lines: string[]): EditTarget => ({
  path: "src/cart.ts",
  lines,
  windowStart: 0,
  windowEnd: 4,
  cursor: { line: 1, character: 2 },
  previousWindow: undefined,
});

const renamedDeclaration: RecentEdit = {
  path: "src/cart.ts",
  before: "};\n\nexport const total = (items: Item[]): number => {\n  let sum = 0;",
  after: "};\n\nexport const grandTotal = (items: Item[]): number => {\n  let sum = 0;",
};

const renamedCallSite: RecentEdit = {
  path: "src/cart.ts",
  before: "export const discounted = (cart: Cart): number => {\n  const base = total(cart.items);",
  after: "export const discounted = (cart: Cart): number => {\n  const base = grandTotal(cart.items);",
};

describe("renameSpreadFor", () => {
  it("reaches a stale call site outside the window", () => {
    expect(renameSpreadFor(targetOf(cart), [renamedDeclaration, renamedCallSite])).toEqual([{
      kind: "edit",
      path: "src/cart.ts",
      startLine: 6,
      startCharacter: 9,
      endLine: 6,
      endCharacter: 14,
      text: "grandTotal",
    }]);
  });

  it("stays silent until the reader has done the swap twice", () => {
    expect(renameSpreadFor(targetOf(cart), [renamedDeclaration])).toEqual([]);
  });

  it("spreads a repeated type swap, where no word left the text", () => {
    const stats = [
      "pub struct Totals {",
      "    pub views: i64,",
      "    pub clicks: i64,",
      "    pub likes: i32,",
      "    pub shares: i32,",
      "}",
    ];

    const first: RecentEdit = {
      path: "src/stats.rs",
      before: "pub struct Totals {\n    pub views: i32,\n    pub clicks: i32,",
      after: "pub struct Totals {\n    pub views: i64,\n    pub clicks: i32,",
    };

    const second: RecentEdit = {
      path: "src/stats.rs",
      before: "pub struct Totals {\n    pub views: i64,\n    pub clicks: i32,",
      after: "pub struct Totals {\n    pub views: i64,\n    pub clicks: i64,",
    };

    expect(renameSpreadFor({ ...targetOf(stats), path: "src/stats.rs" }, [first, second]).map(edit => edit.kind === "edit" && edit.startLine)).toEqual([3, 4]);
  });

  it("leaves a longer identifier that merely contains the old name alone", () => {
    const lines = ["const totalling = total(items);", "const subtotal = 1;"];

    const edits = renameSpreadFor(targetOf(lines), [renamedDeclaration, renamedCallSite]);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ startLine: 0, startCharacter: 18, endCharacter: 23 });
  });

  it("ignores a change that inserted a word rather than swapping one", () => {
    const readonlyFirst: RecentEdit = {
      path: "src/settings.ts",
      before: "export type Settings = {\n  theme: string;",
      after: "export type Settings = {\n  readonly theme: string;",
    };

    const readonlySecond: RecentEdit = {
      path: "src/settings.ts",
      before: "  readonly theme: string;\n  locale: string;",
      after: "  readonly theme: string;\n  readonly locale: string;",
    };

    expect(renameSpreadFor(targetOf(["  fontSize: number;"]), [readonlyFirst, readonlySecond])).toEqual([]);
  });

  it("ignores a change that added or removed lines", () => {
    const grown: RecentEdit = {
      path: "src/cart.ts",
      before: "export const total = (items: Item[]): number => {",
      after: "export const grandTotal = (items: Item[]): number => {\n  let sum = 0;",
    };

    expect(renameSpreadFor(targetOf(cart), [grown, grown])).toEqual([]);
  });
});
