import { describe, expect, test } from "bun:test"
import plugin from "../src/index.ts"

const dash = String.fromCodePoint(0x2014)
const words = [
  ["struc", "tural"].join(""),
  ["com", "pound"].join(""),
  ["com", "pounds"].join(""),
  ["com", "pounding"].join(""),
  ["sub", "strate"].join(""),
]
const notice = "[Response blocked by slop blocker; retrying.]"
const retryLimitNotice = "[Slop blocker stopped the response after 3 automatic retries.]"
const overrideToken = "$SLOPBLOCK_OVERRIDE=TRUE"
const overrideWarning = "[Warning: Slop blocker override used; this response violates configured style rules.]"

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

  test.each([dash, ...words])("withholds %s", async (word) => {
    const output = { text: `Contains ${word}.` }
    await lintOutput(
      { sessionID: `session-${word}`, messageID: "message", partID: "part" },
      output,
    )
    expect(output.text).toBe(notice)
  })

  test("queues a corrective prompt after the session becomes idle", async () => {
    const prompts: unknown[] = []
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({
      directory: "/workspace",
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            prompts.push(input)
            return {}
          },
        },
      },
    } as never, { blockedWords: [blocked] })
    const output = { text: `This was ${blocked}.` }

    await retrying["experimental.text.complete"]!(
      { sessionID: "retry-session", messageID: "message", partID: "part" },
      output,
    )
    await retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "retry-session" } },
    })

    expect(output.text).toBe(notice)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toEqual({
      path: { id: "retry-session" },
      query: { directory: "/workspace" },
      body: {
        parts: [{
          type: "text",
          synthetic: true,
          text: expect.stringContaining(`word "${blocked}"`),
        }],
      },
      throwOnError: true,
    })
    const promptText = (prompts[0] as { body: { parts: [{ text: string }] } }).body.parts[0].text
    expect(promptText).toContain("YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING:")
    expect(promptText).toContain(`the em dash character (${dash})`)
    expect(promptText).toContain(`these words (case-insensitive): "${blocked}"`)
  })

  test("offers an intentional override in the corrective prompt when enabled", async () => {
    const prompts: unknown[] = []
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({
      directory: "/workspace",
      client: { session: { promptAsync: async (input: unknown) => { prompts.push(input) } } },
    } as never, { allowOverride: true, blockedWords: [blocked] })

    await retrying["experimental.text.complete"]!(
      { sessionID: "override-prompt", messageID: "message", partID: "part" },
      { text: blocked },
    )
    await retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "override-prompt" } },
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toEqual(expect.objectContaining({
      body: { parts: [expect.objectContaining({ text: expect.stringContaining(overrideToken) })] },
    }))
  })

  test("stops after three automatic retries by default", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, { blockedWords: [blocked] })
    const input = { sessionID: "limited", messageID: "message", partID: "part" }

    await retrying["experimental.text.complete"]!(input, { text: blocked })
    const second = { text: blocked }
    await retrying["experimental.text.complete"]!(input, second)
    const third = { text: blocked }
    await retrying["experimental.text.complete"]!(input, third)
    const fourth = { text: blocked }
    await retrying["experimental.text.complete"]!(input, fourth)

    expect(second.text).toBe(notice)
    expect(third.text).toBe(notice)
    expect(fourth.text).toBe(retryLimitNotice)
  })

  test("honors a configured retry budget", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, { blockedWords: [blocked], maxRetries: 1 })
    const input = { sessionID: "custom-budget", messageID: "message", partID: "part" }

    await retrying["experimental.text.complete"]!(input, { text: blocked })
    const second = { text: blocked }
    await retrying["experimental.text.complete"]!(input, second)

    expect(second.text).toBe("[Slop blocker stopped the response after 1 automatic retry.]")
  })

  test("passes the slop response through with a warning when onExhausted is slop", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, {
      blockedWords: [blocked],
      maxRetries: 1,
      onExhausted: "slop",
    })
    const input = { sessionID: "slop-exhausted", messageID: "message", partID: "part" }

    await retrying["experimental.text.complete"]!(input, { text: blocked })
    const second = { text: blocked }
    await retrying["experimental.text.complete"]!(input, second)

    expect(second.text).toBe(`${overrideWarning}\n\n${blocked}`)
  })

  test("recovers within the budget after repeated violations", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, { blockedWords: [blocked] })
    const input = { sessionID: "recover", messageID: "message", partID: "part" }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = { text: blocked }
      await retrying["experimental.text.complete"]!(input, output)
      expect(output.text).toBe(notice)
    }
    const recovered = { text: "Rewritten response." }
    await retrying["experimental.text.complete"]!(input, recovered)
    expect(recovered.text).toBe("Rewritten response.")
  })

  test("resets retry state after a clean rewrite", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, { blockedWords: [blocked] })
    const input = { sessionID: "clean-retry", messageID: "message", partID: "part" }

    await retrying["experimental.text.complete"]!(input, { text: blocked })
    const clean = { text: "Rewritten response." }
    await retrying["experimental.text.complete"]!(input, clean)
    const later = { text: blocked }
    await retrying["experimental.text.complete"]!(input, later)

    expect(clean.text).toBe("Rewritten response.")
    expect(later.text).toBe(notice)
  })
})

