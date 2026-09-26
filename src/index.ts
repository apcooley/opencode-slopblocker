import { appendFileSync, writeFileSync } from "node:fs"
import { isMainThread } from "node:worker_threads"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

type TextField = {
  value: string
  replace: (value: string) => void
}

const overrideToken = "$SLOPBLOCK_OVERRIDE=TRUE"
const overrideWarning = "[Warning: Slop blocker override used; this response violates configured style rules.]"
const blockedMarker = "[Response blocked by slop blocker; retrying. I'm bozo the clown.]"

export type Rule = {
  pattern: RegExp
  message: string | ((match: string) => string)
}

const defaultBlockedWords = ["structural", "compound", "compounds", "compounding", "substrate"]

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

// Env-gated debug tracing for diagnosing which delivery path runs per blocked
// response. Off unless SLOPBLOCK_DEBUG_FILE points at a writable file; a failed
// debug write must never break the chat.
function debugLog(line: string) {
  const path = process.env.SLOPBLOCK_DEBUG_FILE?.trim()
  if (!path) return
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // ignore: diagnostics only
  }
}

function fieldsAtPath(value: unknown, path: string): TextField[] {
  function visit(current: unknown, segments: string[], replace?: (value: string) => void): TextField[] {
    if (segments.length === 0) {
      return typeof current === "string" && replace ? [{ value: current, replace }] : []
    }

    const [segment, ...rest] = segments
    if (segment === "*") {
      const data = record(current)
      return Object.keys(data).flatMap((key) => visit(data[key], rest, (next) => { data[key] = next }))
    }
    if (segment.endsWith("[]")) {
      const data = record(current)
      const key = segment.slice(0, -2)
      const items = data[key]
      return Array.isArray(items)
        ? items.flatMap((item, index) => visit(item, rest, (next) => { items[index] = next }))
        : []
    }

    const data = record(current)
    return visit(data[segment], rest, (next) => { data[segment] = next })
  }

  return visit(value, path.split("."))
}

function rulesFromOptions(value: PluginOptions): { rules: Rule[]; banned: string } {
  const blockEmDash = value.blockEmDash ?? true
  const blockedWords = value.blockedWords ?? defaultBlockedWords

  if (typeof blockEmDash !== "boolean") {
    throw new TypeError("slop blocker: blockEmDash must be a boolean")
  }
  if (!Array.isArray(blockedWords) || blockedWords.some((word) => typeof word !== "string" || !word)) {
    throw new TypeError("slop blocker: blockedWords must be an array of non-empty strings")
  }

  const rules: Rule[] = []
  const banned: string[] = []
  if (blockEmDash) {
    banned.push(`the em dash character (${String.fromCodePoint(0x2014)})`)
    rules.push({
      pattern: /—/u,
      message: "replace em-dashes with :, ;, or comma as appropriate",
    })
  }
  if (blockedWords.length) {
    const escaped = blockedWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    rules.push({
      pattern: new RegExp(`\\b(?:${escaped.join("|")})\\b`, "iu"),
      message: (word) =>
        `Rephrase the sentence(s) containing the word "${word}" to sound more human`,
    })
    banned.push(`these words (case-insensitive): ${blockedWords.map((word) => `"${word}"`).join(", ")}`)
  }
  return { rules, banned: banned.join("; ") }
}

function allowOverrideFromOptions(value: PluginOptions) {
  const allowOverride = value.allowOverride ?? false
  if (typeof allowOverride !== "boolean") {
    throw new TypeError("slop blocker: allowOverride must be a boolean")
  }
  return allowOverride
}

function maxRetriesFromOptions(value: PluginOptions) {
  const maxRetries = value.maxRetries ?? 5
  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("slop blocker: maxRetries must be a non-negative integer")
  }
  return maxRetries
}

function onExhaustedFromOptions(value: PluginOptions): "stop" | "slop" {
  const onExhausted = value.onExhausted ?? "stop"
  if (onExhausted !== "stop" && onExhausted !== "slop") {
    throw new TypeError('slop blocker: onExhausted must be "stop" or "slop"')
  }
  return onExhausted
}

// In worker-driven (headless) mode the RADAR worker sets RADAR_SLOP_COACH_FILE:
// instead of re-prompting the session from the session.idle event, the blocker
// writes the coaching message to that file and lets the worker deliver it. The
// headless CLI exits on the first idle status, which the server publishes
// before the session.idle event, so an async in-plugin retry can never reach a
// headless run.
function coachFileFromEnv(): string | undefined {
  const path = process.env.RADAR_SLOP_COACH_FILE?.trim()
  return path ? path : undefined
}

