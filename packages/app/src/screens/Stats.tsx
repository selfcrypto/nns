/**
 * `#/stats`: the registry counted (2026-09-24). A page, not a tab — reached
 * from the masthead's nav — and like Market's lists it is display material:
 * every figure comes from one `/stats` snapshot of the first configured
 * resolver, and the page says so rather than vouching for it.
 *
 * **Asked once, never on a timer.** One `/stats` request and, when a relay is
 * configured, one `getBlockNumber` when the page opens — and, when an anchor
 * chain is configured (`VITE_NNS_ANCHORS`), one `Anchored` sweep per listed
 * endpoint for the newest anchor; a reload is the refresh. A number that moves costs one request per client per tick
 * (decisions.md), and the API only recounts once a batch anyway.
 *
 * The charts are inline SVG and HTML bars — no chart library, for the reason
 * the app has no webfont. One hue carries data (Nimiq blue), a grey carries
 * context, and the status colours appear only where a figure *is* a status:
 * the verdict columns.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createAnchorReadRpc, latestAnchoredHeight, type AnchorHeightLookup } from '@nimiqnames/resolver'
import { anchorConfig, type AnchorConfig } from '../config'
import { getStats, type Stats } from '../lib/api'
import { approxDate, blocksApprox, ellipsizeAddress, formatApproxWhen, group, lunaToNim, lunaToNimShort } from '../lib/format'
import { LUNA_PER_NIM } from '@nimiqnames/core'
import { defaultTransport } from '../lib/history'
import { apiBase } from '../lib/nns'
import { formatRoute } from '../lib/route'
import {
  activitySeries,
  compactCount,
  cumulativeRegistrations,
  namesByBand,
  verdictClass,
  verdictText,
  verdictTotals,
  type Series,
  type VerdictClass,
} from '../lib/stats'
import { useAsync } from '../lib/useAsync'
import {
  STATS_SECTION,
  STATS_STATUS,
  STATS_TYPE_LABEL,
  STATS_VERDICT_CLASS,
  statsActivityPerDay,
  statsActivityPerHour,
  statsAgoLine,
  statsAnchorsHint,
  statsAnchorsNoneInWindow,
  statsAnchorsPublishers,
  statsAnchorsReading,
  statsAnchorsUnavailable,
  statsAnchorsUnconfigured,
  statsAsOfLine,
  statsBandLabel,
  statsBlocksLine,
  statsBurnedOfOwed,
  statsBurnTitle,
  statsByTypeTitle,
  statsChain,
  statsChainHint,
  statsFacts,
  statsFactsHint,
  statsFailedLine,
  statsGrowthLabel,
  statsHolderCount,
  statsHoldersTitle,
  statsJumpLabel,
  statsKpi,
  statsKpiHint,
  statsLeaderboardHint,
  statsLeaderboardTitle,
  statsLengthHint,
  statsLengthTitle,
  statsLifetimeTag,
  statsLoadingLine,
  statsMarket,
  statsNamesHeroLabel,
  statsNoActivityLine,
  statsNoneYet,
  statsNoReferralsLine,
  statsOwnersLine,
  statsRecentTitle,
  statsReferralCount,
  statsReferredLabel,
  statsReferrersLabel,
  statsRejectionsTitle,
  statsRetryLabel,
  statsSeriesOther,
  statsSeriesRegistrations,
  statsStatusTitle,
  statsSub,
  statsTitle,
  statsTreasury,
  statsTreasuryHint,
  statsTxCount,
  statsUnavailable,
  statsUnknownTypeLabel,
  statsVerdictsHint,
  statsVerdictsTitle,
  type StatsSection,
} from '../lib/wording'
import { Hint } from '../components/Hint'
import { Identicon, Spinner } from '../components/ui'
import styles from './stats.module.css'

const SECTIONS: readonly StatsSection[] = ['overview', 'activity', 'names', 'market', 'referrals', 'treasury', 'chain']

/** Whole NIM at a glance, and exact below one NIM, where the glance would print dust as `0.00`. */
const nimFigure = (luna: bigint): string => (luna === 0n ? '0' : luna < LUNA_PER_NIM ? lunaToNim(luna) : lunaToNimShort(luna))
const nim = (luna: bigint): string => `${nimFigure(luna)} NIM`

