// The gateway against a stand-in Devin: what each API's request becomes on
// the wire (decoded from the GetChatMessage the plugin sends), and what the
// client gets back. Devin's replies are Connect frames built from the field
// numbers the plugin reads; its model list is the plugin's captured fixture.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { createDevin } from "../src/devin.mjs"
import { createGateway } from "../src/server.mjs"

const enc = new TextEncoder()
const dec = new TextDecoder()
const real = globalThis.fetch
const configs = readFileSync(new URL("../upstream/packages/devin/testdata/model-configs.bin", import.meta.url))
const SIG = "EqQBCkgIBRABGAIiQL2xYzRvY0RzZWNyZXRzaWduYXR1cmU="
const USER = 1
const ASSISTANT = 2

// ---- protobuf and Connect framing ----
const varint = (n) => {
  const out = []
  while (n > 127) {
    out.push((n & 127) | 128)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const str = (num, v) => {
  const b = typeof v === "string" ? enc.encode(v) : v
  return [...varint((num << 3) | 2), ...varint(b.length), ...b]
}
const int = (num, n) => [...varint(num << 3), ...varint(n)]
const pb = (...parts) => new Uint8Array(parts.flat())
const frame = (m, flags = 0) => {
  const out = new Uint8Array(5 + m.length)
  out[0] = flags
  new DataView(out.buffer).setUint32(1, m.length)
  out.set(m, 5)
  return out
}
const devinReply = (...msgs) => new Response(new Blob([...msgs.map((m) => frame(m)), frame(enc.encode("{}"), 2)]))

function fields(b) {
  const out = []
  let i = 0
  const read = () => {
    let n = 0
    let mul = 1
    for (;;) {
      const x = b[i++]
      n += (x & 127) * mul
      if (x < 128) return n
      mul *= 128
    }
  }
  while (i < b.length) {
    const key = read()
    const f = { num: Math.floor(key / 8), wire: key & 7 }
    if (f.wire === 0) f.n = read()
    else if (f.wire === 2) {
      const len = read()
      f.data = b.subarray(i, i + len)
      i += len
    } else if (f.wire === 1) i += 8
    else if (f.wire === 5) i += 4
    out.push(f)
  }
  return out
}

// prompts are the ChatMessagePrompts a GetChatMessage carries
const prompts = (data) =>
  fields(data)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const p = { role: 0, text: "", calls: [], callID: null, cache: false, thinking: null, signature: null }
      for (const g of fields(f.data)) {
        if (g.num === 2) p.role = g.n
        else if (g.num === 3) p.text = dec.decode(g.data)
        else if (g.num === 6) p.calls.push(dec.decode(fields(g.data).find((h) => h.num === 2).data))
        else if (g.num === 7) p.callID = dec.decode(g.data)
        else if (g.num === 8) p.cache = fields(g.data).some((h) => h.num === 1 && h.n === 1)
        else if (g.num === 11) p.thinking = dec.decode(g.data)
        else if (g.num === 12) p.signature = dec.decode(g.data)
      }
      return p
    })

// ---- Devin's replies ----
const usage = pb(int(2, 10), int(3, 5), int(5, 100))
const thoughtThenText = () => devinReply(pb(str(9, "Let me think.")), pb(str(10, SIG.slice(0, 20))), pb(str(10, SIG.slice(20)), str(21, "anthropic")), pb(str(3, "Hello.")), pb(int(5, 1), str(7, usage)))
const toolCall = () => devinReply(pb(str(6, pb(str(1, "toolu_2"), str(2, "get_weather"), str(3, '{"city":"Rome"}')))), pb(int(5, 10), str(7, usage)))
const refused = () => new Response(new Blob([frame(enc.encode(JSON.stringify({ code: "permission_denied", message: "This request violates our content policy." })), 2)]))

// ---- the stand-in Devin and the gateway ----
let sent // each GetChatMessage: its headers, whether it went gzipped, its message
let answer
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith("https://server.codeium.com/")) return real(input, init)
  if (url.endsWith("/GetCliModelConfigs")) return new Response(configs)
  const raw = new Uint8Array(init.body)
  const gz = (raw[0] & 1) === 1
  const data = gz ? new Uint8Array(gunzipSync(raw.subarray(5))) : raw.subarray(5)
  sent.push({ headers: init.headers, gz, data })
  return answer()
}

