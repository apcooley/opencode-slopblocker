import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

type TextField = {
  value: string
  replace: (value: string) => void
}

const overrideToken = "$SLOPBLOCK_OVERRIDE=TRUE"
const overrideWarning = "[Warning: Slop blocker override used; this response violates configured style rules.]"

export type Rule = {
  pattern: RegExp
  message: string | ((match: string) => string)
}

const defaultBlockedWords = ["structural", "compound", "compounds", "compounding", "substrate"]

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
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
  const maxRetries = value.maxRetries ?? 3
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

function createSlopBlocker(rules: Rule[], banned: string, allowOverride: boolean, maxRetries: number, onExhausted: "stop" | "slop"): Plugin {
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

    return {
      "experimental.chat.system.transform": async (_input, output) => {
        if (!banned) return
        output.system.push(
          `Never use ${banned}. An automatic style checker rejects responses and writes that contain them.`,
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
          output.text = "[Response blocked by slop blocker; retrying.]"
          attempts.set(input.sessionID, attempt + 1)
          pending.set(input.sessionID, message)
          return
        }

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
        compacting.delete(event.properties.sessionID)
        const message = pending.get(event.properties.sessionID)
        if (!message) return
        pending.delete(event.properties.sessionID)

        await client.session.promptAsync({
          path: { id: event.properties.sessionID },
          query: { directory },
          body: {
            parts: [{
              type: "text",
              synthetic: true,
              text: `The previous response was rejected by the style checker: ${message}.${banned
                ? ` YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING: ${banned}.`
                : ""} Rewrite it and answer the user's original request. Do not mention this correction.${allowOverride
                ? ` If the request cannot be answered correctly without the rejected content, prefix the response with "${overrideToken}" and a newline to override deliberately. Otherwise, do not use the override.`
                : ""}`,
            }],
          },
          throwOnError: true,
        })
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
  return createSlopBlocker(
    rules,
    banned,
    allowOverrideFromOptions(options),
    maxRetriesFromOptions(options),
    onExhaustedFromOptions(options),
  )(input)
}

export default plugin
