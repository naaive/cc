import { describe, expect, test } from 'bun:test'
import { htmlToText } from '../tools/htmlToText.js'

describe('htmlToText', () => {
  test('drops script and style tags entirely', () => {
    const html = '<p>visible</p><script>alert(1)</script><style>.x{}</style>'
    expect(htmlToText(html)).toContain('visible')
    expect(htmlToText(html)).not.toContain('alert(1)')
    expect(htmlToText(html)).not.toContain('.x{}')
  })

  test('decodes common entities', () => {
    expect(htmlToText('&lt;p&gt;a &amp; b&lt;/p&gt;')).toBe('<p>a & b</p>')
    expect(htmlToText('&#65;')).toBe('A')
  })

  test('collapses runs of whitespace and newlines', () => {
    const html = '<div>a</div><div>b</div><div>c</div>'
    const out = htmlToText(html)
    expect(out).toBe('a\nb\nc')
  })

  test('strips comments', () => {
    expect(htmlToText('hello<!-- secret -->world')).toBe('helloworld')
  })
})
