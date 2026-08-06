/**
 * Line handling for note text, tolerant of Windows line endings.
 *
 * A vault picks up CRLF from anywhere: a note written on Windows, a file
 * clipped from a web page, a git checkout with `core.autocrlf`. That used to
 * quietly break parsing, because of how JavaScript regular expressions treat
 * the carriage return.
 *
 * `.` does not match a line terminator, and `\r` is one. `$` without the `m`
 * flag matches only at the end of the input. So a pattern ending `(.*)$` — the
 * shape used for headings and tasks — cannot match `- [ ] task\r` at all: the
 * `.*` stops before the `\r`, and `$` is not there yet. The line silently is
 * not a task, and no error says so.
 *
 * The effect was that a CRLF note contributed no headings and no tasks:
 * `list_tasks` did not see them, `get_outline` returned nothing, and
 * `toggle_task` refused with "not a task" for a line that plainly was one.
 */

/** One line without its trailing carriage return. */
export function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Split text into lines with line endings normalised away.
 *
 * Indices still correspond to the file's own lines, so a line number derived
 * from this array points at the right line on disk.
 */
export function splitLines(text: string): string[] {
  return text.split("\n").map(stripCr);
}
