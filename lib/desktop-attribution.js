/**
 * Desktop reply attribution and completion judgement.
 *
 * Pure, side-effect free ESM. It never touches the Antigravity app, a private
 * API or a database: the caller (t9) feeds normalized UIA snapshots and this
 * module decides whether the current round's final assistant text can be
 * attributed to the job that was dispatched.
 *
 * Snapshot contract (as fixed by the team handover):
 *
 *   {
 *     targetKey: string,                 // pinned window + normalized document URI
 *     turns: Array<{ role: 'user'|'assistant', text: string }>,
 *     phase: 'idle'|'busy'|'permission'|'unknown',
 *     complete: boolean                  // true = the transcript harvest is whole
 *   }
 *
 * `complete` describes the harvest, not the round: when it is false the turn
 * list may be missing history (virtualization / mid-render). Such a snapshot can
 * never produce a final reply. Round completion additionally needs a running
 * (busy/permission) -> idle transition plus two complete idle snapshots that
 * agree on the same final text (a single unreadable phase in between does not
 * count as agreement, but does not erase a confirmed observation either).
 * Idle alone is never evidence.
 *
 * Nothing here guesses: a reply is only produced when
 *
 *   1. the baseline transcript is a strict prefix of the snapshot (no trimmed,
 *      reordered or rewritten history),
 *   2. exactly one newly appended user turn exists and it matches the text that
 *      was dispatched (whitespace-normalized; long bubbles may be elided by the
 *      UI),
 *   3. the assistant turns after that user turn and before the next user turn
 *      are contiguous and non-empty,
 *   4. this round was observed busy (or in permission) at least once and is now
 *      idle,
 *   5. the snapshot is complete and the same text was already confirmed by a
 *      previous complete idle snapshot.
 *
 * @typedef {object} SnapshotTurn
 * @property {'user'|'assistant'} role
 * @property {string} text
 *
 * @typedef {object} Snapshot
 * @property {string} targetKey
 * @property {SnapshotTurn[]} turns
 * @property {'idle'|'busy'|'permission'|'unknown'} phase
 * @property {boolean} complete
 */

export const STATES = Object.freeze({
  /** No round user bubble has been observed yet. */
  PENDING: 'pending',
  /** The dispatched user bubble is present; generation has not been observed running yet. */
  ACCEPTED: 'accepted',
  /** A permission / authorization prompt is blocking this round. */
  AWAITING_PERMISSION: 'awaiting_permission',
  /** The round is generating, or the final text is not confirmed yet. */
  RUNNING: 'running',
  /** A final assistant text was attributed and cached for this job. */
  REPLIED: 'replied',
  /** Attribution cannot be decided (or the round ended without attributable text). */
  INDETERMINATE: 'indeterminate',
})

export const STATE_LABELS = Object.freeze({
  [STATES.PENDING]: '未受理',
  [STATES.ACCEPTED]: '已受理',
  [STATES.AWAITING_PERMISSION]: '等待权限',
  [STATES.RUNNING]: '运行中',
  [STATES.REPLIED]: '已回复',
  [STATES.INDETERMINATE]: '归属不可确定',
})

export const CODES = Object.freeze({
  AWAITING_OBSERVATION: 'awaiting_observation',
  AWAITING_NEW_USER_TURN: 'awaiting_new_user_turn',
  AWAITING_GENERATION: 'awaiting_generation',
  DISPATCH_TURN_MATCHED: 'dispatch_turn_matched',
  PERMISSION_PROMPT: 'permission_prompt',
  GENERATION_RUNNING: 'generation_running',
  AWAITING_FINAL_STATE: 'awaiting_final_state',
  COMPLETED: 'completed',
  MISSING_BASELINE: 'missing_baseline',
  BASELINE_INCOMPLETE: 'baseline_incomplete',
  BASELINE_UNSAFE: 'baseline_unsafe',
  TARGET_MISMATCH: 'target_mismatch',
  HISTORY_TRUNCATED: 'history_truncated',
  BASELINE_DIVERGED: 'baseline_diverged',
  SNAPSHOT_INCOMPLETE: 'snapshot_incomplete',
  DUPLICATE_DISPATCH_TURN: 'duplicate_dispatch_turn',
  DISPATCH_NOT_OBSERVED: 'dispatch_not_observed',
  UNEXPECTED_TURN_ORDER: 'unexpected_turn_order',
  SUPERSEDED_BY_USER_TURN: 'superseded_by_user_turn',
  ROUND_ENDED_WITHOUT_REPLY: 'round_ended_without_reply',
  PHASE_UNKNOWN: 'phase_unknown',
})

