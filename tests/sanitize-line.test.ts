import { describe, expect, it } from "vitest";
import { sanitizeLine } from "../pty-session.js";

const ESC = "\x1b";

describe("sanitizeLine", () => {
	it("preserves a basic SGR truecolor sequence (regression: bug stripped ESC[ prefix)", () => {
		// The bug surfaced in pinned-widget rendering of claude's banner: SGR
		// truecolor codes leaked through as the literal text '38;2;R;G;Bm'
		// because ESC_SINGLE_REGEX matched the kept SGR's leading ESC[.
		const input = `${ESC}[38;2;215;119;87mClaude Code${ESC}[0m`;
		expect(sanitizeLine(input)).toBe(input);
	});

	it("preserves multiple chained SGR sequences in one line", () => {
		const input = `${ESC}[1m${ESC}[31mError:${ESC}[0m something went wrong`;
		expect(sanitizeLine(input)).toBe(input);
	});

	it("preserves 256-color and palette SGRs", () => {
		expect(sanitizeLine(`${ESC}[38;5;87mteal${ESC}[0m`)).toBe(`${ESC}[38;5;87mteal${ESC}[0m`);
		expect(sanitizeLine(`${ESC}[48;5;42m bg ${ESC}[0m`)).toBe(`${ESC}[48;5;42m bg ${ESC}[0m`);
	});

	it("strips non-SGR CSI sequences (e.g. cursor positioning)", () => {
		// 'H' = cursor home; should be removed since it's not SGR.
		expect(sanitizeLine(`hello${ESC}[2;5Hworld`)).toBe("helloworld");
	});

	it("strips OSC sequences (e.g. terminal title)", () => {
		expect(sanitizeLine(`${ESC}]0;my title\x07hello`)).toBe("hello");
	});

	it("strips control characters but keeps tabs (expanded to spaces)", () => {
		expect(sanitizeLine("a\tb")).toBe("a   b");
		expect(sanitizeLine("a\x01b")).toBe("ab"); // SOH stripped
	});

	it("normalizes carriage returns away", () => {
		expect(sanitizeLine("first\rsecond")).toBe("firstsecond");
	});

	it("preserves single-char Fe escapes are stripped (defensive cleanup)", () => {
		// ESC D (IND) and ESC M (RI) etc. should be stripped — they're
		// single-char Fe escapes the TUI can't represent safely.
		expect(sanitizeLine(`hello${ESC}Dworld`)).toBe("helloworld");
		expect(sanitizeLine(`hello${ESC}Mworld`)).toBe("helloworld");
	});

	it("does NOT strip the leading ESC[ off a kept SGR (anti-regression)", () => {
		// Direct probe of the bug. If ESC_SINGLE_REGEX includes '[' in its
		// character class, this test fails because '38;2;R;G;Bm' leaks through.
		const out = sanitizeLine(`${ESC}[38;2;0;0;0mhi`);
		expect(out).toContain(`${ESC}[38;2;0;0;0m`);
		expect(out).not.toMatch(/^38;2;0;0;0m/);
	});
});
