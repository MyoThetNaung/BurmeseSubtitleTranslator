import { motion, useReducedMotion } from 'framer-motion'

const easeInOut = [0.45, 0, 0.55, 1] as const

export type AnimatedLogoProps = {
  isTranslating: boolean
  className?: string
  size?: number
}

/**
 * Inline SVG logo with idle (float + subtle eye glow) and active (clapper, mouth, eyes) motion.
 */
export function AnimatedLogo({ isTranslating, className, size = 44 }: AnimatedLogoProps): JSX.Element {
  const reduceMotion = useReducedMotion()

  const idleFloat = !reduceMotion && !isTranslating
  const activeMotion = !reduceMotion && isTranslating

  return (
    <motion.svg
      className={['animated-logo', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      initial={false}
      animate={
        activeMotion
          ? {
              filter: [
                'drop-shadow(0 0 6px rgba(96, 165, 250, 0.35))',
                'drop-shadow(0 0 12px rgba(99, 102, 241, 0.5))',
                'drop-shadow(0 0 6px rgba(96, 165, 250, 0.35))',
              ],
            }
          : { filter: 'none' }
      }
      transition={
        activeMotion
          ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.25 }
      }
    >
      <defs>
        <linearGradient id="al-blue" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>

        <filter id="al-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="#000" floodOpacity="0.35" />
        </filter>

        <filter id="al-smallShadow">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000" floodOpacity="0.3" />
        </filter>

        <linearGradient id="al-highlight" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        <filter id="al-eyeGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <motion.g
        id="wholeLogo"
        style={{ willChange: 'transform' }}
        animate={
          idleFloat
            ? { y: [0, -6, 0] }
            : { y: 0 }
        }
        transition={
          idleFloat
            ? { duration: 2.5, repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.35, ease: easeInOut }
        }
      >
        <g transform="translate(96,110)" filter="url(#al-shadow)">
          <path
            d="
      M60 0
      H260
      Q320 0 320 60
      V160
      Q320 220 260 220
      H140
      L95 260
      Q90 235 70 220
      H60
      Q0 220 0 160
      V60
      Q0 0 60 0
      Z
    "
            fill="#e5e7eb"
          />

          <path
            d="M60 0 H260 Q320 0 320 60 V90 H0 V60 Q0 0 60 0 Z"
            fill="url(#al-highlight)"
          />

          <rect x="70" y="60" width="180" height="60" rx="30" fill="#0f172a" />

          <motion.g
            id="eyes"
            filter={activeMotion ? 'url(#al-eyeGlow)' : undefined}
            style={{ willChange: 'opacity' }}
            animate={
              activeMotion
                ? { opacity: [0.7, 1, 0.7] }
                : reduceMotion
                  ? { opacity: 1 }
                  : { opacity: [0.8, 1, 0.8] }
            }
            transition={
              activeMotion
                ? { duration: 0.75, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 2.5, repeat: Infinity, ease: 'easeInOut' }
            }
          >
            <rect x="95" y="78" width="45" height="28" rx="14" fill="url(#al-blue)" />
            <rect x="180" y="78" width="45" height="28" rx="14" fill="url(#al-blue)" />
          </motion.g>

          <rect x="120" y="145" width="80" height="30" rx="10" fill="#0f172a" />

          <g id="mouthSquares">
            {[0, 1, 2].map((i) => (
              <motion.rect
                key={i}
                x={130 + i * 20}
                y="155"
                width="15"
                height="10"
                rx="2"
                fill="#22c55e"
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'center center',
                  willChange: 'transform',
                }}
                animate={
                  activeMotion
                    ? {
                        scale: [1, 1.3, 1],
                        fill: ['#22c55e', '#4ade80', '#22c55e'],
                      }
                    : { scale: 1, fill: '#22c55e' }
                }
                transition={
                  activeMotion
                    ? {
                        duration: 0.6,
                        repeat: Infinity,
                        ease: easeInOut,
                        delay: i * 0.15,
                      }
                    : { duration: 0.2 }
                }
              />
            ))}
          </g>
        </g>

        <g transform="translate(220,320)" filter="url(#al-smallShadow)">
          <rect x="0" y="40" width="200" height="110" rx="20" fill="#f8fafc" />

          <rect x="20" y="70" width="140" height="10" rx="5" fill="#94a3b8" />
          <rect x="20" y="95" width="110" height="10" rx="5" fill="#94a3b8" />

          <path
            d="M140 75 l20 0 l-10 -10 M140 75 l20 0 l-10 10"
            stroke="#1e293b"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />

          {/* Fixed open pose — same as original SVG `rotate(-25 20 40)` (no open/close loop). */}
          <g id="clapperTop" transform="rotate(-25 20 40)">
            <rect x="0" y="0" width="200" height="50" rx="12" fill="#1e293b" />
            <rect x="10" y="10" width="40" height="10" fill="#fbbf24" />
            <rect x="60" y="10" width="40" height="10" fill="#fbbf24" />
            <rect x="110" y="10" width="40" height="10" fill="#fbbf24" />
          </g>
        </g>
      </motion.g>
    </motion.svg>
  )
}
