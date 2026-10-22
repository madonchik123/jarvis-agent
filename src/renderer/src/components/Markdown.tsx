import { Fragment, ReactNode } from 'react'

/** Tiny, dependency-free, XSS-safe markdown renderer (paragraphs, lists, code, bold/italic, links). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={i++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('*')) out.push(<em key={i++}>{tok.slice(1, -1)}</em>)
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!
      out.push(
        <a key={i++} href={mm[2]} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          {mm[1]}
        </a>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      blocks.push(
        <pre key={k++}>
          <code>{buf.join('\n')}</code>
        </pre>
      )
    } else if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''))
      blocks.push(
        <ul key={k++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ul>
      )
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      blocks.push(
        <ol key={k++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ol>
      )
    } else if (/^#{1,4}\s+/.test(line)) {
      blocks.push(
        <p key={k++}>
          <strong>{inline(line.replace(/^#{1,4}\s+/, ''))}</strong>
        </p>
      )
      i++
    } else if (!line.trim()) {
      i++
    } else {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s+/.test(lines[i])) buf.push(lines[i++])
      blocks.push(
        <p key={k++}>
          {buf.map((t, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(t)}
            </Fragment>
          ))}
        </p>
      )
    }
  }
  return <div className="md">{blocks}</div>
}
