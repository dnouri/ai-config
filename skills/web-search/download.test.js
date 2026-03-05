import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	parseContentDisposition,
	deriveFilename,
	formatDownloadResult,
	formatSize,
} from "./download.js";

// ---------------------------------------------------------------------------
// parseContentDisposition
// ---------------------------------------------------------------------------

describe("parseContentDisposition", () => {
	test("extracts quoted filename", () => {
		assert.equal(
			parseContentDisposition('attachment; filename="report.pdf"'),
			"report.pdf",
		);
	});

	test("extracts unquoted filename", () => {
		assert.equal(
			parseContentDisposition("attachment; filename=data.csv"),
			"data.csv",
		);
	});

	test("extracts UTF-8 encoded filename", () => {
		assert.equal(
			parseContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"),
			"résumé.pdf",
		);
	});

	test("prefers filename* over filename", () => {
		assert.equal(
			parseContentDisposition(
				'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'preferred.pdf',
			),
			"preferred.pdf",
		);
	});

	test("returns null for missing filename", () => {
		assert.equal(parseContentDisposition("attachment"), null);
	});

	test("returns null for null input", () => {
		assert.equal(parseContentDisposition(null), null);
	});

	test("returns null for empty string", () => {
		assert.equal(parseContentDisposition(""), null);
	});

	test("handles filename with spaces", () => {
		assert.equal(
			parseContentDisposition('attachment; filename="my report.pdf"'),
			"my report.pdf",
		);
	});
});

// ---------------------------------------------------------------------------
// deriveFilename
// ---------------------------------------------------------------------------

describe("deriveFilename", () => {
	test("extracts filename from URL path", () => {
		assert.equal(
			deriveFilename("https://example.com/files/report.pdf"),
			"report.pdf",
		);
	});

	test("strips query string from URL path", () => {
		assert.equal(
			deriveFilename("https://example.com/data.csv?token=abc"),
			"data.csv",
		);
	});

	test("uses Content-Disposition filename when provided", () => {
		assert.equal(
			deriveFilename(
				"https://example.com/download?id=123",
				'attachment; filename="actual-name.zip"',
			),
			"actual-name.zip",
		);
	});

	test("prefers Content-Disposition over URL path", () => {
		assert.equal(
			deriveFilename(
				"https://example.com/blob/abc123",
				'attachment; filename="release-v1.0.tar.gz"',
			),
			"release-v1.0.tar.gz",
		);
	});

	test("falls back to 'download' for bare domain URL", () => {
		assert.equal(
			deriveFilename("https://example.com/"),
			"download",
		);
	});

	test("falls back to 'download' for empty path", () => {
		assert.equal(
			deriveFilename("https://example.com"),
			"download",
		);
	});
});

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe("formatSize", () => {
	test("formats bytes for small values", () => {
		assert.equal(formatSize(0), "0 bytes");
		assert.equal(formatSize(42), "42 bytes");
		assert.equal(formatSize(1023), "1023 bytes");
	});

	test("formats kilobytes", () => {
		assert.equal(formatSize(1024), "1.0 KB");
		assert.equal(formatSize(13264), "13.0 KB");
		assert.equal(formatSize(512 * 1024), "512.0 KB");
	});

	test("formats megabytes", () => {
		assert.equal(formatSize(1024 * 1024), "1.0 MB");
		assert.equal(formatSize(3_162_618), "3.0 MB");
		assert.equal(formatSize(50 * 1024 * 1024), "50.0 MB");
	});
});

// ---------------------------------------------------------------------------
// formatDownloadResult
// ---------------------------------------------------------------------------

describe("formatDownloadResult", () => {
	test("formats download as markdown document", () => {
		const result = formatDownloadResult({
			path: "/tmp/web-search-abc/report.pdf",
			filename: "report.pdf",
			size: 13264,
			contentType: "application/pdf",
		});
		assert.match(result, /^# Downloaded: report\.pdf\n/);
		assert.match(result, /`\/tmp\/web-search-abc\/report\.pdf`/);
		assert.match(result, /application\/pdf/);
		assert.match(result, /13\.0 KB/);
	});

});
