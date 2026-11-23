// OpenAI's Responses API on top of the plugin's Messages API. Every model
// goes through Messages: its builder keeps each block a prompt of its own,
// sends Claude's signed thinking back as Devin gave it, and another model's
// thinking back as its text.
import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"

export class RequestError extends Error {
  status = 400
}

const newID = (prefix) => prefix + "_" + randomBytes(12).toString("hex")

// Responses has no cache_control, and Devin caches only up to a prompt
// marked EPHEMERAL. The instructions and the newest input item are marked,
// as Claude Code marks its requests: each turn writes the cache at its end,
// and the next turn reads up to there.
const CACHE = { type: "ephemeral" }

// A reasoning item carries its thinking and Devin's signature, unchanged, in
// encrypted_content, so a client that sends back only that field (Codex with
// store: false) restores the exact thinking block the signature covers.
const SEALED = "devin-gw.v1:"
const seal = (thinking, signature) => SEALED + Buffer.from(JSON.stringify({ thinking, signature })).toString("base64")
function unseal(s) {
  if (typeof s !== "string" || !s.startsWith(SEALED)) return null
  try {
    const v = JSON.parse(Buffer.from(s.slice(SEALED.length), "base64").toString("utf8"))
    return typeof v?.thinking === "string" ? v : null
  } catch {
    return null
  }
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

// blocks are a Responses content's parts as Messages blocks. Devin takes
// images inline only, as the plugin does for Messages.
function blocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((p) => {
    if ((p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") && typeof p.text === "string") return [{ type: "text", text: p.text }]
    const m = p?.type === "input_image" && typeof p.image_url === "string" ? DATA_URL.exec(p.image_url) : null
    return m ? [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }] : []
  })
}

function argsOf(s) {
  if (s === undefined || s === "") return {}
  try {
    return JSON.parse(s)
  } catch {
    throw new RequestError("function_call arguments are not JSON")
  }
}

// toMessages is the Messages request for a Responses request, always
// streamed: the reply is read as events and given back whole when the client
// didn't ask for a stream. Consecutive items of one role become one turn in
// the plugin.
export function toMessages(r) {
  const system = []
  const messages = []
  if (typeof r.instructions === "string" && r.instructions) system.push({ type: "text", text: r.instructions })
  const items = typeof r.input === "string" ? [{ type: "message", role: "user", content: r.input }] : Array.isArray(r.input) ? r.input : []
  for (const it of items) {
    const type = it?.type ?? "message"
    if (type === "message") {
      const role = it.role === "developer" ? "system" : it.role
      const content = blocks(it.content)
      if (role === "system" && !messages.length) system.push(...content.filter((b) => b.type === "text"))
      else if ((role === "user" || role === "assistant" || role === "system") && content.length) messages.push({ role, content })
    } else if (type === "function_call") {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: it.call_id, name: it.name, input: argsOf(it.arguments) }] })
    } else if (type === "function_call_output") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: it.call_id, content: blocks(it.output) }] })
    } else if (type === "reasoning") {
      const own = unseal(it.encrypted_content)
      const parts = it.content?.length ? it.content : (it.summary ?? [])
      const thinking = own?.thinking ?? parts.map((p) => p?.text ?? "").join("")
      messages.push({ role: "assistant", content: [{ type: "thinking", thinking, ...(own?.signature ? { signature: own.signature } : {}) }] })
    }
  }
  const last = (a) => a[a.length - 1]
  if (last(system)) last(system).cache_control = CACHE
  const tail = last(messages)?.content
  if (tail?.length) last(tail).cache_control = CACHE

  const format = r.text?.format
  return {
    model: r.model,
    stream: true,
    max_tokens: r.max_output_tokens,
    temperature: r.temperature,
    top_p: r.top_p,
    system,
    messages,
    tools: (r.tools ?? []).filter((t) => t?.type === "function" && t.name).map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters })),
    ...(r.tool_choice === "none" ? { tool_choice: { type: "none" } } : {}),
    output_config: {
      ...(r.reasoning?.effort ? { effort: r.reasoning.effort } : {}),
      ...(format?.type === "json_schema" ? { format: { type: "json_schema", schema: format.schema } } : {}),
    },
  }
}

// messageEvents reads the plugin's Messages stream as its events.
async function* messageEvents(body) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let at
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const data = buf
        .slice(0, at)
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n")
      buf = buf.slice(at + 2)
      if (data) yield JSON.parse(data)
    }
  }
}

const usageOf = (u = {}) => {
  const read = u.cache_read_input_tokens ?? 0
  const input = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  const output = u.output_tokens ?? 0
  return { input_tokens: input, input_tokens_details: { cached_tokens: read }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output }
}

