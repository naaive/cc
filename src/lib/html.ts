/**
 * Crude HTML → plain text. Drops <script>/<style>/<!-- -->, unwraps tags,
 * collapses whitespace. Good enough for docs and blog pages.
 *
 * Lives in its own file so it can be tested without pulling in langchain.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>(?=\s|$)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
