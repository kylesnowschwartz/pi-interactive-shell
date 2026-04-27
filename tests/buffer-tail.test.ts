import { describe, expect, it } from "vitest";
import { findEffectiveBufferEnd } from "../pty-session.js";

/**
 * Build a fake xterm-like buffer where each row is described by its plain
 * translation. Useful for testing buffer-walk helpers without spinning up a
 * real `@xterm/headless` Terminal instance.
 */
function fakeBuffer(rows: string[]): {
	length: number;
	getLine: (i: number) => { translateToString: (trimRight?: boolean) => string };
} {
	return {
		length: rows.length,
		getLine: (i: number) => ({
			translateToString: (_trimRight?: boolean) => rows[i] ?? "",
		}),
	};
}

describe("findEffectiveBufferEnd (getTailLines blank-trim)", () => {
	it("trims trailing blank rows below the populated content", () => {
		// Simulates 8 lines of output written to a 40-row buffer.
		// Without the fix, callers slicing off buffer.length would return blanks.
		const rows = [
			"tick 1",
			"tick 2",
			"tick 3",
			"tick 4",
			"tick 5",
			"tick 6",
			"tick 7",
			"tick 8",
			...Array(32).fill(""), // rows 8–39 all blank
		];
		expect(findEffectiveBufferEnd(fakeBuffer(rows))).toBe(8);
	});

	it("returns 0 for a fully empty buffer", () => {
		expect(findEffectiveBufferEnd(fakeBuffer(["", "", "", ""]))).toBe(0);
	});

	it("returns full length when every row has content", () => {
		expect(findEffectiveBufferEnd(fakeBuffer(["a", "b", "c"]))).toBe(3);
	});

	it("preserves blank rows that are not at the trailing edge", () => {
		// Intentional blank in the middle; last populated is row 4.
		const rows = ["line 1", "", "line 3", "", "line 5", "", "", ""];
		expect(findEffectiveBufferEnd(fakeBuffer(rows))).toBe(5);
	});

	it("walks back at most O(blank rows at end), not O(rows)", () => {
		// 1000 populated rows + 5 trailing blanks. Should terminate after 5 steps
		// (we don't measure this directly; just verify correctness for size).
		const rows = [...Array(1000).fill("x"), "", "", "", "", ""];
		expect(findEffectiveBufferEnd(fakeBuffer(rows))).toBe(1000);
	});

	it("treats an all-blank buffer with length=40 as effectively empty", () => {
		expect(findEffectiveBufferEnd(fakeBuffer(Array(40).fill("")))).toBe(0);
	});
});