// responseEvents turns the Messages events into Responses events; the last
// one carries the whole response.
async function* responseEvents(events, r) {
  const response = {
    id: newID("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model: r.model,
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  }
  let seq = 0
  const ev = (type, data) => ({ type, sequence_number: seq++, ...data })
  const open = [] // by Messages block index: { item, output_index, signature }
  let stop = "end_turn"
  let usage = {}

  for await (const e of events) {
    if (e.type === "message_start") {
      yield ev("response.created", { response: { ...response } })
      yield ev("response.in_progress", { response: { ...response } })
    } else if (e.type === "content_block_start") {
      const cb = e.content_block
      const output_index = response.output.length
      let item
      if (cb.type === "text") item = { type: "message", id: newID("msg"), status: "in_progress", role: "assistant", content: [] }
      else if (cb.type === "thinking") item = { type: "reasoning", id: newID("rs"), summary: [] }
      else item = { type: "function_call", id: newID("fc"), status: "in_progress", call_id: cb.id, name: cb.name, arguments: "" }
      response.output.push(item)
      open[e.index] = { item, output_index, signature: "" }
      yield ev("response.output_item.added", { output_index, item: structuredClone(item) })
      if (cb.type === "text") {
        const part = { type: "output_text", text: "", annotations: [] }
        item.content.push(part)
        yield ev("response.content_part.added", { item_id: item.id, output_index, content_index: 0, part: { ...part } })
      } else if (cb.type === "thinking") {
        const part = { type: "summary_text", text: "" }
        item.summary.push(part)
        yield ev("response.reasoning_summary_part.added", { item_id: item.id, output_index, summary_index: 0, part: { ...part } })
      }
    } else if (e.type === "content_block_delta") {
      const b = open[e.index]
      const at = { item_id: b.item.id, output_index: b.output_index }
      const d = e.delta
      if (d.type === "text_delta") {
        b.item.content[0].text += d.text
        yield ev("response.output_text.delta", { ...at, content_index: 0, delta: d.text })
      } else if (d.type === "thinking_delta") {
        b.item.summary[0].text += d.thinking
        yield ev("response.reasoning_summary_text.delta", { ...at, summary_index: 0, delta: d.thinking })
      } else if (d.type === "signature_delta") b.signature += d.signature
      else if (d.type === "input_json_delta") {
        b.item.arguments += d.partial_json
        yield ev("response.function_call_arguments.delta", { ...at, delta: d.partial_json })
      }
    } else if (e.type === "content_block_stop") {
      const { item, output_index, signature } = open[e.index]
      const at = { item_id: item.id, output_index }
      if (item.type === "message") {
        const part = item.content[0]
        yield ev("response.output_text.done", { ...at, content_index: 0, text: part.text })
        yield ev("response.content_part.done", { ...at, content_index: 0, part: { ...part } })
        item.status = "completed"
      } else if (item.type === "reasoning") {
        const part = item.summary[0]
        yield ev("response.reasoning_summary_text.done", { ...at, summary_index: 0, text: part.text })
        yield ev("response.reasoning_summary_part.done", { ...at, summary_index: 0, part: { ...part } })
        item.encrypted_content = seal(part.text, signature)
      } else {
        item.arguments ||= "{}"
        yield ev("response.function_call_arguments.done", { ...at, arguments: item.arguments })
        item.status = "completed"
      }
      yield ev("response.output_item.done", { output_index, item: structuredClone(item) })
    } else if (e.type === "message_delta") {
      stop = e.delta?.stop_reason ?? stop
      usage = e.usage ?? usage
    } else if (e.type === "message_stop") {
      response.usage = usageOf(usage)
      if (stop === "max_tokens") {
        response.status = "incomplete"
        response.incomplete_details = { reason: "max_output_tokens" }
        yield ev("response.incomplete", { response })
      } else {
        response.status = "completed"
        yield ev("response.completed", { response })
      }
      return
    } else if (e.type === "error") {
      response.status = "failed"
      response.error = { code: "server_error", message: e.error?.message ?? "the reply broke off" }
      yield ev("response.failed", { response })
      return
    }
  }
  response.status = "failed"
  response.error = { code: "server_error", message: "the reply broke off" }
  yield ev("response.failed", { response })
}

// fromMessages answers a Responses request with the plugin's Messages
// reply: its failure with the same status, its events as Responses events,
// or, unstreamed, the response they end with.
export async function fromMessages(reply, r) {
  if (!reply.ok) {
    const j = await reply.json()
    return Response.json({ error: { message: j.error?.message ?? "", type: j.error?.type ?? "api_error", code: reply.status } }, { status: reply.status })
  }
  const events = responseEvents(messageEvents(reply.body), r)
  if (!r.stream) {
    let last
    for await (const e of events) last = e
    if (last.response.status === "failed") return Response.json({ error: { message: last.response.error.message, type: "api_error", code: 502 } }, { status: 502 })
    return Response.json(last.response)
  }
  const enc = new TextEncoder()
  async function* sse() {
    for await (const e of events) yield enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  }
  return new Response(ReadableStream.from(sse()), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}