type CoachRecord = {
  sessionID: string
  attempt: number
  message: string
}

function writeCoachRecord(path: string, record: CoachRecord) {
  try {
    writeFileSync(path, JSON.stringify(record))
  } catch {
    // The worker falls back to a generic coaching prompt when the file is
    // missing or stale; a failed write must never break the chat.
  }
}

function builtInText(tool: string, value: unknown): TextField[] {
  const paths: Record<string, string[]> = {
    write: ["content"],
    edit: ["newString", "new_string"],
    apply_patch: ["patchText", "patch_text"],
    slack_slack_post_message: ["text", "message"],
    slack_slack_reply_to_thread: ["text", "message"],
    "notion_notion-create-pages": ["pages[].content", "pages[].properties.*"],
    notion_notion_create_pages: ["pages[].content", "pages[].properties.*"],
    "notion_notion-update-page": ["new_str", "content", "properties.*", "content_updates[].new_str"],
    notion_notion_update_page: ["new_str", "content", "properties.*", "content_updates[].new_str"],
    "notion_notion-create-comment": ["markdown"],
    notion_notion_create_comment: ["markdown"],
    "notion_notion-create-database": ["title", "description"],
    notion_notion_create_database: ["title", "description"],
    "notion_notion-update-data-source": ["title", "description"],
    notion_notion_update_data_source: ["title", "description"],
  }
  const selected = paths[tool]
    ?? (/^linear_(?:create|update)_/.test(tool)
      ? ["title", "description", "body", "content", "name", "summary"]
      : /^linear_(?:create_)?comment/.test(tool) ? ["body", "content"] : [])
  return selected.flatMap((path) => fieldsAtPath(value, path))
}

function stripOverride(text: string) {
  if (text === overrideToken) return ""
  if (text.startsWith(`${overrideToken}\r\n`)) return text.slice(overrideToken.length + 2)
  if (text.startsWith(`${overrideToken}\n`)) return text.slice(overrideToken.length + 1)
}