describe("system prompt", () => {
  test("announces em dash and words by default", async () => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as never, output)
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain(`the em dash character (${dash})`)
    expect(output.system[0]).toContain(`"${words[0]}"`)
    expect(output.system[0]).toContain("automatic style checker")
  })

  test("matches configured rules", async () => {
    const customWord = ["obvi", "ously"].join("")
    const custom = await plugin({} as never, { blockEmDash: false, blockedWords: [customWord] })
    const output = { system: [] as string[] }
    await custom["experimental.chat.system.transform"]!({} as never, output)
    expect(output.system[0]).toContain(`"${customWord}"`)
    expect(output.system[0]).not.toContain("em dash")
  })
})

describe("compaction", () => {
  test("skips linting while compacting and resumes after idle", async () => {
    const compacting = await plugin({} as never)
    const input = { sessionID: "compaction", messageID: "message", partID: "part" }

    await compacting["experimental.session.compacting"]!(
      { sessionID: "compaction" },
      { context: [] },
    )
    const summary = { text: `Summary ${dash} ${words[0]}.` }
    await compacting["experimental.text.complete"]!(input, summary)
    expect(summary.text).toBe(`Summary ${dash} ${words[0]}.`)

    await compacting.event!({
      event: { type: "session.idle", properties: { sessionID: "compaction" } },
    })
    const after = { text: words[0] }
    await compacting["experimental.text.complete"]!(input, after)
    expect(after.text).toBe(notice)
  })
})

describe("write linting", () => {
  test.each([
    ["write", { content: `A ${words[0]} problem` }],
    ["edit", { newString: `A ${words[1]} problem` }],
    ["apply_patch", { patchText: `+A ${words[4]} problem` }],
    ["slack_slack_post_message", { text: `A ${words[0]} update` }],
    ["slack_slack_reply_to_thread", { text: `A ${words[1]} reply` }],
    ["notion_notion-create-pages", { pages: [{ properties: { title: `${words[0]} plan` } }] }],
    ["notion_notion-update-page", { content_updates: [{ new_str: `${words[1]} update` }] }],
    ["notion_notion-create-comment", { markdown: `${words[4]} comment` }],
    ["linear_create_issue", { description: `${words[0]} issue` }],
    ["linear_create_comment", { body: `${words[4]} comment` }],
  ])("rejects %s content", async (tool, args) => {
    await expect(
      lintTool({ tool, sessionID: "session", callID: "call" }, { args }),
    ).rejects.toThrow("slop blocker:")
  })

  test("ignores read arguments and reactions", async () => {
    for (const [tool, args] of [
      ["slack_slack_add_reaction", { reaction: words[0] }],
      ["notion_notion-fetch", { id: words[0] }],
      ["linear_get_issue", { id: words[0] }],
    ] as const) {
      await lintTool({ tool, sessionID: "session", callID: "call" }, { args })
    }
  })

  test("write errors list every banned pattern", async () => {
    const blocked = ["flag", "ged"].join("")
    const listing = await plugin({} as never, { blockEmDash: false, blockedWords: [blocked] })
    let error: Error | undefined
    try {
      await listing["tool.execute.before"]!(
        { tool: "write", sessionID: "session", callID: "call" },
        { args: { content: blocked } },
      )
    } catch (reason) {
      error = reason as Error
    }

    expect(error?.message).toContain("slop blocker:")
    expect(error?.message).toContain("YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING:")
    expect(error?.message).toContain(`these words (case-insensitive): "${blocked}"`)
    expect(error?.message).not.toContain("em dash character")
  })
})