/** Input shape problems are programming errors, not attribution outcomes. */
export class AttributionInputError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AttributionInputError'
    this.code = code
  }
}

const PHASE_SET = new Set(['idle', 'busy', 'permission', 'unknown'])
const ROLE_SET = new Set(['user', 'assistant'])
const MATCH_POLICIES = new Set(['normalized', 'strict'])
const FOREIGN_USER_POLICIES = new Set(['indeterminate', 'bound'])

/** @type {Readonly<Record<string, unknown>>} */
const DEFAULTS = Object.freeze({
  matchPolicy: 'normalized',
  minPrefixRatio: 0.6,
  minPrefixChars: 24,
  requiredIdleConfirmations: 2,
  foreignUserTurnPolicy: 'indeterminate',
  placeholderPatterns: Object.freeze([
    /^(?:thinking|thought|thinking\.{3}|generating|working)[.…\s]*$/i,
    /^(?:思考中|正在思考|思考|运行中|正在运行|生成中|正在生成)[.…。\s]*$/,
  ]),
})

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u180e]/g

/**
 * Normalize text for comparison only; the returned reply keeps the original
 * characters. Line endings, zero-width marks and runs of spaces are collapsed
 * because the UIA text provider re-renders them inconsistently.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Turn an already harvested snapshot into a baseline record.
 *
 * @param {Snapshot} snapshot
 * @returns {Readonly<{targetKey: string, phase: string, complete: boolean, turns: ReadonlyArray<SnapshotTurn>}>}
 */
export function createBaseline(snapshot) {
  const normalized = normalizeSnapshot(snapshot, 'baseline')
  return Object.freeze({
    targetKey: normalized.targetKey,
    phase: normalized.phase,
    complete: normalized.complete,
    turns: Object.freeze(normalized.turns.map((turn) => Object.freeze({ role: turn.role, text: turn.text }))),
  })
}

/**
 * @param {object} options
 * @param {string} options.dispatchText Exact text that was sent in this round.
 * @param {Snapshot|object|null} options.baseline Snapshot captured immediately before dispatch.
 * @param {string|null} [options.jobId]
 * @param {string|null} [options.targetKey] Target pinned at dispatch time.
 * @param {'normalized'|'strict'} [options.matchPolicy]
 * @param {number} [options.minPrefixRatio]
 * @param {number} [options.minPrefixChars]
 * @param {number} [options.requiredIdleConfirmations]
 * @param {'indeterminate'|'bound'} [options.foreignUserTurnPolicy]
 * @param {RegExp[]} [options.placeholderPatterns]
 */
