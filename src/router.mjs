import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

const baseUrl = () =>
  `http://${process.env.LAYA_HOST ?? "127.0.0.1"}:${process.env.LAYA_PORT ?? "8000"}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postSystemOne(request, signal) {
  const res = await fetch(`${baseUrl()}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.LAYA_API_KEY ? { authorization: `Bearer ${process.env.LAYA_API_KEY}` } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) throw new Error(`laya-serve responded ${res.status}`);
  return res.json();
}

/**
 * Asks Laya which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * Laya's per-answer response carries both `confidence` (entropy-based) and
 * `answer_confidence` (calibrated max-probability); the latter is what policy gating
 * compares against a threshold, since it is the closer analog to "how sure is the top pick".
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askLaya({ prompt, current, contextTokens, models }) {
  if (!models?.length) return null;
  const started = Date.now();
  const overall = new AbortController();
  const deadlineTimer = setTimeout(() => overall.abort(), THRESHOLDS.layaDeadlineMs);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
  try {
    let lastErr;
    for (let attempt = 0; attempt <= THRESHOLDS.layaMaxRetries; attempt++) {
      if (overall.signal.aborted) throw lastErr ?? new Error("laya deadline exceeded");
      const attemptAbort = new AbortController();
      const relay = () => attemptAbort.abort();
      overall.signal.addEventListener("abort", relay);
      const attemptTimer = setTimeout(relay, THRESHOLDS.layaTimeoutMs);
      try {
        const result = await postSystemOne(request, attemptAbort.signal);
        const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
        return {
          choice: answer.choice,
          confidence: answer.answer_confidence,
          probabilities: answer.probabilities,
          request,
          response: result,
          metrics: {
            taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
            reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
            toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
            contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
          },
          ms: Date.now() - started,
        };
      } catch (err) {
        lastErr = err;
        if (attempt < THRESHOLDS.layaMaxRetries && !overall.signal.aborted) {
          await sleep(150 * (attempt + 1));
        } else {
          throw err;
        }
      } finally {
        clearTimeout(attemptTimer);
        overall.signal.removeEventListener("abort", relay);
      }
    }
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
