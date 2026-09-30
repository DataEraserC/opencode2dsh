import { ensureResponsesFreeLaneShape } from '../src/adapter/messages.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureFreeLaneShape, toPiContext, type HarnessGenerateOptions, type HarnessMessage, type PiMessage } from '../src/adapter/messages.ts'

function expectAssistant(message: PiMessage | undefined): Extract<PiMessage, { role: 'assistant' }> {
  assert.equal(message?.role, 'assistant')
  return message as Extract<PiMessage, { role: 'assistant' }>
}

function expectRole(message: PiMessage | undefined, role: PiMessage['role']): PiMessage {
  assert.equal(message?.role, role)
  return message as PiMessage
}

function options(overrides: Partial<HarnessGenerateOptions> = {}): HarnessGenerateOptions {
  return { provider: 'opencode2dsh', model: 'qwen-free', messages: [], ...overrides }
}

/** Run against an empty attachment store rooted at a temp DSH_HOME. */
async function withDshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'o2d-dsh-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** Write one normalized attachment object into an empty store. */
async function putObject(home: string, sha: string, bytes: Buffer): Promise<void> {
  const dir = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, sha), bytes)
}

test('system messages become leading user text', async () => {
  const context = await toPiContext(
    options({
      system: 'be helpful',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be helpful' }] }],
    }),
  )
  assert.equal(context.systemPrompt, 'be helpful')
  assert.equal(context.messages.length, 1)
  assert.deepEqual(context.messages[0], { role: 'user', content: 'be helpful', timestamp: 0 })
})

test('tool results become toolResult messages with the name from the prior toolCall', async () => {
  const messages: HarnessMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }], isError: false },
      ],
    },
  ]
  const context = await toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  const toolResult = expectRole(context.messages[2], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
  assert.equal(toolResult.toolCallId, 'call_1')
  assert.equal(toolResult.toolName, 'shell')
  assert.equal(toolResult.isError, false)
  assert.deepEqual(toolResult.content, [{ type: 'text', text: 'file.txt' }])
})

test('a user turn with text and tool results emits both messages', async () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] },
        { type: 'text', text: 'now summarize' },
      ],
    },
  ]
  const context = await toPiContext(options({ messages }))
  assert.equal(context.messages.length, 3)
  expectRole(context.messages[1], 'user')
  expectRole(context.messages[2], 'toolResult')
  expectRole(context.messages[0], 'assistant')
})

test('an empty user turn still emits an empty-string user message', async () => {
  const context = await toPiContext(options({ messages: [{ role: 'user', content: [] }] }))
  assert.deepEqual(context.messages[0], { role: 'user', content: '', timestamp: 0 })
})

test('assistant history replays text, thinking and tool calls with parsed arguments', async () => {
  const messages: HarnessMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'reasoning', text: 'internal scratch' },
        { type: 'tool-call', id: 't1', name: 'calc', arguments: '{"a":1}' },
      ],
      source: { kind: 'model', provider: 'opencode2dsh', model: 'qwen-free' },
    },
  ]
  const context = await toPiContext(options({ messages }))
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content, [
    { type: 'text', text: 'thinking out loud' },
    { type: 'thinking', thinking: 'internal scratch' },
    { type: 'toolCall', id: 't1', name: 'calc', arguments: { a: 1 } },
  ])
  assert.equal(assistant.stopReason, 'toolUse')
  assert.equal(assistant.model, 'qwen-free')
})

test('arguments parsing tolerates junk', async () => {
  const context = await toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'a', name: 'x', arguments: '' },
            { type: 'tool-call', id: 'b', name: 'x', arguments: 'not json' },
          ],
        },
      ],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content[0], { type: 'toolCall', id: 'a', name: 'x', arguments: {} })
  assert.deepEqual(assistant.content[1], { type: 'toolCall', id: 'b', name: 'x', arguments: { raw: 'not json' } })
  assert.equal(assistant.stopReason, 'toolUse')
})

test('assistant images are dropped rather than failing the stream', async () => {
  const context = await toPiContext(
    options({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'caption' }, { type: 'image' }] }],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'caption' }])
  assert.equal(assistant.stopReason, 'stop')
})

test('user images load from the attachment store as byte-exact image parts', async () => {
  const sha = 'ed20e4a1244ed9a30f2b68b9c670e615c39531d0d84c9b0ed07bd3ac96cae1ed'
  const bytes = Buffer.from('png fixture bytes for conversion')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } },
            ],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(Array.isArray(user.content), true, 'image content stays a parts array')
    const parts = user.content as Extract<PiMessage, { role: 'user' }>['content']
    assert.ok(Array.isArray(parts))
    assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' })
    assert.deepEqual(parts[1], { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
  })
})

test('a lone image message keeps content as a parts array', async () => {
  const sha = 'a'.repeat(64)
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } }] }],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(Array.isArray(user.content), true, 'a lone image must never collapse to a string')
    assert.deepEqual(user.content, [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }])
  })
})

test('offloaded image blocks stay out of the request even when the object exists', async () => {
  // The host flagged this occurrence as out-of-budget (offloaded: true);
  // the bytes ARE on disk, but re-reading them would defy the request budget
  // dsh-llm already enforced — the placeholder must win over the store.
  const sha = 'c'.repeat(64)
  const bytes = Buffer.from('bytes that exist but are offloaded')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' },
                offloaded: true,
              },
            ],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(typeof user.content, 'string')
    assert.match(user.content as string, /image omitted: offloaded to fit the request image budget/)
  })
})