let server
let base
beforeAll(async () => {
  server = createGateway({ apiKey: "gw-key", devin: await createDevin("devin-key") }).listen(0, "127.0.0.1")
  await once(server, "listening")
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())
beforeEach(() => {
  sent = []
  answer = thoughtThenText
})

const post = (path, body, headers = { authorization: "Bearer gw-key" }) =>
  real(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })

async function sseEvents(res) {
  const out = []
  for (const block of (await res.text()).split("\n\n")) {
    const data = block.split("\n").find((l) => l.startsWith("data: "))?.slice(6)
    if (data && data !== "[DONE]") out.push(JSON.parse(data))
  }
  return out
}

// ---- tests ----
test("health needs no key; the APIs need the gateway's key, as Bearer or x-api-key", async () => {
  const h = await real(base + "/health")
  expect(h.status).toBe(200)
  expect(await h.json()).toMatchObject({ status: "ok", devinKey: true })
  expect((await post("/v1/chat/completions", {}, {})).status).toBe(401)
  expect((await post("/v1/messages", {}, { "x-api-key": "wrong" })).status).toBe(401)
  const ok = await post("/v1/messages", { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, { "x-api-key": "gw-key" })
  expect(ok.status).toBe(200)
})

test("models are the account's list, from Devin's model configs", async () => {
  const res = await real(base + "/v1/models", { headers: { authorization: "Bearer gw-key" } })
  const { data } = await res.json()
  expect(data.length).toBeGreaterThan(0)
  expect(data.every((m) => m.object === "model" && typeof m.id === "string")).toBe(true)
})

test("Messages: every block a prompt of its own, cache_control as EPHEMERAL, system and tools in the first user prompt, signed thinking sent back unchanged", async () => {
  const res = await post("/v1/messages", {
    model: "claude-opus-5-5",
    max_tokens: 1024,
    stream: true,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "get_weather", description: "Weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Let me think.", signature: SIG }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny", cache_control: { type: "ephemeral" } }] },
    ],
  })
  expect(res.status).toBe(200)
  const ps = prompts(sent[0].data)
  expect(ps[0].role).toBe(USER)
  expect(ps[0].text).toContain("<tool_descriptions>")
  expect(ps[0].text).toContain("Weather for a city")
  expect(ps.slice(1, 4).map((p) => [p.role, p.text, p.cache])).toEqual([
    [USER, "You are terse.", true],
    [USER, "first", false],
    [USER, "second", true],
  ])
  expect(ps[4]).toMatchObject({ role: ASSISTANT, thinking: "Let me think.", signature: SIG, calls: ["get_weather"] })
  expect(ps[5]).toMatchObject({ text: "sunny", cache: true })
  expect(ps[5].callID).not.toBeNull()

  const events = await sseEvents(res)
  const sig = events.filter((e) => e.delta?.type === "signature_delta").map((e) => e.delta.signature).join("")
  expect(sig).toBe(SIG)
  expect(events.find((e) => e.type === "message_delta").usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 })
})

test("a request past 8 KiB goes to Devin gzipped", async () => {
  await post("/v1/messages", { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "x".repeat(20 << 10) }] })
  expect(sent[0].gz).toBe(true)
  expect(sent[0].headers["Connect-Content-Encoding"]).toBe("gzip")
})

test("Chat completions: system prompt and tool descriptions in the first user message, reply streamed back", async () => {
  answer = () => devinReply(pb(str(3, "Hello.")), pb(int(5, 1), str(7, usage)))
  const res = await post("/v1/chat/completions", {
    model: "swe-2",
    stream: true,
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: {} } } }],
  })
  const ps = prompts(sent[0].data)
  expect(ps).toHaveLength(1)
  expect(ps[0].text).toStartWith("You are terse.")
  expect(ps[0].text).toContain("<tool_descriptions>")
  expect(ps[0].text).toEndWith("hi")
  const chunks = await sseEvents(res)
  expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("Hello.")
})