export function createTracker(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AttributionInputError('options_malformed', 'createTracker 需要一个选项对象')
  }
  const opts = normalizeOptions(options)
  const dispatchText = normalizeText(options.dispatchText)
  if (!dispatchText) {
    throw new AttributionInputError('dispatch_text_required', 'dispatchText 必须是包含可见字符的派发原文')
  }
  const jobId = options.jobId == null ? null : String(options.jobId)
  const requestedTargetKey = options.targetKey == null ? null : String(options.targetKey).trim() || null
  const baseline = normalizeBaseline(options.baseline)
  const targetKey = baseline ? baseline.targetKey : requestedTargetKey

  /** @type {{matched: boolean, turnIndex: number, matchedBy: string|null, nonIdleSeen: boolean, idleAfterNonIdle: boolean, permissionSeen: boolean, assistantTurns: number, segmentClosed: boolean}} */
  const round = {
    matched: false,
    turnIndex: -1,
    anchorText: '',
    matchedBy: null,
    nonIdleSeen: false,
    idleAfterNonIdle: false,
    permissionSeen: false,
    assistantTurns: 0,
    segmentClosed: false,
  }

  let observations = 0
  /** @type {{text: string, count: number}|null} */
  let lastQualifying = null
  let emptyConfirmations = 0
  /** @type {null|{state: string, code: string, detail: string, reply: string|null, finalizable: boolean, terminal: boolean}} */
  let sticky = null
  /** @type {any} */
  let last = null

  /**
   * @param {{state: string, code: string, detail: string, reply?: string|null, finalizable?: boolean, terminal?: boolean, observed?: object|null}} spec
   */
  const makeVerdict = (spec) => ({
    state: spec.state,
    code: spec.code,
    detail: spec.detail,
    jobId,
    targetKey,
    accepted: round.matched,
    reply: spec.reply ?? null,
    finalizable: spec.finalizable === true,
    terminal: spec.terminal === true,
    observations,
    round: round.matched
      ? {
          turnIndex: round.turnIndex,
          matchedBy: round.matchedBy,
          assistantTurns: round.assistantTurns,
          segmentClosed: round.segmentClosed,
          idleConfirmations: lastQualifying ? lastQualifying.count : 0,
          activity: {
            busyOrPermission: round.nonIdleSeen,
            observedRunning: round.nonIdleSeen,
            permission: round.permissionSeen,
            idleAfterActivity: round.idleAfterNonIdle,
          },
        }
      : null,
    baseline: baseline ? { targetKey: baseline.targetKey, turnCount: baseline.turns.length } : null,
    observed: spec.observed ?? null,
  })

  const remember = (verdict) => {
    last = verdict
    return verdict
  }

  /** Terminal and immutable for this job. */
  const stick = (spec) => {
    sticky = {
      state: spec.state,
      code: spec.code,
      detail: spec.detail,
      reply: spec.reply ?? null,
      finalizable: spec.finalizable === true,
      terminal: true,
    }
    return remember(makeVerdict(sticky))
  }

  const incomplete = (observed) =>
    remember(
      makeVerdict({
        state: round.matched ? STATES.RUNNING : STATES.PENDING,
        code: CODES.SNAPSHOT_INCOMPLETE,
        detail: '快照不完整（历史可能被虚拟化或尚未渲染完），基线不能对齐；不产出最终回复。',
        observed,
      }),
    )

  if (!baseline) {
    stick({
      state: STATES.INDETERMINATE,
      code: CODES.MISSING_BASELINE,
      detail: '没有派发前的基线快照，无法证明哪一条用户气泡属于本轮，不能归属回复。',
    })
  } else if (requestedTargetKey && requestedTargetKey !== baseline.targetKey) {
    stick({
      state: STATES.INDETERMINATE,
      code: CODES.TARGET_MISMATCH,
      detail: `派发目标与基线目标不一致（${requestedTargetKey} ≠ ${baseline.targetKey}），不能归属回复。`,
    })
  } else if (baseline.complete !== true) {
    stick({
      state: STATES.INDETERMINATE,
      code: CODES.BASELINE_INCOMPLETE,
      detail: '基线快照不完整（complete=false），历史可能缺失，不能作为归属依据。',
    })
  } else if (baseline.phase !== 'idle') {
    stick({
      state: STATES.INDETERMINATE,
      code: CODES.BASELINE_UNSAFE,
      detail: `基线阶段是 ${baseline.phase}，派发前界面并不空闲，无法确定新增回合的起点。`,
    })
  } else {
    last = makeVerdict({
      state: STATES.PENDING,
      code: CODES.AWAITING_OBSERVATION,
      detail: '已记录基线，尚未收到快照。',
    })
  }

  /**
   * Feed one snapshot. Malformed snapshots throw (a caller bug); attribution
   * problems are returned as a verdict.
   *
   * @param {Snapshot} input
   */
  function observe(input) {
    const snapshot = normalizeSnapshot(input, 'snapshot')
    observations += 1
    const observed = {
      targetKey: snapshot.targetKey,
      phase: snapshot.phase,
      complete: snapshot.complete,
      turnCount: snapshot.turns.length,
    }

    if (sticky) return remember(makeVerdict({ ...sticky, observed }))

    if (snapshot.targetKey !== baseline.targetKey) {
      return stick({
        state: STATES.INDETERMINATE,
        code: CODES.TARGET_MISMATCH,
        detail: `目标已切换（基线 ${baseline.targetKey} → 当前 ${snapshot.targetKey}），本轮回复不能归属。`,
      })
    }

    const prefix = comparePrefix(snapshot.turns, baseline.turns)
    if (prefix !== 'ok') {
      if (snapshot.complete !== true) return incomplete(observed)
      if (prefix === 'truncated') {
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.HISTORY_TRUNCATED,
          detail: `快照只剩 ${snapshot.turns.length} 条历史，少于基线的 ${baseline.turns.length} 条（历史虚拟化），归属不可确定。`,
        })
      }
      return stick({
        state: STATES.INDETERMINATE,
        code: CODES.BASELINE_DIVERGED,
        detail: '基线中的旧回合被改写或重排，历史不再是严格前缀，归属不可确定。',
      })
    }

    const delta = snapshot.turns.slice(baseline.turns.length)

    if (round.matched) {
      // Re-verify the anchor on every snapshot: the round is only attributable
      // while the user bubble at `turnIndex` is still the very bubble that
      // matched the dispatch text. A rewritten/replaced turn means the visible
      // dialogue moved on and the assistant segment can no longer be ours.
      const anchor = snapshot.turns[round.turnIndex]
      const anchorIntact =
        anchor !== undefined && anchor.role === 'user' && anchor.text === round.anchorText
      if (!anchorIntact) {
        if (snapshot.complete !== true) return incomplete(observed)
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.BASELINE_DIVERGED,
          detail: '本轮用户锚点在原位置被替换或改写（历史重排/重渲染），其后的 assistant 文本不能归属本轮。',
        })
      }
    }

    if (!round.matched) {
      const firstUserIndex = delta.findIndex((turn) => turn.role === 'user')
      if (firstUserIndex < 0) {
        return remember(
          makeVerdict({
            state: STATES.PENDING,
            code: CODES.AWAITING_NEW_USER_TURN,
            detail:
              delta.length === 0
                ? '基线之后还没有出现本轮用户气泡。'
                : '新增内容里还没有用户气泡，不能把其中的文本当成本轮回复。',
            observed,
          }),
        )
      }
      if (firstUserIndex > 0) {
        if (snapshot.complete !== true) return incomplete(observed)
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.UNEXPECTED_TURN_ORDER,
          detail: '新增的第一条内容是 assistant 文本而不是本轮用户气泡，无法把回复限定在本轮气泡之后。',
        })
      }

      // The anchor must be the FIRST new user bubble. A later bubble that
      // happens to quote the dispatch text is somebody else's round.
      const anchorMatches = matchDispatchText(delta[0], dispatchText, opts)
      const laterMatches = delta
        .slice(1)
        .filter((turn) => turn.role === 'user' && matchDispatchText(turn, dispatchText, opts)).length
      if (anchorMatches && laterMatches > 0) {
        if (snapshot.complete !== true) return incomplete(observed)
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.DUPLICATE_DISPATCH_TURN,
          detail: '基线之后出现了不止一条与派发原文匹配的用户气泡（重复投递或重复渲染），归属不可确定。',
        })
      }
      if (!anchorMatches) {
        if (snapshot.complete !== true) return incomplete(observed)
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.DISPATCH_NOT_OBSERVED,
          detail: '基线之后的第一条用户气泡与派发原文不匹配；后续用户气泡属于别的回合，本轮派发未被观察到。',
        })
      }

      round.matched = true
      round.turnIndex = baseline.turns.length
      round.anchorText = delta[0].text
      round.matchedBy = matchDispatchText(delta[0], dispatchText, opts)
    }

    const after = snapshot.turns.slice(round.turnIndex + 1)
    const nextUserIndex = after.findIndex((turn) => turn.role === 'user')
    const segmentTurns = (nextUserIndex >= 0 ? after.slice(0, nextUserIndex) : after).filter(
      (turn) => turn.role === 'assistant',
    )
    const rawText = segmentTurns
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    const placeholderOnly = rawText !== '' && isPlaceholderOnly(rawText, opts.placeholderPatterns)
    const segmentText = placeholderOnly ? '' : rawText

    round.assistantTurns = segmentTurns.length
    round.segmentClosed = nextUserIndex >= 0

    if (snapshot.phase === 'permission') {
      round.permissionSeen = true
      round.nonIdleSeen = true
      round.idleAfterNonIdle = false
      lastQualifying = null
      emptyConfirmations = 0
      return remember(
        makeVerdict({
          state: STATES.AWAITING_PERMISSION,
          code: CODES.PERMISSION_PROMPT,
          detail: '本轮出现权限/授权提示，等待用户处理；不自动通过、不产出最终回复。',
          observed,
        }),
      )
    }

    if (snapshot.phase === 'busy') {
      round.nonIdleSeen = true
      round.idleAfterNonIdle = false
      lastQualifying = null
      emptyConfirmations = 0
      return remember(
        makeVerdict({
          state: STATES.RUNNING,
          code: CODES.GENERATION_RUNNING,
          detail: '本轮仍在生成；当前 assistant 文本只是流式片段，不能当作最终回复。',
          observed,
        }),
      )
    }

    if (snapshot.phase === 'unknown') {
      return remember(
        makeVerdict({
          state: STATES.RUNNING,
          code: CODES.PHASE_UNKNOWN,
          detail: '无法读取当前阶段，不能判定完成；继续观察。',
          observed,
        }),
      )
    }

    // phase === 'idle'：不再强制要求先观察到 busy/permission；
    // 只要已有匹配的新 user 锚点、完整历史、非空新 assistant 段且连续两次空闲一致即可交付。
    round.idleAfterNonIdle = true

    if (snapshot.complete !== true) return incomplete(observed)

    if (nextUserIndex >= 0 && opts.foreignUserTurnPolicy !== 'bound') {
      return stick({
        state: STATES.INDETERMINATE,
        code: CODES.SUPERSEDED_BY_USER_TURN,
        detail:
          nextUserIndex === 0
            ? '本轮还没有回复就出现了下一条用户气泡，本轮回复不再可归属。'
            : '下一条用户气泡在本轮最终确认之前出现，无法证明上一段 assistant 文本完整，归属不可确定。',
      })
    }

    if (!segmentText) {
      emptyConfirmations += 1
      if (emptyConfirmations >= opts.requiredIdleConfirmations) {
        return stick({
          state: STATES.INDETERMINATE,
          code: CODES.ROUND_ENDED_WITHOUT_REPLY,
          detail: round.permissionSeen
            ? '权限提示之后界面回到空闲，但没有可归属的最终 assistant 文本。'
            : '本轮已回到空闲，但没有可归属的最终 assistant 文本（可能被停止或仅有状态占位）。',
        })
      }
      return remember(
        makeVerdict({
          state: STATES.RUNNING,
          code: CODES.AWAITING_FINAL_STATE,
          detail: '界面空闲，但还没有可归属的最终文本；等待再次确认。',
          observed,
        }),
      )
    }

    emptyConfirmations = 0

    if (lastQualifying && lastQualifying.text === segmentText) {
      lastQualifying.count += 1
    } else {
      lastQualifying = { text: segmentText, count: 1 }
    }

    if (lastQualifying.count >= opts.requiredIdleConfirmations) {
      return stick({
        state: STATES.REPLIED,
        code: CODES.COMPLETED,
        detail: '本轮用户气泡与派发原文匹配，其后的 assistant 段完整，且已有两次一致的完整空闲快照确认。',
        reply: segmentText,
        finalizable: true,
      })
    }

    return remember(
      makeVerdict({
        state: STATES.RUNNING,
        code: CODES.AWAITING_FINAL_STATE,
        detail: '已看到最终候选文本，但还需要一次一致的空闲快照确认后才能唤醒。',
        observed,
      }),
    )
  }

  return {
    observe,
    /** Last verdict without observing anything new; never consumes the result. */
    verdict: () => last,
    get observations() {
      return observations
    },
    get jobId() {
      return jobId
    },
    get targetKey() {
      return targetKey
    },
    get baseline() {
      return baseline
        ? {
            targetKey: baseline.targetKey,
            phase: baseline.phase,
            complete: baseline.complete,
            turnCount: baseline.turns.length,
          }
        : null
    },
  }
}

