import { describe, expect, test } from "bun:test"
import plugin from "../src/index.ts"

const hooks = await plugin({} as never)
const lintOutput = hooks["experimental.text.complete"]!
const lintTool = hooks["tool.execute.before"]!

describe("output linting", () => {
  test("accepts clean text", async () => {
    await lintOutput(
      { sessionID: "session", messageID: "message", partID: "part" },
      { text: "Use a comma, semicolon, or colon." },
    )
  })

  test.each(["—", "structural", "compound", "compounds", "compounding", "substrate"])(
    "rejects %s",
    async (word) => {
      await expect(
        lintOutput(
          { sessionID: "session", messageID: "message", partID: "part" },
          { text: `Contains ${word}.` },
        ),
      ).rejects.toThrow("slop blocker:")
    },
  )
})

describe("write linting", () => {
  test.each([
    ["write", { content: "A structural problem" }],
    ["edit", { newString: "A compound problem" }],
    ["apply_patch", { patchText: "+A substrate problem" }],
    ["slack_slack_post_message", { text: "A structural update" }],
    ["slack_slack_reply_to_thread", { text: "A compound reply" }],
    ["notion_notion-create-pages", { pages: [{ properties: { title: "Structural plan" } }] }],
    ["notion_notion-update-page", { content_updates: [{ new_str: "Compound update" }] }],
    ["notion_notion-create-comment", { markdown: "Substrate comment" }],
    ["linear_create_issue", { description: "Structural issue" }],
    ["linear_create_comment", { body: "Substrate comment" }],
  ])("rejects %s content", async (tool, args) => {
    await expect(
      lintTool({ tool, sessionID: "session", callID: "call" }, { args }),
    ).rejects.toThrow("slop blocker:")
  })

  test("ignores read arguments and reactions", async () => {
    for (const [tool, args] of [
      ["slack_slack_add_reaction", { reaction: "structural" }],
      ["notion_notion-fetch", { id: "structural" }],
      ["linear_get_issue", { id: "structural" }],
    ] as const) {
      await lintTool({ tool, sessionID: "session", callID: "call" }, { args })
    }
  })

  test("uses configured words and em-dash setting", async () => {
    const custom = await plugin({} as never, {
      blockEmDash: false,
      blockedWords: ["obviously"],
    })

    await custom["experimental.text.complete"]!(
      { sessionID: "session", messageID: "message", partID: "part" },
      { text: "An em dash — and structural are allowed." },
    )

    await expect(
      custom["experimental.text.complete"]!(
        { sessionID: "session", messageID: "message", partID: "part" },
        { text: "This is obviously blocked." },
      ),
    ).rejects.toThrow('slop blocker: Rephrase the sentence(s) containing the word "obviously"')
  })

  test.each([
    [{ blockEmDash: "yes" }, "blockEmDash must be a boolean"],
    [{ blockedWords: [""] }, "blockedWords must be an array of non-empty strings"],
  ])("rejects invalid options", async (options, message) => {
    await expect(plugin({} as never, options)).rejects.toThrow(`slop blocker: ${message}`)
  })
})
