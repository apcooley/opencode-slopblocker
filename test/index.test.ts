import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createSlopBlocker, type Rule } from "../src/index.ts"

// Hermetic: a RADAR worker session exports RADAR_SLOP_COACH_FILE, which flips
// the plugin into worker mode and would break these interactive-mode tests.
delete process.env.RADAR_SLOP_COACH_FILE

const dash = String.fromCodePoint(0x2014)
const words = [
  ["struc", "tural"].join(""),
  ["com", "pound"].join(""),
  ["com", "pounds"].join(""),
  ["com", "pounding"].join(""),
  ["sub", "strate"].join(""),
]
const notice = "[Response blocked by slop blocker; retrying. I'm bozo the clown.]"
const retryLimitNotice = "[Slop blocker stopped the response after 5 automatic retries.]"
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

  test("re-arms the coach prompt when delivery fails, then delivers on the next idle", async () => {
    const prompts: unknown[] = []
    const blocked = ["flag", "ged"].join("")
    let failing = true
    const retrying = await plugin({
      directory: "/workspace",
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            if (failing) {
              failing = false
              throw new Error("session is busy")
            }
            prompts.push(input)
            return {}
          },
        },
      },
    } as never, { blockedWords: [blocked] })

    const output = { text: `This was ${blocked}.` }
    await retrying["experimental.text.complete"]!(
      { sessionID: "rearm", messageID: "message", partID: "part" },
      output,
    )
    await retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "rearm" } },
    })
    expect(prompts).toHaveLength(0)

    await retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "rearm" } },
    })
    expect(prompts).toHaveLength(1)
    const promptText = (prompts[0] as { body: { parts: [{ text: string }] } }).body.parts[0].text
    expect(promptText).toContain(`word "${blocked}"`)
  })

  test("delivers the queued coach once when idle repeats while a post is in flight", async () => {
    const prompts: unknown[] = []
    const blocked = ["flag", "ged"].join("")
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const retrying = await plugin({
      directory: "/workspace",
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            prompts.push(input)
            await gate
            return {}
          },
        },
      },
    } as never, { blockedWords: [blocked] })

    const output = { text: `This was ${blocked}.` }
    await retrying["experimental.text.complete"]!(
      { sessionID: "inflight", messageID: "message", partID: "part" },
      output,
    )
    const first = retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "inflight" } },
    })
    await retrying.event!({
      event: { type: "session.idle", properties: { sessionID: "inflight" } },
    })
    release()
    await first
    expect(prompts).toHaveLength(1)
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

  test("stops after five automatic retries by default", async () => {
    const blocked = ["flag", "ged"].join("")
    const retrying = await plugin({} as never, { blockedWords: [blocked] })
    const input = { sessionID: "limited", messageID: "message", partID: "part" }

    const retries: Array<{ text: string }> = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const output = { text: blocked }
      await retrying["experimental.text.complete"]!(input, output)
      retries.push(output)
    }
    const final = { text: blocked }
    await retrying["experimental.text.complete"]!(input, final)

    for (const output of retries) expect(output.text).toBe(notice)
    expect(final.text).toBe(retryLimitNotice)
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

describe("interactive host", () => {
  // A bun Worker cannot emulate the TUI host here: bun 1.3.14 workers inherit
  // the parent environment and ignore both in-worker env writes and the Worker
  // env option, so RADAR_SLOP_COACH_FILE would leak in. The isMainThread gate
  // itself is verified by probe (worker: false, main: true).
  const rule: Rule = {
    pattern: /xblockedwordx/iu,
    message: "Rephrase the sentence(s) containing the word \"xblockedwordx\" to sound more human",
  }
  const hooks = async (blankInteractive: boolean) =>
    await createSlopBlocker([rule], "", false, 5, "stop", undefined, blankInteractive)({} as never)
  const input = { sessionID: "tui", messageID: "message", partID: "part" }

  test("blanks a blocked response pre-render when interactive", async () => {
    const output = { text: "xblockedwordx" }
    await (await hooks(true))["experimental.text.complete"]!(input, output)
    expect(output.text).toBe("")
  })

  test("keeps the retry marker when not interactive", async () => {
    const output = { text: "xblockedwordx" }
    await (await hooks(false))["experimental.text.complete"]!(input, output)
    expect(output.text).toBe(notice)
  })

  test("still queues the coach prompt on idle when blanking", async () => {
    const prompts: unknown[] = []
    const blanking = await createSlopBlocker([rule], "", false, 5, "stop", undefined, true)({
      directory: "/workspace",
      client: {
        session: {
          promptAsync: async (prompt: unknown) => {
            prompts.push(prompt)
            return {}
          },
        },
      },
    } as never)
    const output = { text: "xblockedwordx" }
    await blanking["experimental.text.complete"]!(input, output)
    await blanking.event!({
      event: { type: "session.idle", properties: { sessionID: "tui" } },
    })
    expect(output.text).toBe("")
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as { body: { parts: [{ text: string }] } }
    expect(prompt.body.parts[0].text).toContain("style checker")
  })

  test("blanks within the cap, then surfaces the final failure", async () => {
    const blanking = await hooks(true)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const output = { text: "xblockedwordx" }
      await blanking["experimental.text.complete"]!(input, output)
      expect(output.text).toBe("")
    }
    const exhausted = { text: "xblockedwordx" }
    await blanking["experimental.text.complete"]!(input, exhausted)
    expect(exhausted.text).toContain("stopped")
    expect(exhausted.text).toContain("5 automatic retries")
  })
})

describe("worker mode", () => {
  test("keeps the retry marker and writes a coach record when a coach file is set", async () => {
    const coachFile = join(mkdtempSync(join(tmpdir(), "slopblocker-")), "coach.json")
    process.env.RADAR_SLOP_COACH_FILE = coachFile
    const prompts: unknown[] = []
    try {
      const worker = await plugin({
        directory: "/workspace",
        client: { session: { promptAsync: async (input: unknown) => { prompts.push(input) } } },
      } as never, { blockedWords: ["xblockedwordx"] })

      const output = { text: "xblockedwordx" }
      await worker["experimental.text.complete"]!(
        { sessionID: "coached", messageID: "message", partID: "part" },
        output,
      )

      expect(output.text).toBe(notice)
      expect(prompts).toHaveLength(0)
      const record = JSON.parse(readFileSync(coachFile, "utf8")) as Record<string, unknown>
      expect(record.sessionID).toBe("coached")
      expect(record.attempt).toBe(1)
      expect(typeof record.message).toBe("string")
    } finally {
      delete process.env.RADAR_SLOP_COACH_FILE
    }
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