/**
 * Attribute a whole snapshot sequence in one call (tests, replay, t9 backfill).
 *
 * @param {object} options Same options as createTracker plus `snapshots`.
 * @param {Snapshot[]} options.snapshots
 */
export function attributeSnapshots({ snapshots, ...trackerOptions } = {}) {
  if (!Array.isArray(snapshots)) {
    throw new AttributionInputError('snapshots_required', 'snapshots 必须是快照数组')
  }
  const tracker = createTracker(trackerOptions)
  const history = snapshots.map((snapshot) => tracker.observe(snapshot))
  return { verdict: tracker.verdict(), history, tracker }
}

/**
 * A terminal verdict will not change again for this job: either the final reply
 * is cached, or attribution is (and stays) undecidable.
 *
 * @param {{terminal?: boolean}|null|undefined} verdict
 */
export function isTerminal(verdict) {
  return Boolean(verdict && verdict.terminal === true)
}

/**
 * @param {{state?: string, reply?: string|null}|null|undefined} verdict
 */
export function isFinalReply(verdict) {
  return Boolean(verdict && verdict.state === STATES.REPLIED && typeof verdict.reply === 'string')
}

/**
 * Job status vocabulary shared with the bridge send/wait contract (t3): a
 * verdict never claims more than what the UIA evidence proves.
 */
