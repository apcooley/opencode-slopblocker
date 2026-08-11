import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

export type Rule = {
  pattern: RegExp
  message: string | ((match: string) => string)
}

const defaultBlockedWords = ["structural", "compound", "compounds", "compounding", "substrate"]

function strings(...values: unknown[]) {
  return values.filter((value): value is string => typeof value === "string")
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

function rulesFromOptions(value: PluginOptions): Rule[] {
  const blockEmDash = value.blockEmDash ?? true
  const blockedWords = value.blockedWords ?? defaultBlockedWords

  if (typeof blockEmDash !== "boolean") {
    throw new TypeError("slop blocker: blockEmDash must be a boolean")
  }
  if (!Array.isArray(blockedWords) || blockedWords.some((word) => typeof word !== "string" || !word)) {
    throw new TypeError("slop blocker: blockedWords must be an array of non-empty strings")
  }

  const rules: Rule[] = []
  if (blockEmDash) {
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
  }
  return rules
}

function builtInText(tool: string, value: unknown): string[] {
  const args = record(value)

  switch (tool) {
    case "write":
      return strings(args.content)
    case "edit":
      return strings(args.newString, args.new_string)
    case "apply_patch":
      return strings(args.patchText, args.patch_text)
    case "slack_slack_post_message":
    case "slack_slack_reply_to_thread":
      return strings(args.text, args.message)
    case "notion_notion-create-pages":
    case "notion_notion_create_pages":
      return Array.isArray(args.pages)
        ? args.pages.flatMap((page) => {
            const data = record(page)
            return strings(data.content, ...Object.values(record(data.properties)))
          })
        : []
    case "notion_notion-update-page":
    case "notion_notion_update_page":
      return [
        ...strings(args.new_str, args.content, ...Object.values(record(args.properties))),
        ...(Array.isArray(args.content_updates)
          ? args.content_updates.flatMap((update) => strings(record(update).new_str))
          : []),
      ]
    case "notion_notion-create-comment":
    case "notion_notion_create_comment":
      return strings(args.markdown)
    case "notion_notion-create-database":
    case "notion_notion_create_database":
    case "notion_notion-update-data-source":
    case "notion_notion_update_data_source":
      return strings(args.title, args.description)
  }

  if (/^linear_(?:create|update)_/.test(tool)) {
    return strings(args.title, args.description, args.body, args.content, args.name, args.summary)
  }
  if (/^linear_(?:create_)?comment/.test(tool)) return strings(args.body, args.content)

  return []
}

function createSlopBlocker(rules: Rule[]): Plugin {
  function lint(text: string) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(text)
      if (!match) continue
      const message =
        typeof rule.message === "function" ? rule.message(match[0]) : rule.message
      throw new Error(`slop blocker: ${message}`)
    }
  }

  return async () => ({
    "experimental.text.complete": async (_input, output) => lint(output.text),
    "tool.execute.before": async (input, output) => {
      for (const value of builtInText(input.tool, output.args)) lint(value)
    },
  })
}

const plugin: Plugin = async (input, options = {}) => createSlopBlocker(rulesFromOptions(options))(input)

export default plugin