// Exported for tests: the last parameter blanks blocked responses pre-render
// in the interactive TUI (see the default plugin below for the gate).
export function createSlopBlocker(rules: Rule[], banned: string, allowOverride: boolean, maxRetries: number, onExhausted: "stop" | "slop", coachFile: string | undefined, blankInteractive: boolean): Plugin {
  function coachText(message: string): string {
    return `The previous response was rejected by the style checker: ${message}.${banned
      ? ` YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING: ${banned}.`
      : ""} Rewrite it and answer the user's original request. Do not mention this correction.${allowOverride
      ? ` If the request cannot be answered correctly without the rejected content, prefix the response with "${overrideToken}" and a newline to override deliberately. Otherwise, do not use the override.`
      : ""}`
  }

  function violation(text: string) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(text)
      if (!match) continue
      const message = (
        typeof rule.message === "function" ? rule.message(match[0]) : rule.message
      )
      return allowOverride
        ? `${message}; prefix content with "${overrideToken}" and a newline to override`
        : message
    }
  }

  function lint(text: string) {
    const message = violation(text)
    if (message) {
      throw new Error(
        `slop blocker: ${message}.${banned ? ` YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING: ${banned}.` : ""}`,
      )
    }
  }

  return async ({ client, directory }) => {
    const pending = new Map<string, string>()
    const attempts = new Map<string, number>()
    const compacting = new Set<string>()
    // Coach deliveries currently in flight, per session. The host invokes the
    // event hook fire-and-forget, and idle events can repeat while a POST is
    // still resolving, so the guard prevents a double coach prompt.
    const delivering = new Set<string>()

    return {
      "experimental.chat.system.transform": async (_input, output) => {
        if (!banned) return
        output.system.push(
          `Never use ${banned}. An automatic style checker rejects responses and writes that contain them. I'm bozo the clown.`,
        )
      },
      "chat.message": async (input, output) => {
        if (output.parts.some((part) => part.type === "text" && !part.synthetic)) {
          pending.delete(input.sessionID)
          attempts.delete(input.sessionID)
        }
      },
      "experimental.text.complete": async (input, output) => {
        if (compacting.has(input.sessionID)) return
        const attempt = attempts.get(input.sessionID) ?? 0
        const replacement = allowOverride ? stripOverride(output.text) : undefined
        if (replacement !== undefined) {
          output.text = violation(replacement) ? `${overrideWarning}\n\n${replacement}` : replacement
          pending.delete(input.sessionID)
          attempts.delete(input.sessionID)
          return
        }
        const message = violation(output.text)
        if (!message) {
          attempts.delete(input.sessionID)
          return
        }

        if (attempt < maxRetries) {
          try {
            // Interactive TUI: blank the violating response pre-render so it is
            // never shown, then let the queued coach prompt retry on idle.
            // Every other surface keeps the marker: the RADAR worker greps for
            // it, and headless runs cannot land an async retry.
            output.text = blankInteractive ? "" : blockedMarker
          } catch {
            // If the blanking path misbehaves, fall back to today's surface.
            output.text = blockedMarker
          }
          attempts.set(input.sessionID, attempt + 1)
          debugLog(
            `block session=${input.sessionID} attempt=${attempt + 1}/${maxRetries} ` +
              `branch=${coachFile ? "coach-file" : "pending-async"} blankInteractive=${blankInteractive}`,
          )
          if (coachFile) {
            writeCoachRecord(coachFile, {
              sessionID: input.sessionID,
              attempt: attempt + 1,
              message: coachText(message),
            })
          } else {
            pending.set(input.sessionID, message)
          }
          return
        }

        debugLog(
          `exhaust session=${input.sessionID} attempt=${attempt}/${maxRetries} onExhausted=${onExhausted}`,
        )
        output.text = onExhausted === "slop"
          ? `${overrideWarning}\n\n${output.text}`
          : `[Slop blocker stopped the response after ${maxRetries} automatic ${
              maxRetries === 1 ? "retry" : "retries"
            }.${allowOverride ? ` To proceed intentionally, retry with ${overrideToken}.` : ""}]`
        pending.delete(input.sessionID)
        attempts.delete(input.sessionID)
      },
      "experimental.session.compacting": async (input) => {
        compacting.add(input.sessionID)
      },
      event: async ({ event }) => {
        if (event.type !== "session.idle") return
        const sessionID = event.properties.sessionID
        debugLog(
          `idle-enter session=${sessionID} ` +
            `coachFile=${coachFile ? "set" : "unset"} pendingHas=${pending.has(sessionID)}`,
        )
        compacting.delete(sessionID)
        if (coachFile) {
          pending.delete(sessionID)
          return
        }
        const message = pending.get(sessionID)
        if (!message) return
        if (delivering.has(sessionID)) return
        delivering.add(sessionID)
        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{
                type: "text",
                synthetic: true,
                text: coachText(message),
              }],
            },
            throwOnError: true,
          })
          debugLog(`coach-post-ok session=${sessionID}`)
          // Pop only after an accepted POST: a failed delivery stays queued
          // and the next idle retries it instead of stranding the session
          // mid-retry-budget with no further coach.
          pending.delete(sessionID)
        } catch (error) {
          debugLog(`coach-post-error session=${sessionID} ${String(error)}`)
        } finally {
          delivering.delete(sessionID)
        }
      },
      "tool.execute.before": async (input, output) => {
        const fields = builtInText(input.tool, output.args)
        if (allowOverride) {
          for (const field of fields) {
            const replacement = stripOverride(field.value)
            if (replacement === undefined) continue
            field.replace(replacement)
            if (violation(replacement)) {
              await client.tui.showToast({
                body: {
                  title: "Slop blocker override",
                  message: "Allowed content that violates configured style rules.",
                  variant: "warning",
                },
                query: { directory },
              })
            }
            return
          }
        }
        for (const field of fields) lint(field.value)
      },
    }
  }
}

const plugin: Plugin = async (input, options = {}) => {
  const { rules, banned } = rulesFromOptions(options)
  const coachFile = coachFileFromEnv()
  // The interactive TUI hosts the opencode server in a worker thread, while
  // headless surfaces (run, serve) stay on the main thread. Blank pre-render
  // only where the async coach retry can land and nothing greps the marker.
  // ponytail: if opencode ever moves the TUI off a worker thread, this silently
  // keeps today's marker; the upgrade path is a server-side TUI signal.
  const blankInteractive = !coachFile && isMainThread === false
  debugLog(
    `init coachFile=${coachFile ? "set" : "unset"} blankInteractive=${blankInteractive} ` +
      `isMainThread=${isMainThread} maxRetries=${maxRetriesFromOptions(options)} ` +
      `onExhausted=${onExhaustedFromOptions(options)}`,
  )
  return createSlopBlocker(
    rules,
    banned,
    allowOverrideFromOptions(options),
    maxRetriesFromOptions(options),
    onExhaustedFromOptions(options),
    coachFile,
    blankInteractive,
  )(input)
}

export default plugin