export const JOB_STATUS = Object.freeze({
  NOT_SENT: 'not_sent',
  ACCEPTED: 'accepted',
  ACCEPTANCE_UNKNOWN: 'acceptance_unknown',
  REPLIED: 'replied',
  FAILED: 'failed',
})

/**
 * Translate an attribution verdict into the bridge job status vocabulary.
 *
 * `not_sent` is deliberately never produced here: this module only judges
 * observed snapshots, so pre-send rejection stays with the sender.
 *
 * @param {object|null|undefined} verdict A verdict returned by the tracker.
 * @returns {{status: string, code: string|null, reply: string|null, wake: boolean, terminal: boolean}}
 */
export function toJobUpdate(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    throw new AttributionInputError('verdict_required', 'toJobUpdate 需要一次 verdict')
  }
  const wake = isFinalReply(verdict)
  let status
  switch (verdict.state) {
    case STATES.REPLIED:
      status = JOB_STATUS.REPLIED
      break
    case STATES.ACCEPTED:
    case STATES.AWAITING_PERMISSION:
    case STATES.RUNNING:
      status = JOB_STATUS.ACCEPTED
      break
    case STATES.PENDING:
      status = JOB_STATUS.ACCEPTANCE_UNKNOWN
      break
    default:
      status = JOB_STATUS.FAILED
      break
  }
  return {
    status,
    code: verdict.code ?? null,
    reply: wake ? verdict.reply : null,
    wake,
    terminal: isTerminal(verdict),
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{targetKey: string, turns: Array<{role: 'user'|'assistant', text: string, normalized: string}>, phase: 'idle'|'busy'|'permission'|'unknown', complete: boolean}}
 */