test("an assistant prefill is a 400 on every API, and Devin isn't asked", async () => {
  const end = { role: "assistant", content: "Sure, " }
  const chat = await post("/v1/chat/completions", { model: "swe-2", messages: [{ role: "user", content: "hi" }, end] })
  const msgs = await post("/v1/messages", { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }, end] })
  const resp = await post("/v1/responses", { model: "claude-opus-5-5", input: [{ role: "user", content: "hi" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure, " }] }] })
  expect([chat.status, msgs.status, resp.status]).toEqual([400, 400, 400])
  expect((await msgs.json()).error.type).toBe("invalid_request_error")
  expect(sent).toHaveLength(0)
})

test("a body past 10 MiB reaches Devin gzipped", async () => {
  const content = "x".repeat(10 << 20)
  const res = await post("/v1/messages", { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content }] })
  expect(res.status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0].gz).toBe(true)
  expect(prompts(sent[0].data)[0].text.length).toBe(content.length)
})

test("Devin's content policy refusal comes back as a 400 with its words", async () => {
  answer = refused
  const chat = await post("/v1/chat/completions", { model: "swe-2", messages: [{ role: "user", content: "hi" }] })
  expect(chat.status).toBe(400)
  expect((await chat.json()).error.message).toBe("This request violates our content policy.")
  const resp = await post("/v1/responses", { model: "claude-opus-5-5", input: "hi" })
  expect(resp.status).toBe(400)
  expect((await resp.json()).error.message).toBe("This request violates our content policy.")
  expect(sent).toHaveLength(2)
})

test("Responses: streamed events, the reasoning item keeps Devin's signature, and sent back it is replayed byte for byte", async () => {
  const res = await post("/v1/responses", { model: "claude-opus-5-5", stream: true, instructions: "Be brief.", reasoning: { effort: "high" }, input: "hi" })
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const events = await sseEvents(res)
  expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i))
  expect(events[0].type).toBe("response.created")
  expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")).toBe("Hello.")
  const done = events[events.length - 1]
  expect(done.type).toBe("response.completed")
  const [reasoning, message] = done.response.output
  expect(reasoning).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "Let me think." }] })
  expect(message).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello." }] })
  expect(done.response.usage).toMatchObject({ input_tokens: 110, input_tokens_details: { cached_tokens: 100 }, output_tokens: 5, total_tokens: 115 })

  // instructions and the newest input are marked for the cache
  const first = prompts(sent[0].data)
  expect(first.map((p) => [p.text, p.cache])).toEqual([
    ["Be brief.", true],
    ["hi", true],
  ])

  // the next turn, as Codex sends it: the reasoning item by its encrypted_content alone
  answer = toolCall
  const next = await post("/v1/responses", {
    model: "claude-opus-5-5",
    input: [
      { role: "user", content: "hi" },
      { type: "reasoning", id: reasoning.id, summary: [], encrypted_content: reasoning.encrypted_content },
      { type: "function_call", call_id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "sunny" },
    ],
    tools: [{ type: "function", name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } }],
  })
  const ps = prompts(sent[1].data)
  const asked = ps.find((p) => p.role === ASSISTANT)
  expect(asked).toMatchObject({ thinking: "Let me think.", signature: SIG, calls: ["get_weather"] })
  expect(ps[ps.length - 1]).toMatchObject({ text: "sunny", cache: true })

  const body = await next.json()
  expect(body.status).toBe("completed")
  expect(body.output).toEqual([expect.objectContaining({ type: "function_call", name: "get_weather", call_id: expect.any(String), arguments: '{"city":"Rome"}', status: "completed" })])
})

test("Responses: a reasoning item from elsewhere goes back without a signature, so Claude's is left out", async () => {
  await post("/v1/responses", {
    model: "claude-opus-5-5",
    input: [
      { role: "user", content: "hi" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "gAAAAB-not-ours" },
      { role: "assistant", content: [{ type: "output_text", text: "Hello." }] },
      { role: "user", content: "again" },
    ],
  })
  const ps = prompts(sent[0].data)
  expect(ps.every((p) => p.signature === null && p.thinking === null)).toBe(true)
})
