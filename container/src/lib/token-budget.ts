import type {OpenAIChatRequest} from './types'

/** Rough char-to-token ratio used as a tokenizer-free fallback. 4 chars/token
 *  is the canonical OpenAI heuristic for English; code and non-Latin scripts
 *  drift but the multiplicative headroom (see `computeMaxPayment`) absorbs it. */
const CHARS_PER_TOKEN = 4

/** Lower bound for estimated prompt tokens. Stops near-empty requests from
 *  escrowing zero, which would cap the response at no tokens via the same
 *  multiplicative buffer applied to both sides. */
const MIN_PROMPT_TOKEN_FLOOR = 256n

export interface TokenBudgetConfig {
  /** Fallback output cap when the request omits `max_tokens`. */
  defaultMaxOutputTokens: bigint
  /** Multiplicative safety buffer applied to both sides. 0.2 = +20%.
   *  Encoded as parts-per-million to stay in integer math. */
  headroomPpm: bigint
  /** Optional per-job escrow ceiling (xBZZ wei). If the computed maxPayment
   *  exceeds this, the request is rejected before any on-chain work. */
  maxEscrowPerJob: bigint | null
}

export interface ModelPricing {
  inputPricePerMillionTokens: bigint
  outputPricePerMillionTokens: bigint
}

export interface MaxPaymentBreakdown {
  estimatedPromptTokens: bigint
  budgetedPromptTokens: bigint
  budgetedCompletionTokens: bigint
  maxPayment: bigint
}

export class EscrowCapExceededError extends Error {
  readonly httpStatus = 413
  constructor(readonly maxPayment: bigint, readonly cap: bigint) {
    super(
      `request would escrow ${maxPayment} wei xBZZ, exceeding T4T_MAX_ESCROW_PER_JOB=${cap}. ` +
        `Lower max_tokens, shorten the prompt, or raise the cap.`,
    )
    this.name = 'EscrowCapExceededError'
  }
}

/** Estimate prompt tokens from an OpenAI chat request. We sum the character
 *  length of every message's content (plus a small per-message overhead for
 *  the role tag and chat-template boilerplate) and divide by CHARS_PER_TOKEN,
 *  rounding up. This intentionally overshoots — the escrow is a ceiling, the
 *  provider claims the actual count from the inference backend's usage. */
export function estimatePromptTokens(req: OpenAIChatRequest): bigint {
  let chars = 0
  for (const m of req.messages) {
    chars += m.content.length
    // Chat templates add ~4 tokens per message for the role markers + separators.
    chars += 16
  }
  const tokens = BigInt(Math.ceil(chars / CHARS_PER_TOKEN))
  return tokens < MIN_PROMPT_TOKEN_FLOOR ? MIN_PROMPT_TOKEN_FLOOR : tokens
}

/** Apply the multiplicative headroom to a token count. Uses ppm so the math
 *  stays in bigint and lossless for any ratio expressible as a fraction. */
function applyHeadroom(tokens: bigint, headroomPpm: bigint): bigint {
  return (tokens * (1_000_000n + headroomPpm) + 999_999n) / 1_000_000n
}

/** Compute the on-chain maxPayment for a chat request. Sizes the prompt side
 *  off the estimated input length (not max_tokens), and the completion side
 *  off the requested or default output cap, each padded by `headroomPpm`. */
export function computeMaxPayment(
  req: OpenAIChatRequest,
  pricing: ModelPricing,
  cfg: TokenBudgetConfig,
): MaxPaymentBreakdown {
  const promptEstimate = estimatePromptTokens(req)
  const requestedOutput =
    req.max_tokens != null && req.max_tokens > 0
      ? BigInt(req.max_tokens)
      : cfg.defaultMaxOutputTokens

  const promptBudget = applyHeadroom(promptEstimate, cfg.headroomPpm)
  const outputBudget = applyHeadroom(requestedOutput, cfg.headroomPpm)

  const inPay = pricing.inputPricePerMillionTokens * promptBudget
  const outPay = pricing.outputPricePerMillionTokens * outputBudget
  const maxPayment = (inPay + outPay + 999_999n) / 1_000_000n

  if (cfg.maxEscrowPerJob !== null && maxPayment > cfg.maxEscrowPerJob) {
    throw new EscrowCapExceededError(maxPayment, cfg.maxEscrowPerJob)
  }

  return {
    estimatedPromptTokens: promptEstimate,
    budgetedPromptTokens: promptBudget,
    budgetedCompletionTokens: outputBudget,
    maxPayment,
  }
}
