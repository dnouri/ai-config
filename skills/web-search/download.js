/**
 * Binary content download via curl.
 */

import { execFileSync } from "child_process";
import { statSync, mkdtempSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Parse filename from a Content-Disposition header value.
 *
 * Handles: filename*=UTF-8''encoded, filename="quoted", filename=bare.
 * Prefers filename* (RFC 6266) over filename.
 *
 * @param {string|null} header - Content-Disposition header value
 * @returns {string|null} Extracted filename, or null
 */
export function parseContentDisposition(header) {
	if (!header) return null;

	// filename*=UTF-8''encoded (RFC 6266)
	const utf8Match = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
	if (utf8Match) return decodeURIComponent(utf8Match[1]);

	// filename="quoted"
	const quotedMatch = header.match(/filename="([^"]+)"/);
	if (quotedMatch) return quotedMatch[1];

	// filename=bare
	const bareMatch = header.match(/filename=([^;\s]+)/);
	if (bareMatch) return bareMatch[1];

	return null;
}

/**
 * Derive a filename for a downloaded file.
 *
 * Uses Content-Disposition header if provided, otherwise extracts
 * the basename from the URL path. Falls back to "download".
 *
 * @param {string} url - Original request URL
 * @param {string|null} [contentDisposition] - Content-Disposition header value
 * @returns {string} Filename
 */
export function deriveFilename(url, contentDisposition) {
	const fromHeader = parseContentDisposition(contentDisposition);
	if (fromHeader) return fromHeader;

	try {
		const urlPath = new URL(url).pathname;
		const base = basename(urlPath);
		return base && base !== "/" ? base : "download";
	} catch {
		return "download";
	}
}

/**
 * Format a human-readable file size.
 */
export function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a download result as a markdown document.
 *
 * @param {{ path: string, filename: string, size: number, contentType: string }} result
 * @returns {string} Markdown document
 */
export function formatDownloadResult(result) {
	const lines = [
		`# Downloaded: ${result.filename}`,
		"",
		`**File:** \`${result.path}\``,
		`**Type:** ${result.contentType}`,
		`**Size:** ${formatSize(result.size)}`,
	];
	return lines.join("\n");
}

/**
 * Check a URL's content-type via curl HEAD request.
 *
 * Follows redirects. Returns the content-type and HTTP status of the
 * final response.
 *
 * @param {string} url
 * @returns {{ contentType: string, httpCode: string, effectiveUrl: string }}
 */
export function headContentType(url) {
	const output = execFileSync("curl", [
		"-sI", "-L",
		"--max-time", "10",
		"-o", "/dev/null",
		"-w", JSON.stringify({
			content_type: "%{content_type}",
			http_code: "%{http_code}",
			url_effective: "%{url_effective}",
		}),
		url,
	], { encoding: "utf-8", timeout: 15_000 });

	const info = JSON.parse(output);
	return {
		contentType: info.content_type || "",
		httpCode: info.http_code,
		effectiveUrl: info.url_effective,
	};
}

/**
 * Get the Content-Disposition header from a URL via curl HEAD request.
 *
 * @param {string} url
 * @returns {string|null} Content-Disposition header value, or null
 */
function headContentDisposition(url) {
	try {
		const headers = execFileSync("curl", [
			"-sI", "-L",
			"--max-time", "10",
			url,
		], { encoding: "utf-8", timeout: 15_000 });

		for (const line of headers.split("\n")) {
			if (line.toLowerCase().startsWith("content-disposition:")) {
				return line.substring("content-disposition:".length).trim();
			}
		}
	} catch {}
	return null;
}

/**
 * Download a URL to a temp directory via curl.
 *
 * Follows redirects, respects Content-Disposition for filename,
 * and enforces a 50 MB size limit.
 *
 * @param {string} url
 * @param {{ contentType?: string }} [head] - Pre-fetched HEAD result
 * @returns {{ path: string, filename: string, size: number, contentType: string }}
 */
export function downloadToTemp(url, head) {
	const contentDisposition = headContentDisposition(url);
	const filename = deriveFilename(url, contentDisposition);

	const tmpDir = mkdtempSync(join(tmpdir(), "web-search-"));
	const outPath = join(tmpDir, filename);

	execFileSync("curl", [
		"-sL",
		"--max-time", "60",
		"--max-filesize", String(MAX_DOWNLOAD_SIZE),
		"-o", outPath,
		url,
	], { timeout: 70_000 });

	const stat = statSync(outPath);
	return {
		path: outPath,
		filename,
		size: stat.size,
		contentType: head?.contentType || "application/octet-stream",
	};
}