/** The chain's head, asked once — the page's only read that is not `/stats`. */
function useChainHead(): number | null {
  const [head, setHead] = useState<number | null>(null)
  useEffect(() => {
    const transport = defaultTransport()
    if (transport === null) return
    let live = true
    transport('getBlockNumber', [])
      .then((answer) => {
        if (live && typeof answer === 'number') setHead(answer)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return head
}

/**
 * The newest anchor on the configured chain (§9), asked once. Discovery
 * only — `latestAnchoredHeight` reports what at least two endpoints agree
 * was anchored, by whom and when; it decides nothing, and the page says
 * where the figure came from rather than vouching for it.
 */
type AnchorState =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'loading'; readonly config: AnchorConfig }
  | { readonly status: 'failed'; readonly config: AnchorConfig }
  | { readonly status: 'done'; readonly config: AnchorConfig; readonly lookup: AnchorHeightLookup }

function useLatestAnchor(): AnchorState {
  const config = useMemo(() => anchorConfig(), [])
  const [state, setState] = useState<AnchorState>(() => (config === null ? { status: 'unconfigured' } : { status: 'loading', config }))
  useEffect(() => {
    if (config === null) return
    let live = true
    latestAnchoredHeight(
      config.rpcs.map((url) => createAnchorReadRpc(url)),
      {
        contractAddress: config.contract,
        publishers: config.publishers,
        ...(config.lookbackBlocks === null ? {} : { lookbackBlocks: config.lookbackBlocks }),
      },
    ).then(
      (lookup) => {
        if (live) setState({ status: 'done', config, lookup })
      },
      () => {
        if (live) setState({ status: 'failed', config })
      },
    )
    return () => {
      live = false
    }
  }, [config])
  return state
}

/** Seconds since, as the checkpoint row prints them: exact under a minute and a half, approximate above. */
const ageText = (seconds: number): string => (seconds < 90 ? `${seconds} s` : blocksApprox(seconds))

export function StatsScreen() {
  const [attempt, setAttempt] = useState(0)
  const stats = useAsync(() => getStats(apiBase()), [attempt])
  const head = useChainHead()
  const anchor = useLatestAnchor()

  return (
    <div className={`screen ${styles.page}`}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <h1 className={styles.title}>{statsTitle()}</h1>
          <p className={styles.sub}>{statsSub()}</p>
          {stats.status === 'done' && <p className={styles.asOf}>{statsAsOfLine(group(stats.value.height))}</p>}
        </header>
        {(stats.status === 'loading' || stats.status === 'idle') && (
          <div className={styles.state}>
            <Spinner />
            <span>{statsLoadingLine()}</span>
          </div>
        )}
        {stats.status === 'error' && (
          <div className={styles.state}>
            <p className="field-error">{statsFailedLine()}</p>
            <button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
              {statsRetryLabel()}
            </button>
          </div>
        )}
        {stats.status === 'done' && <StatsBody stats={stats.value} head={head} anchor={anchor} />}
      </div>
    </div>
  )
}

function StatsBody({ stats, head, anchor }: { stats: Stats; head: number | null; anchor: AnchorState }) {
  const nowMs = useMemo(() => Date.now(), [])
  const series = useMemo(() => activitySeries(stats), [stats])
  const refs = useRef<Partial<Record<StatsSection, HTMLElement | null>>>({})
  const jump = (section: StatsSection) => refs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const bind = (section: StatsSection) => (element: HTMLElement | null) => {
    refs.current[section] = element
  }
  const dateOf = (height: number) => approxDate(height, stats.height, nowMs)

  return (
    <>
      <nav className={styles.jump} aria-label={statsJumpLabel()}>
        {SECTIONS.map((section) => (
          <button key={section} type="button" className={styles.jumpChip} onClick={() => jump(section)}>
            {STATS_SECTION[section]}
          </button>
        ))}
      </nav>

      <section ref={bind('overview')} className={styles.section} aria-label={STATS_SECTION.overview}>
        <Overview stats={stats} series={series} dateOf={dateOf} />
      </section>

      <Section title={STATS_SECTION.activity} bindRef={bind('activity')}>
        <Activity stats={stats} series={series} dateOf={dateOf} />
      </Section>

      <Section title={STATS_SECTION.names} bindRef={bind('names')}>
        <Names stats={stats} dateOf={dateOf} nowMs={nowMs} />
      </Section>

      <Section title={STATS_SECTION.market} bindRef={bind('market')}>
        <Market stats={stats} />
      </Section>

      <Section title={STATS_SECTION.referrals} bindRef={bind('referrals')}>
        <Referrals stats={stats} />
      </Section>

      <Section title={STATS_SECTION.treasury} bindRef={bind('treasury')}>
        <Treasury stats={stats} />
      </Section>

      <Section title={STATS_SECTION.chain} bindRef={bind('chain')}>
        <Chain stats={stats} head={head} anchor={anchor} nowMs={nowMs} />
      </Section>
    </>
  )
}

function Section({ title, bindRef, children }: { title: string; bindRef: (element: HTMLElement | null) => void; children: ReactNode }) {
  return (
    <section ref={bindRef} className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Card({ title, hint, wide, children }: { title?: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`${styles.card} ${wide === true ? styles.wide : ''}`}>
      {title !== undefined && (
        <h3 className={styles.cardTitle}>
          {title}
          {hint !== undefined && <Hint>{hint}</Hint>}
        </h3>
      )}
      {children}
    </div>
  )
}

function Tile({ label, value, detail, hint }: { label: string; value: string; detail?: ReactNode; hint?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>
        {label}
        {hint !== undefined && <Hint>{hint}</Hint>}
      </span>
      <span className={styles.tileValue}>{value}</span>
      {detail !== undefined && <span className={styles.tileDetail}>{detail}</span>}
    </div>
  )
}

/** A labelled horizontal bar: the label and its value on one line, the bar under them. */
function BarRow({ label, value, max, shown, lead }: { label: ReactNode; value: number; max: number; shown?: string; lead?: ReactNode }) {
  const width = max === 0 ? 0 : Math.max(value === 0 ? 0 : 2, (value / max) * 100)
  return (
    <li className={styles.barRow}>
      <span className={styles.barHead}>
        {lead}
        <span className={styles.barLabel}>{label}</span>
        <span className={styles.barValue}>{shown ?? group(value)}</span>
      </span>
      <span className={styles.barTrack}>
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
    </li>
  )
}

/** Parts of a whole in one bar, a 2px gap between segments, and a legend under it. */
function Meter({ parts }: { parts: readonly { key: string; label: string; value: number; tone: string }[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div className={styles.meter}>
      <div className={styles.meterBar} role="img" aria-label={parts.map((part) => `${part.label} ${part.value}`).join(', ')}>
        {total === 0 ? (
          <span className={styles.meterEmpty} />
        ) : (
          parts
            .filter((part) => part.value > 0)
            .map((part) => <span key={part.key} className={`${styles.meterPart} ${part.tone}`} style={{ flexGrow: part.value }} />)
        )}
      </div>
      <ul className={styles.legend}>
        {parts.map((part) => (
          <li key={part.key}>
            <span className={`${styles.swatch} ${part.tone}`} aria-hidden="true" />
            {part.label}
            <strong>{group(part.value)}</strong>
            {total > 0 && <span className={styles.pct}>{Math.round((part.value / total) * 100)}%</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A number that counts up once, on arrival. Instant under reduced motion. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 900)
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return <>{group(shown)}</>
}

/** An axis label: a date for days, the bare hour for hours (buckets start mid-hour, so minutes are noise). */
function formatTick(date: Date, unit: Series['unit']): string {
  return unit === 'day'
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleTimeString(undefined, { hour: 'numeric' })
}

function formatPointDate(date: Date, unit: Series['unit']): string {
  return unit === 'day'
    ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}

/**
 * The hover layer both charts share: the nearest point to the pointer, or
 * the focused one from the keyboard. A tooltip enhances; every value is also
 * in the bars and labels around it.
 */
function useNearest(count: number) {
  const [active, setActive] = useState<number | null>(null)
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width
    setActive(Math.max(0, Math.min(count - 1, Math.round(x * (count - 1)))))
  }
  return { active, setActive, onMove, onLeave: () => setActive(null) }
}

const CHART_W = 600

/** Cumulative registrations as a line over a 10% wash. */
function GrowthChart({ series, values, dateOf }: { series: Series; values: readonly number[]; dateOf: (height: number) => Date }) {
  const H = 120
  const pad = 6
  const max = Math.max(1, ...values)
  const n = values.length
  const x = (i: number) => (n === 1 ? CHART_W / 2 : (i / (n - 1)) * CHART_W)
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`
  const hover = useNearest(n)
  const at = hover.active
  const first = series.points[0]
  const last = series.points[n - 1]
  return (
    <figure className={styles.growth}>
      <figcaption className={styles.chartCaption}>{statsGrowthLabel()}</figcaption>
      <div className={styles.plot}>
        <svg
          viewBox={`0 0 ${CHART_W} ${H}`}
          preserveAspectRatio="none"
          className={styles.svg}
          style={{ height: H }}
          onPointerMove={hover.onMove}
          onPointerLeave={hover.onLeave}
          role="img"
          aria-label={`${statsGrowthLabel()}: ${values[n - 1] ?? 0}`}
        >
          <path d={area} className={styles.areaFill} />
          <path d={line} className={styles.areaLine} vectorEffect="non-scaling-stroke" />
          {at !== null && <line x1={x(at)} x2={x(at)} y1={0} y2={H} className={styles.crosshair} vectorEffect="non-scaling-stroke" />}
        </svg>
        {n > 0 && (
          <span className={styles.endDot} style={{ left: `${(x(at ?? n - 1) / CHART_W) * 100}%`, top: y(values[at ?? n - 1] ?? 0) }} />
        )}
        {at !== null && series.points[at] !== undefined && (
          <Tooltip left={(x(at) / CHART_W) * 100}>
            <span>{formatPointDate(dateOf(series.points[at].height), series.unit)}</span>
            <strong>{group(values[at] ?? 0)}</strong>
          </Tooltip>
        )}
      </div>
      {first !== undefined && last !== undefined && (
        <div className={styles.axis}>
          <span>{formatPointDate(dateOf(first.height), series.unit)}</span>
          <span>{formatPointDate(dateOf(last.height), series.unit)}</span>
        </div>
      )}
    </figure>
  )
}

function Tooltip({ left, children }: { left: number; children: ReactNode }) {
  const clamped = Math.max(12, Math.min(88, left))
  return (
    <div className={styles.tooltip} style={{ left: `${clamped}%` }}>
      {children}
    </div>
  )
}

/** Registrations in blue on top of every other message in grey, per bucket. */
function ActivityChart({ series, dateOf }: { series: Series; dateOf: (height: number) => Date }) {
  const H = 150
  const points = series.points
  const n = points.length
  const max = Math.max(1, ...points.map((p) => p.lines))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1] ?? max
  const slot = CHART_W / Math.max(1, n)
  const barW = Math.min(24, slot * 0.7)
  const scale = (v: number) => (v / top) * (H - 4)
  const hover = useNearest(n)
  const at = hover.active
  const quiet = points.every((p) => p.lines === 0)
  const labelEvery = Math.max(1, Math.ceil(n / 5))
  return (
    <figure className={styles.activity}>
      <figcaption className={styles.chartCaption}>{series.unit === 'day' ? statsActivityPerDay() : statsActivityPerHour()}</figcaption>
      <ul className={styles.legend}>
        <li>
          <span className={`${styles.swatch} ${styles.toneData}`} aria-hidden="true" />
          {statsSeriesRegistrations()}
        </li>
        <li>
          <span className={`${styles.swatch} ${styles.toneContext}`} aria-hidden="true" />
          {statsSeriesOther()}
        </li>
      </ul>
      {quiet ? (
        <p className={styles.muted}>{statsNoActivityLine()}</p>
      ) : (
        <div className={styles.plot}>
          <div className={styles.yTicks} style={{ height: H }}>
            {ticks
              .slice()
              .reverse()
              .map((tick) => (
                <span key={tick} style={{ bottom: `${(scale(tick) / H) * 100}%` }}>
                  {compactCount(tick)}
                </span>
              ))}
          </div>
          <svg
            viewBox={`0 0 ${CHART_W} ${H}`}
            preserveAspectRatio="none"
            className={styles.svg}
            style={{ height: H }}
            onPointerMove={hover.onMove}
            onPointerLeave={hover.onLeave}
            role="img"
            aria-label={series.unit === 'day' ? statsActivityPerDay() : statsActivityPerHour()}
          >
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={CHART_W} y1={H - scale(tick)} y2={H - scale(tick)} className={styles.grid} vectorEffect="non-scaling-stroke" />
            ))}
            {points.map((point, i) => {
              const cx = slot * i + slot / 2
              const other = point.lines - point.registrations
              const hReg = scale(point.registrations)
              const hOther = scale(other)
              const gap = hReg > 0 && hOther > 0 ? 2 : 0
              return (
                <g key={point.height} className={at !== null && at !== i ? styles.dim : undefined}>
                  {hOther > 0 && <rect x={cx - barW / 2} y={H - hOther} width={barW} height={hOther} className={styles.barContext} />}
                  {hReg > 0 && (
                    <rect x={cx - barW / 2} y={H - hOther - hReg - gap} width={barW} height={hReg} className={styles.barData} />
                  )}
                </g>
              )
            })}
          </svg>
          {at !== null && points[at] !== undefined && (
            <Tooltip left={((slot * at + slot / 2) / CHART_W) * 100}>
              <span>{formatPointDate(dateOf(points[at].height), series.unit)}</span>
              <span>
                <i className={`${styles.swatch} ${styles.toneData}`} /> {statsSeriesRegistrations()} <strong>{group(points[at].registrations)}</strong>
              </span>
              <span>
                <i className={`${styles.swatch} ${styles.toneContext}`} /> {statsSeriesOther()}{' '}
                <strong>{group(points[at].lines - points[at].registrations)}</strong>
              </span>
            </Tooltip>
          )}
        </div>
      )}
      {!quiet && (
        <div className={styles.xTicks}>
          {points.map((point, i) =>
            i % labelEvery === 0 ? (
              <span key={point.height} style={{ left: `${((slot * i + slot / 2) / CHART_W) * 100}%` }}>
                {formatTick(dateOf(point.height), series.unit)}
              </span>
            ) : null,
          )}
        </div>
      )}
    </figure>
  )
}

/** Up to four clean ticks from zero: 0 / 5 / 10 / 15, 0 / 250 / 500. */
function niceTicks(max: number): number[] {
  const rough = max / 3
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10
  const whole = Math.max(1, Math.ceil(step))
  const ticks: number[] = []
  for (let v = whole; v < max + whole; v += whole) ticks.push(v)
  return ticks
}

// ── Sections ────────────────────────────────────────────────────────────────

function Overview({ stats, series, dateOf }: { stats: Stats; series: Series; dateOf: (height: number) => Date }) {
  const values = useMemo(() => cumulativeRegistrations(stats, series), [stats, series])
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroFigure}>
          <span className={styles.heroLabel}>{statsNamesHeroLabel()}</span>
          <span className={styles.heroValue}>
            <CountUp value={stats.names.total} />
          </span>
          <span className={styles.heroDetail}>{statsOwnersLine(group(stats.names.owners))}</span>
        </div>
        <GrowthChart series={series} values={values} dateOf={dateOf} />
      </div>
      <div className={styles.kpis}>
        <Tile label={statsKpi.revenue} value={nim(stats.money.revenue)} hint={statsKpiHint.revenue} />
        <Tile label={statsKpi.messages} value={compactCount(stats.log.lines)} hint={statsKpiHint.messages} />
        <Tile label={statsKpi.senders} value={compactCount(stats.log.senders)} hint={statsKpiHint.senders} />
        <Tile label={statsKpi.referred} value={compactCount(stats.referrals.registrations)} hint={statsKpiHint.referred} />
      </div>
    </>
  )
}

const VERDICT_TONE: Record<VerdictClass, string> = { ok: styles.toneOk ?? '', refund: styles.toneRefund ?? '', forfeit: styles.toneForfeit ?? '' }

function Activity({ stats, series, dateOf }: { stats: Stats; series: Series; dateOf: (height: number) => Date }) {
  const totals = verdictTotals(stats.log.byVerdict)
  const rejections = stats.log.byVerdict.filter((row) => row.verdict !== 'OK')
  const maxType = Math.max(0, ...stats.log.byType.map((row) => row.lines))
  const maxRejection = Math.max(0, ...rejections.map((row) => row.lines))
  return (
    <div className={styles.grid}>
      <Card wide>
        <ActivityChart series={series} dateOf={dateOf} />
      </Card>
      <Card title={statsByTypeTitle()}>
        <ul className={styles.bars}>
          {stats.log.byType.map((row) => (
            <BarRow
              key={row.type}
              lead={<span className={styles.typeTag}>{row.type}</span>}
              label={STATS_TYPE_LABEL[row.type] ?? statsUnknownTypeLabel()}
              value={row.lines}
              max={maxType}
            />
          ))}
        </ul>
      </Card>
      <Card title={statsVerdictsTitle()} hint={statsVerdictsHint()}>
        <Meter
          parts={(['ok', 'refund', 'forfeit'] as const).map((key) => ({ key, label: STATS_VERDICT_CLASS[key], value: totals[key], tone: VERDICT_TONE[key] }))}
        />
        {rejections.length > 0 && (
          <>
            <h4 className={styles.subTitle}>{statsRejectionsTitle()}</h4>
            <ul className={styles.bars}>
              {rejections.map((row) => (
                <BarRow
                  key={row.verdict}
                  lead={<span className={`${styles.swatch} ${VERDICT_TONE[verdictClass(row.verdict)]}`} aria-hidden="true" />}
                  label={verdictText(row.verdict)}
                  value={row.lines}
                  max={maxRejection}
                />
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  )
}

function Names({ stats, dateOf, nowMs }: { stats: Stats; dateOf: (height: number) => Date; nowMs: number }) {
  const bands = namesByBand(stats.names.byLength)
  const maxBand = Math.max(0, ...bands.map((band) => band.names))
  const { names } = stats
  const facts: readonly [string, number, string | undefined][] = [
    [statsFacts.lifetime, names.lifetimeTerms, statsFactsHint.lifetime],
    [statsFacts.renewals, names.renewals, undefined],
    [statsFacts.evm, names.withEvm, undefined],
    [statsFacts.delegated, names.delegated, undefined],
    [statsFacts.pointed, names.pointedElsewhere, statsFactsHint.pointed],
    [statsFacts.renewSoon, names.renewSoon, statsFactsHint.renewSoon],
    [statsFacts.released, names.released, statsFactsHint.released],
  ]
  return (
    <div className={styles.grid}>
      <Card title={statsLengthTitle()} hint={statsLengthHint()}>
        <ul className={styles.bars}>
          {bands.map((band) => (
            <BarRow key={band.from} label={statsBandLabel(band.from, band.upTo)} value={band.names} max={maxBand} />
          ))}
        </ul>
      </Card>
      <Card title={statsStatusTitle()}>
        <Meter
          parts={[
            { key: 'registered', label: STATS_STATUS.registered, value: names.registered, tone: styles.toneData ?? '' },
            { key: 'grace', label: STATS_STATUS.grace, value: names.grace, tone: styles.toneGrace ?? '' },
          ]}
        />
        <dl className={styles.facts}>
          {facts.map(([label, value, hint]) => (
            <div key={label} className={styles.fact}>
              <dt>
                {label}
                {hint !== undefined && <Hint>{hint}</Hint>}
              </dt>
              <dd>{group(value)}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={statsHoldersTitle()}>
        <ol className={styles.ranked}>
          {names.topHolders.map((holder, index) => (
            <li key={holder.owner}>
              <span className={styles.rank}>{index + 1}</span>
              <Identicon address={holder.owner} size={28} />
              <span className={`${styles.rankLabel} ${styles.mono}`}>{ellipsizeAddress(holder.owner)}</span>
              <span className={styles.rankValue}>{statsHolderCount(holder.names)}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title={statsRecentTitle()}>
        <ul className={styles.recent}>
          {names.recent.map((item) => (
            <li key={`${item.name}:${item.height}`}>
              <a href={formatRoute({ tab: 'buy', param: item.name })}>
                <span className="nns-name">{item.name}</span>
                {item.lifetime && <span className={styles.tag}>{statsLifetimeTag()}</span>}
                <span className={styles.when}>{formatApproxWhen(dateOf(item.height), nowMs)}</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function Market({ stats }: { stats: Stats }) {
  const { market } = stats
  return (
    <div className={styles.grid}>
      <Card wide>
        <div className={styles.tiles}>
          <Tile label={statsMarket.openOffers} value={group(market.openOffers)} />
          <Tile label={statsMarket.openAuctions} value={group(market.openAuctions)} />
          <Tile label={statsMarket.sales} value={group(market.sales)} />
          <Tile label={statsMarket.saleVolume} value={nim(market.saleVolume)} />
          <Tile label={statsMarket.listings} value={group(market.listings)} />
          <Tile label={statsMarket.auctions} value={group(market.auctions)} />
          <Tile label={statsMarket.bids} value={group(market.bids)} />
          <Tile label={statsMarket.pendingTransfers} value={group(market.pendingTransfers)} />
        </div>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>{statsMarket.topSale}</dt>
            <dd>
              {market.topSale === null ? (
                <span className={styles.muted}>{statsNoneYet()}</span>
              ) : (
                <>
                  <span className="nns-name">{market.topSale.name}</span> · {nim(market.topSale.price)}
                </>
              )}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>{statsMarket.topBid}</dt>
            <dd>
              {market.topBid === null ? (
                <span className={styles.muted}>{statsNoneYet()}</span>
              ) : (
                <>
                  <span className="nns-name">{market.topBid.name}</span> · {nim(market.topBid.bid)}
                </>
              )}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}

function Referrals({ stats }: { stats: Stats }) {
  const { referrals } = stats
  const max = Math.max(0, ...referrals.top.map((row) => row.registrations))
  return (
    <div className={styles.grid}>
      <Card>
        <div className={styles.tiles}>
          <Tile label={statsReferredLabel()} value={group(referrals.registrations)} />
          <Tile label={statsReferrersLabel()} value={group(referrals.referrers)} />
        </div>
      </Card>
      <Card title={statsLeaderboardTitle()} hint={statsLeaderboardHint()}>
        {referrals.top.length === 0 ? (
          <p className={styles.muted}>{statsNoReferralsLine()}</p>
        ) : (
          <ol className={styles.bars}>
            {referrals.top.map((row, index) => (
              <BarRow
                key={row.name}
                lead={<span className={`${styles.rank} ${index === 0 ? styles.rankFirst : ''}`}>{index + 1}</span>}
                label={
                  <>
                    <span className="nns-name">{row.name}</span>
                    <span className={styles.leaderDetail}>{nim(row.volume)}</span>
                  </>
                }
                value={row.registrations}
                max={max}
                shown={statsReferralCount(row.registrations)}
              />
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}

function Treasury({ stats }: { stats: Stats }) {
  const { money } = stats
  const burnedShare = money.owed === 0n ? 0 : Number((money.burned * 1000n) / money.owed) / 10
  return (
    <div className={styles.grid}>
      <Card>
        <div className={styles.tiles}>
          <Tile label={statsTreasury.revenue} value={nim(money.revenue)} hint={statsKpiHint.revenue} />
          <Tile label={statsTreasury.payouts} value={nim(money.payouts.amount)} detail={statsTxCount(money.payouts.count)} hint={statsTreasuryHint.payouts} />
          <Tile label={statsTreasury.refunded} value={nim(money.refunded.amount)} detail={statsTxCount(money.refunded.count)} />
          <Tile label={statsTreasury.forfeited} value={nim(money.forfeited.amount)} detail={statsTxCount(money.forfeited.count)} />
          <Tile label={statsTreasury.outstanding} value={nim(money.outstanding.amount)} detail={statsTxCount(money.outstanding.count)} hint={statsTreasuryHint.outstanding} />
        </div>
      </Card>
      <Card title={statsBurnTitle()}>
        <div className={styles.progress} role="img" aria-label={statsBurnedOfOwed(nimFigure(money.burned), nimFigure(money.owed))}>
          <span className={styles.progressFill} style={{ width: `${Math.min(100, burnedShare)}%` }} />
        </div>
        <p className={styles.progressLine}>
          {statsBurnedOfOwed(nimFigure(money.burned), nimFigure(money.owed))}
          <strong>{Math.round(burnedShare)}%</strong>
        </p>
      </Card>
    </div>
  )
}

function AnchorValue({ state, nowMs }: { state: AnchorState; nowMs: number }) {
  if (state.status === 'unconfigured') return <span className={styles.muted}>{statsAnchorsUnconfigured()}</span>
  const { chain, explorer } = state.config
  if (state.status === 'loading') return <span className={styles.muted}>{statsAnchorsReading(chain)}</span>
  if (state.status === 'failed' || state.lookup.status === 'unavailable' || state.lookup.status === 'not-checked') {
    return <span className={styles.muted}>{statsAnchorsUnavailable(chain)}</span>
  }
  if (state.lookup.status === 'none') return statsAnchorsNoneInWindow(chain, group(state.lookup.lookbackBlocks))
  const { height, timestamp, publishers } = state.lookup
  const ageSec = Math.max(0, Math.round(nowMs / 1000 - timestamp))
  const where =
    explorer === null ? (
      chain
    ) : (
      <a href={explorer} target="_blank" rel="noopener noreferrer">
        {chain}
      </a>
    )
  return (
    <>
      {group(height)}
      <span className={styles.leaderDetail}>
        {statsAgoLine(ageText(ageSec))} · {statsAnchorsPublishers(publishers.length)} · {where}
      </span>
    </>
  )
}

function Chain({ stats, head, anchor, nowMs }: { stats: Stats; head: number | null; anchor: AnchorState; nowMs: number }) {
  const latest = stats.checkpoints.latest
  const interval = stats.chain.checkpointInterval
  const ageSec = latest === null ? null : Math.max(0, Math.round((nowMs - Date.parse(latest.createdAt)) / 1000))
  const rows: readonly [string, ReactNode, string | undefined][] = [
    [statsChain.head, head === null ? <span className={styles.muted}>{statsUnavailable()}</span> : group(head), statsChainHint.head],
    [statsChain.indexed, stats.chain.scannedThrough === null ? statsUnavailable() : group(stats.chain.scannedThrough), statsChainHint.indexed],
    [
      statsChain.checkpoint,
      latest === null ? (
        statsNoneYet()
      ) : (
        <>
          {group(latest.height)}
          {ageSec !== null && <span className={styles.leaderDetail}>{statsAgoLine(ageText(ageSec))}</span>}
        </>
      ),
      statsChainHint.checkpoint,
    ],
    [statsChain.cadence, statsBlocksLine(group(interval), blocksApprox(interval)), undefined],
    [statsChain.retained, group(stats.checkpoints.retained), undefined],
    [
      statsChain.commitment,
      latest === null ? statsNoneYet() : <span className={styles.mono} title={latest.commitment}>{`${latest.commitment.slice(0, 10)}…${latest.commitment.slice(-8)}`}</span>,
      statsChainHint.commitment,
    ],
    [
      statsChain.anchors,
      <AnchorValue state={anchor} nowMs={nowMs} />,
      anchor.status === 'unconfigured' ? undefined : statsAnchorsHint(anchor.config.chain),
    ],
    [statsChain.launch, group(stats.chain.launchHeight), undefined],
  ]
  return (
    <div className={styles.grid}>
      <Card wide>
        <dl className={`${styles.facts} ${styles.factsTwo}`}>
          {rows.map(([label, value, hint]) => (
            <div key={label} className={styles.fact}>
              <dt>
                {label}
                {hint !== undefined && <Hint>{hint}</Hint>}
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}
