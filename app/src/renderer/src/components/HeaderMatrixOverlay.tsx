import { useMemo } from 'react'

/** One full-width row: equal flex columns + uniform gap (same spacing as sides vs center) */
const COLS_FULL = 52
const ROWS = 12

function randomColumn(): string {
  let s = ''
  for (let i = 0; i < ROWS; i++) {
    s += Math.random() > 0.5 ? '1' : '0'
    if (i < ROWS - 1) s += '\n'
  }
  return s
}

function randomColumnMeta() {
  return {
    bits: randomColumn(),
    /** Slower scroll so digits are readable */
    duration: 1.8 + Math.random() * 1.6,
    delay: -(Math.random() * 2.5),
    reverse: Math.random() > 0.5,
    opacity: 0.16 + Math.random() * 0.18,
  }
}

type ColumnMeta = ReturnType<typeof randomColumnMeta>

/**
 * Full-bleed matrix (uniform gaps) with TRANSLATING centered on top (z-index).
 */
export function HeaderMatrixOverlay(): JSX.Element {
  const columns = useMemo(() => {
    const cols: ColumnMeta[] = []
    for (let i = 0; i < COLS_FULL; i++) {
      cols.push(randomColumnMeta())
    }
    return cols
  }, [])

  return (
    <div className="headerMatrixFx">
      <div className="headerMatrixRain" aria-hidden>
        {columns.map((col, i) => (
          <div
            key={i}
            className="headerMatrixCol"
            style={{ opacity: col.opacity }}
          >
            <div
              className="headerMatrixTrack"
              style={{
                animation: `headerMatrixFall ${col.duration}s linear ${col.delay}s infinite ${col.reverse ? 'reverse' : 'normal'}`,
              }}
            >
              <pre className="headerMatrixPre">{col.bits}</pre>
              <pre className="headerMatrixPre">{col.bits}</pre>
            </div>
          </div>
        ))}
      </div>
      <div className="headerMatrixLabelWrap">
        <span className="headerMatrixLabelText">TRANSLATING</span>
      </div>
    </div>
  )
}