describe("override", () => {
  test("strips an enabled override from responses and writes", async () => {
    const warnings: unknown[] = []
    const overridden = await plugin({
      directory: "/workspace",
      client: { tui: { showToast: async (input: unknown) => { warnings.push(input) } } },
    } as never, { allowOverride: true })
    const response = { text: `${overrideToken}\nA ${words[0]} response` }
    const write = { content: `${overrideToken}\r\nA ${words[0]} write` }

    await overridden["experimental.text.complete"]!(
      { sessionID: "response-override", messageID: "message", partID: "part" },
      response,
    )
    await overridden["tool.execute.before"]!(
      { tool: "write", sessionID: "session", callID: "call" },
      { args: write },
    )

    expect(response.text).toBe(`${overrideWarning}\n\nA ${words[0]} response`)
    expect(write.content).toBe(`A ${words[0]} write`)
    expect(warnings).toEqual([{
      body: {
        title: "Slop blocker override",
        message: "Allowed content that violates configured style rules.",
        variant: "warning",
      },
      query: { directory: "/workspace" },
    }])
  })

  test("does not warn when an override response has no violation", async () => {
    const overridden = await plugin({} as never, { allowOverride: true })
    const response = { text: `${overrideToken}\nClean response.` }

    await overridden["experimental.text.complete"]!(
      { sessionID: "clean-override", messageID: "message", partID: "part" },
      response,
    )

    expect(response.text).toBe("Clean response.")
  })

  test("offers the override to the user after rejected retries", async () => {
    const overridden = await plugin({} as never, { allowOverride: true })
    const input = { sessionID: "rejected-retry", messageID: "message", partID: "part" }

    await overridden["experimental.text.complete"]!(input, { text: words[0] })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await overridden["experimental.text.complete"]!(input, { text: words[0] })
    }
    const final = { text: words[0] }
    await overridden["experimental.text.complete"]!(input, final)

    expect(final.text).toContain(overrideToken)
    expect(final.text).toContain("stopped")
  })

  test("advertises an enabled override in write errors", async () => {
    const overridden = await plugin({} as never, { allowOverride: true })

    await expect(overridden["tool.execute.before"]!(
      { tool: "write", sessionID: "session", callID: "call" },
      { args: { content: words[0] } },
    )).rejects.toThrow(`prefix content with "$SLOPBLOCK_OVERRIDE=TRUE"`)
  })

  test("does not honor an override when disabled", async () => {
    const response = { text: `$SLOPBLOCK_OVERRIDE=TRUE\nA ${words[0]} response` }
    const write = { content: `$SLOPBLOCK_OVERRIDE=TRUE\nA ${words[0]} write` }

    await lintOutput(
      { sessionID: "disabled", messageID: "message", partID: "part" },
      response,
    )
    await expect(
      lintTool({ tool: "write", sessionID: "disabled", callID: "call" }, { args: write }),
    ).rejects.toThrow("slop blocker:")

    expect(response.text).toBe(notice)
  })
})

describe("configuration", () => {
  test("uses configured words and punctuation setting", async () => {
    const customWord = ["obvi", "ously"].join("")
    const custom = await plugin({} as never, {
      blockEmDash: false,
      blockedWords: [customWord],
    })

    await custom["experimental.text.complete"]!(
      { sessionID: "allowed", messageID: "message", partID: "part" },
      { text: `A dash ${dash} and ${words[0]} are allowed.` },
    )
    const output = { text: `This is ${customWord}.` }
    await custom["experimental.text.complete"]!(
      { sessionID: "blocked", messageID: "message", partID: "part" },
      output,
    )
    expect(output.text).toBe(notice)
  })

  test.each([
    [{ blockEmDash: "yes" }, "blockEmDash must be a boolean"],
    [{ blockedWords: [""] }, "blockedWords must be an array of non-empty strings"],
    [{ allowOverride: "yes" }, "allowOverride must be a boolean"],
    [{ maxRetries: -1 }, "maxRetries must be a non-negative integer"],
    [{ maxRetries: 1.5 }, "maxRetries must be a non-negative integer"],
    [{ onExhausted: "explode" }, 'onExhausted must be "stop" or "slop"'],
  ])("rejects invalid options", async (options, message) => {
    await expect(plugin({} as never, options)).rejects.toThrow(`slop blocker: ${message}`)
  })
})