function normalizeSnapshot(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributionInputError('snapshot_malformed', `${label} 必须是对象`)
  }
  const targetKey = typeof value.targetKey === 'string' ? value.targetKey.trim() : ''
  if (!targetKey) {
    throw new AttributionInputError('target_key_required', `${label}.targetKey 必须是非空字符串`)
  }
  if (!Array.isArray(value.turns)) {
    throw new AttributionInputError('turns_required', `${label}.turns 必须是数组`)
  }
  const turns = value.turns.map((turn, index) => normalizeTurn(turn, `${label}.turns[${index}]`))
  if (!PHASE_SET.has(value.phase)) {
    throw new AttributionInputError(
      'phase_invalid',
      `${label}.phase 必须是 idle/busy/permission/unknown 之一，收到 ${JSON.stringify(value.phase)}`,
    )
  }
  if (typeof value.complete !== 'boolean') {
    throw new AttributionInputError('complete_flag_required', `${label}.complete 必须是布尔值（快照是否完整）`)
  }
  return { targetKey, turns, phase: value.phase, complete: value.complete }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{role: 'user'|'assistant', text: string, normalized: string}}
 */
function normalizeTurn(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributionInputError('turn_malformed', `${label} 必须是 { role, text } 对象`)
  }
  if (!ROLE_SET.has(value.role)) {
    throw new AttributionInputError('turn_malformed', `${label}.role 必须是 user 或 assistant`)
  }
  if (typeof value.text !== 'string') {
    throw new AttributionInputError('turn_malformed', `${label}.text 必须是字符串`)
  }
  return { role: value.role, text: value.text, normalized: normalizeText(value.text) }
}