test('tool results keep image blocks alongside text', async () => {
  const sha = 'b'.repeat(64)
  const bytes = Buffer.from('tool result image bytes')
  await withDshHome(async (home) => {
    await putObject(home, sha, bytes)
    const messages: HarnessMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            content: [
              { type: 'text', text: 'caption' },
              { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/webp' } },
            ],
            isError: false,
          },
        ],
      },
    ]
    const context = await toPiContext(options({ messages }))
    const toolResult = expectRole(context.messages[2], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
    assert.equal(toolResult.toolName, 'read')
    assert.deepEqual(toolResult.content, [
      { type: 'text', text: 'caption' },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/webp' },
    ])
  })
})

test('an empty tool result without images falls back to (no output)', async () => {
  const messages: HarnessMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'shell', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '' }] }] },
  ]
  const context = await toPiContext(options({ messages }))
  const toolResult = expectRole(context.messages[1], 'toolResult') as Extract<PiMessage, { role: 'toolResult' }>
  assert.deepEqual(toolResult.content, [{ type: 'text', text: '(no output)' }])
})

test('unreadable image references degrade to stable text instead of failing', async () => {
  const context = await toPiContext(
    options({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:not-a-real-sha', mediaType: 'image/png' } }],
        },
      ],
    }),
  )
  const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
  assert.equal(typeof user.content, 'string')
  assert.match(user.content as string, /image omitted: unreadable attachment reference/)
})

test('a missing attachment object degrades to a readable placeholder', async () => {
  const sha = 'f'.repeat(64)
  await withDshHome(async () => {
    const context = await toPiContext(
      options({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png' } }],
          },
        ],
      }),
    )
    const user = expectRole(context.messages[0], 'user') as Extract<PiMessage, { role: 'user' }>
    assert.equal(typeof user.content, 'string')
    assert.match(user.content as string, /image omitted: failed to read normalized attachment/)
  })
})

test('tools pass through and empty tool lists are omitted', async () => {
  const withTools = await toPiContext(options({ tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }] }))
  assert.deepEqual(withTools.tools, [{ name: 'shell', description: 'run', parameters: { type: 'object' } }])
  const withoutTools = await toPiContext(options())
  assert.equal(withoutTools.tools, undefined)
})

test('ensureFreeLaneShape injects gate tools into toolless chat bodies', () => {
  const payload = { model: 'm', stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  assert.notEqual(next, undefined)
  assert.deepEqual(next.messages, payload.messages, 'messages untouched')
  const tools = next.tools as Array<{ type: string; function: { name: string } }>
  assert.deepEqual(tools.map((t) => t.function.name).sort(), ['bash', 'read'])
  assert.equal(next.tool_choice, 'none', 'injected-only stubs are call-disabled')
})

test('ensureFreeLaneShape appends only missing gate tools and keeps tool_choice', () => {
  const payload = {
    model: 'm',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'webfetch', description: 'x', parameters: {} } }],
    tool_choice: 'auto',
  }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  const tools = next.tools as Array<{ type: string; function: { name: string } }>
  assert.equal(tools.length, 3, 'existing tool kept, both gate tools appended')
  assert.deepEqual(tools.map((t) => t.function.name).sort(), ['bash', 'read', 'webfetch'])
  assert.equal(next.tool_choice, 'auto', 'client choice preserved')
})

test('ensureFreeLaneShape leaves satisfying and non-chat payloads untouched', () => {
  const both = {
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'bash', description: 'x', parameters: {} } },
      { type: 'function', function: { name: 'read', description: 'x', parameters: {} } },
    ],
  }
  assert.equal(ensureFreeLaneShape(both), undefined)
  assert.equal(ensureFreeLaneShape({ tools: [] }), undefined, 'no messages = not a chat body')
  assert.equal(ensureFreeLaneShape(null), undefined)
  assert.equal(ensureFreeLaneShape('text'), undefined)
})
test('assistant history preserves the Responses API for muse-spark models', async () => {
  const context = await toPiContext(
    options({
      model: 'muse-spark-1.2-contributor-free',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous response' }],
          source: { kind: 'model', provider: 'opencode2dsh', model: 'muse-spark-1.2-contributor-free' },
        },
      ],
    }),
  )
  const assistant = expectAssistant(context.messages[0])
  assert.equal(assistant.api, 'openai-responses')
})


test('Responses free-lane bodies carry flat gate tools and supported tool choice', () => {
  const body = { input: [{ role: 'user', content: 'ping' }], tools: [{ type: 'function', name: 'bash', parameters: {} }], tool_choice: 'none' }
  const rewritten = ensureResponsesFreeLaneShape(body) as typeof body
  assert.equal(rewritten.input, body.input)
  assert.deepEqual(rewritten.tools.map((tool) => tool.name), ['bash', 'read'])
  assert.equal(rewritten.tool_choice, 'auto')
  assert.equal(ensureResponsesFreeLaneShape(rewritten), undefined)
  assert.equal(ensureResponsesFreeLaneShape({ messages: [] }), undefined)
})