/**
 * @param {unknown} value
 */
function normalizeBaseline(value) {
  if (value == null) return null
  const snapshot = normalizeSnapshot(value, 'baseline')
  return { targetKey: snapshot.targetKey, phase: snapshot.phase, complete: snapshot.complete, turns: snapshot.turns }
}

/**
 * @param {Array<{role: string, normalized: string}>} current
 * @param {Array<{role: string, normalized: string}>} base
 * @returns {'ok'|'truncated'|'diverged'}
 */
function comparePrefix(current, base) {
  if (current.length < base.length) return 'truncated'
  for (let index = 0; index < base.length; index += 1) {
    const left = current[index]
    const right = base[index]
    if (left.role !== right.role || left.normalized !== right.normalized) return 'diverged'
  }
  return 'ok'
}

/**
 * @param {{normalized: string}} turn
 * @param {string} dispatchText
 * @param {{matchPolicy: string, minPrefixChars: number, minPrefixRatio: number}} options
 * @returns {'exact'|'prefix'|null}
 */
function matchDispatchText(turn, dispatchText, options) {
  const candidate = turn.normalized
  if (!candidate) return null
  if (candidate === dispatchText) return 'exact'
  if (options.matchPolicy !== 'normalized') return null

  const candidateIsShorter = candidate.length <= dispatchText.length
  const shorter = candidateIsShorter ? candidate : dispatchText
  const longer = candidateIsShorter ? dispatchText : candidate
  if (shorter.length < options.minPrefixChars) return null
  if (!longer.startsWith(shorter)) return null
  if (shorter.length / longer.length < options.minPrefixRatio) return null
  return 'prefix'
}

/**
 * A status label ("Thinking…", "运行中") must never be mistaken for a reply.
 *
 * @param {string} text
 * @param {ReadonlyArray<RegExp>} patterns
 */
function isPlaceholderOnly(text, patterns) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(normalized)
  })
}

/**
 * @param {Record<string, unknown>} input
 */
function normalizeOptions(input) {
  const matchPolicy = input.matchPolicy ?? DEFAULTS.matchPolicy
  if (!MATCH_POLICIES.has(matchPolicy)) {
    throw new AttributionInputError('option_invalid', `matchPolicy 必须是 normalized 或 strict，收到 ${JSON.stringify(matchPolicy)}`)
  }
  const foreignUserTurnPolicy = input.foreignUserTurnPolicy ?? DEFAULTS.foreignUserTurnPolicy
  if (!FOREIGN_USER_POLICIES.has(foreignUserTurnPolicy)) {
    throw new AttributionInputError(
      'option_invalid',
      `foreignUserTurnPolicy 必须是 indeterminate 或 bound，收到 ${JSON.stringify(foreignUserTurnPolicy)}`,
    )
  }

  const minPrefixRatio = numberOption(input.minPrefixRatio, DEFAULTS.minPrefixRatio, 'minPrefixRatio', 0, 1)
  const minPrefixChars = integerOption(input.minPrefixChars, DEFAULTS.minPrefixChars, 'minPrefixChars', 1)
  const requiredIdleConfirmations = integerOption(
    input.requiredIdleConfirmations,
    DEFAULTS.requiredIdleConfirmations,
    'requiredIdleConfirmations',
    1,
  )

  const placeholderPatterns = input.placeholderPatterns ?? DEFAULTS.placeholderPatterns
  if (!Array.isArray(placeholderPatterns) || placeholderPatterns.some((pattern) => !(pattern instanceof RegExp))) {
    throw new AttributionInputError('option_invalid', 'placeholderPatterns 必须是 RegExp 数组')
  }

  return { matchPolicy, minPrefixRatio, minPrefixChars, requiredIdleConfirmations, foreignUserTurnPolicy, placeholderPatterns }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function numberOption(value, fallback, name, min, max) {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AttributionInputError('option_invalid', `${name} 必须是 ${min}..${max} 的数字`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @param {number} min
 */
function integerOption(value, fallback, name, min) {
  if (value == null) return fallback
  if (!Number.isInteger(value) || value < min) {
    throw new AttributionInputError('option_invalid', `${name} 必须是 >= ${min} 的整数`)
  }
  return value
}